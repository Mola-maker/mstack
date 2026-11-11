/**
 * cmd-ultramode gates (unit 3: review gate + ship gate + grant model).
 *
 * Data shapes first (design §5-6):
 *
 * - Grant: `{ slug, workspace, grantedBy, at, scope }`, recorded in the
 *   mode's ctx.state under `grant:<slug>:<workspace-hash>`. Per goal AND
 *   per workspace: a grant for one workspace never authorizes another.
 * - Review request (waterfall value of `mola.ultramode.review`):
 *   `{ slug, cwd, reviewPath?, writer? }`. `writer` is the agent from the
 *   goal's last outcome; when unknown the reviewer-independence check is
 *   skipped (sameness cannot be proven).
 * - Ship request (waterfall value of `mola.ultramode.ship`):
 *   `{ slug, cwd, argv, tool? }`. `argv` is the exact outward argv.
 *
 * Review-file schema (minimal, from the m-review skill format):
 * - a `Reviewer: <name>` line names the reviewer;
 * - the last non-empty line is the verdict, `APPROVE` or `REQUEST CHANGES`;
 * - evidence is a `repro: <command> → <output>` line, a backticked test
 *   command, or a `.mstack/` file path.
 *
 * The yes-derivation mechanism: the ship gate sets `yes: true` on the
 * `mola.tool.before` value ONLY when its own recorded grant exists. It
 * never reads io.yes (the global --yes flag). The classifier therefore
 * denies every outward call unless the mode's grant supplied the yes. On
 * success the mode emits `mola.approval.granted` with approver
 * `ultramode-grant:<traceId>` so the bus record names the grant, not
 * "--yes".
 *
 * Neither gate ever retries: one denial is a stop. The handler records
 * the outcome and writes the closeout line, then returns 77.
 */

import * as path from "node:path";
import { createHash } from "node:crypto";
import type { PluginContext } from "@mola/plugin-sdk";
import { MolaEvents, PolicyDenial } from "@mola/plugin-sdk";

/** The sample outward argv `ship --check` probes the ship gate with. */
export const SAMPLE_SHIP_ARGV = ["gh", "pr", "create", "--title", "ultramode ship check"];

/** Scope of an ultramode grant: shipping (outward actions) only. */
export const GRANT_SCOPE = "ship";

export interface UltramodeGrant {
  slug: string;
  /** the workspace (cwd) the grant was recorded for */
  workspace: string;
  /** traceId of the invocation that granted it — the real authority */
  grantedBy: string;
  at: string;
  scope: string;
}

export function workspaceHash(workspace: string): string {
  return createHash("sha256").update(workspace, "utf8").digest("hex").slice(0, 8);
}

/**
 * The grant key is scoped to the workspace (short hash of the cwd), so a
 * grant in workspace B never overwrites or revokes A's record. The stored
 * grant still carries the full workspace path, checked again as defense
 * in depth.
 */
export function grantKey(slug: string, workspace: string): string {
  return `grant:${slug}:${workspaceHash(workspace)}`;
}

export function readGrant(ctx: PluginContext, slug: string, workspace: string): UltramodeGrant | undefined {
  const grant = ctx.state.get<UltramodeGrant>(grantKey(slug, workspace));
  if (!grant || typeof grant.workspace !== "string" || typeof grant.grantedBy !== "string") {
    return undefined;
  }
  return grant;
}

export interface UltramodeReviewRequest {
  slug: string;
  cwd: string;
  /** overrides the default review path (tests); default `.mstack/reviews/<slug>.md` */
  reviewPath?: string;
  /** agent from the goal's last outcome; unknown ⇒ independence check skipped */
  writer?: string;
}

export interface UltramodeShipRequest {
  slug: string;
  cwd: string;
  /** the exact outward argv, e.g. ["gh", "pr", "create", ...] */
  argv: string[];
  tool?: string;
  /**
   * A probe (ship --check) exercises the ToolBefore waterfall but ships
   * nothing, so it must not emit an approval record for an action that
   * never happened.
   */
  probe?: boolean;
}

export function reviewFilePath(cwd: string, slug: string): string {
  return path.join(cwd, ".mstack", "reviews", `${slug}.md`);
}

export type ReviewCheck =
  | { ok: true; reviewer: string }
  | { ok: false; reason: string };

/** What counts as cited evidence in a review file (shared with ship.ts). */
export const REVIEW_EVIDENCE_RES = [
  /\.mstack\/\S+/, // a file path under .mstack/
  /repro\s*:\s*\S+.*→/i, // a repro command with its result (m-review format)
  /`[^`]*\b(node|pnpm|npm|npx|bun|gh|git|cargo|make|pytest|vitest)\b[^`]*`/, // a backticked test command
];

/** Pure check of review-file text; the gate adds the file-exists check. */
export function checkReviewText(text: string, writer?: string): ReviewCheck {
  const lines = text.split("\n");
  const reviewerLine = lines.find((l) => /^reviewer\s*:/i.test(l));
  const reviewer = reviewerLine?.split(":").slice(1).join(":").trim() ?? "";
  if (!reviewer) {
    return { ok: false, reason: "review: no reviewer named (expected a 'Reviewer: <name>' line)" };
  }
  if (writer && reviewer.toLowerCase() === writer.trim().toLowerCase()) {
    return {
      ok: false,
      reason: `review: reviewer "${reviewer}" is the writer — the reviewer must differ from the writer`,
    };
  }
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const verdict = nonEmpty[nonEmpty.length - 1] ?? "";
  if (verdict !== "APPROVE") {
    return {
      ok: false,
      reason: `review: verdict is not APPROVE (last line: "${verdict || "(none)"}")`,
    };
  }
  if (!lines.some((l) => REVIEW_EVIDENCE_RES.some((re) => re.test(l)))) {
    return {
      ok: false,
      reason: "review: no evidence cited (need a repro command with its result, or a .mstack/ file path)",
    };
  }
  return { ok: true, reviewer };
}

/** The `.mstack/` paths a review cites (trailing punctuation and any `:line` suffix stripped). */
export function citedMstackPaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\.mstack\/[^\s"'\)\],;]+/g)) {
    found.add(m[0].replace(/[),.]+$/, "").replace(/:\d+$/, ""));
  }
  return [...found];
}

/** The review gate: inspects the evidence file, never a prompt's claim. */
export function reviewGate(ctx: PluginContext) {
  return (value: unknown): unknown => {
    const req = (value ?? {}) as UltramodeReviewRequest;
    const file = req.reviewPath ?? reviewFilePath(req.cwd, req.slug);
    let text: string;
    try {
      text = ctx.fs.readFile(file);
    } catch {
      throw new PolicyDenial(`review: no review file at ${file}`);
    }
    const checked = checkReviewText(text, req.writer);
    if (!checked.ok) throw new PolicyDenial(checked.reason);
    // A bare `.mstack/` mention is not evidence: when it is the only
    // evidence form, every cited path must exist on disk. The canonical
    // run evidence is `.mstack/runs/<runId>/decision.json` (design §5).
    const lines = text.split("\n");
    const hasOtherEvidence = lines.some((l) => REVIEW_EVIDENCE_RES.slice(1).some((re) => re.test(l)));
    if (!hasOtherEvidence) {
      for (const cited of citedMstackPaths(text)) {
        try {
          ctx.fs.readFile(path.join(req.cwd, cited));
        } catch {
          throw new PolicyDenial(`review: cited evidence path "${cited}" does not exist on disk`);
        }
      }
    }
    return value;
  };
}

/** The ship gate: grant check, then mola.tool.before with grant-derived yes. */
export function shipGate(ctx: PluginContext) {
  return async (value: unknown): Promise<unknown> => {
    const req = (value ?? {}) as UltramodeShipRequest;
    const grant = readGrant(ctx, req.slug, req.cwd);
    if (!grant) {
      throw new PolicyDenial(
        `ship: no ultramode grant for "${req.slug}" — run \`mola ultramode grant ${req.slug}\` first; without a grant the mode stops at a prepared PR`,
      );
    }
    if (grant.workspace !== req.cwd) {
      throw new PolicyDenial(
        `ship: grant for "${req.slug}" was recorded for workspace "${grant.workspace}", not "${req.cwd}" — a grant never authorizes another workspace`,
      );
    }
    // yes comes from THIS grant only. io.yes (the global --yes flag) is
    // never read here, so --yes without a grant still denies.
    // callId is distinct per argv (short hash of it): push and pr create
    // are separate outward actions and must not share one audit id.
    const callId = `ultramode-ship:${req.slug}:${createHash("sha256").update(JSON.stringify(req.argv), "utf8").digest("hex").slice(0, 12)}`;
    await ctx.events.runWaterfall(MolaEvents.ToolBefore, {
      tool: req.tool ?? req.argv[0] ?? "",
      argv: req.argv,
      callId,
      cwd: req.cwd,
      yes: true,
    });
    // A probe (ship --check) ships nothing: the waterfall above is the
    // probe, and no approval record is emitted for an action that never
    // happened.
    if (!req.probe) {
      ctx.events.emit(MolaEvents.ApprovalGranted, {
        action: "ship",
        rule: "ultramode-grant",
        approver: `ultramode-grant:${grant.grantedBy}`,
        slug: req.slug,
        argv: req.argv,
        callId,
      });
    }
    return value;
  };
}
