/**
 * cmd-ultramode gates (unit 3: review gate + ship gate + grant model).
 *
 * Data shapes first (design §5-6):
 *
 * - Grant: `{ slug, workspace, grantedBy, at, scope }`, recorded in the
 *   mode's ctx.state under `grant:<slug>`. Per goal AND per workspace: a
 *   grant for one workspace never authorizes another.
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

export function grantKey(slug: string): string {
  return `grant:${slug}`;
}

export function readGrant(ctx: PluginContext, slug: string): UltramodeGrant | undefined {
  const grant = ctx.state.get<UltramodeGrant>(grantKey(slug));
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
    return value;
  };
}

/** The ship gate: grant check, then mola.tool.before with grant-derived yes. */
export function shipGate(ctx: PluginContext) {
  return async (value: unknown): Promise<unknown> => {
    const req = (value ?? {}) as UltramodeShipRequest;
    const grant = readGrant(ctx, req.slug);
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
    await ctx.events.runWaterfall(MolaEvents.ToolBefore, {
      tool: req.tool ?? req.argv[0] ?? "",
      argv: req.argv,
      callId: `ultramode-ship:${req.slug}`,
      cwd: req.cwd,
      yes: true,
    });
    ctx.events.emit(MolaEvents.ApprovalGranted, {
      action: "ship",
      rule: "ultramode-grant",
      approver: `ultramode-grant:${grant.grantedBy}`,
      slug: req.slug,
      argv: req.argv,
    });
    return value;
  };
}
