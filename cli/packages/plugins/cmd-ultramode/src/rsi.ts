/**
 * cmd-ultramode RSI loop (unit 5: design §8-9).
 *
 * Data shapes first (design §8-9):
 *
 * - Round: search, then interrogate, then refine, then search again.
 *   Search runs 3 m-researcher passes in parallel, one channel each
 *   (web, docs, github), through the existing cmd-run `prepareRun` /
 *   `executeRun` — routing is never re-implemented here. Interrogation
 *   is the pstack interrogate / arena pattern: the channel passes argue
 *   (independent routes, possibly contradicting), a routed judge pass
 *   rules on the surviving claims, and every claim is checked against
 *   evidence — a claim without a cited file, line, or test output is
 *   dropped from the findings, never kept as fact. Refinement writes the
 *   round's new findings into the goal file and records a checkpoint row.
 * - Claim: `{ text, source, channels }`. `source` is the citation the
 *   agent gave; a claim survives only when it cites a URL, a file path
 *   (optionally with a line), or a test-output marker. A claim cited by
 *   2+ channels is confirmed; a cited claim from one channel survives
 *   flagged single-source.
 * - Stop predicate, whichever hits first: saturation (a round adds no
 *   new finding), the round cap (default 3, `--rounds`), a budget cap,
 *   or a denied/failed round. The budget cap cannot be measured: the
 *   router reports no token usage (executeRun returns finalText and an
 *   exit code only), so `tokensUsed` stays 0 and a configured budget
 *   cap can never fire — it is recorded, never invented.
 * - Grill: round 1 asks at most 3 questions with recommended defaults
 *   about the goal statement itself, records them in the goal file as
 *   attackable premises, assumes the defaults, and never blocks: a
 *   human amends the goal file between rounds if they disagree.
 * - Evidence: `.mstack/research/<slug>/round-<n>.md` per round (claims,
 *   sources, dropped claims, judge verdict, stop). Counters live in
 *   `.mstack/goals/<slug>.state.json` under `rsi`. Every exit path
 *   (saturated, round-cap, denied gate, failed round) writes the
 *   closeout. No retry loops: one failed round stops the loop.
 */

import * as path from "node:path";
import type { Io, PluginContext } from "@mola/plugin-sdk";
import { ExitCode } from "@mola/plugin-sdk";
import {
  executeRun,
  inferKind,
  policyKindOf,
  prepareRun,
  readRunFlags,
  type Policy,
  type RoutingTable,
} from "@mola/plugin-cmd-run";

/** The router's run flags (agent/route/kind/on); cmd-run does not export the type. */
export type RunFlags = ReturnType<typeof readRunFlags>;

/** Default round cap: 3 (design §9). */
export const RSI_DEFAULT_ROUND_CAP = 3;
/** Independent research channels, one m-researcher pass each, in parallel. */
export const RSI_CHANNELS = ["web", "docs", "github"] as const;
/** The grill asks at most 3 questions (design §8). */
export const RSI_MAX_GRILL_QUESTIONS = 3;

export type RsiStopReason = "saturated" | "round-cap" | "failed" | "denied";

export interface RsiClaim {
  text: string;
  /** the citation the agent gave; empty means uncited */
  source: string;
  /** channels that cited this claim (deduped, cross-validation count) */
  channels: string[];
  /** true when 2+ channels cited it */
  confirmed: boolean;
}

export interface RsiDroppedClaim {
  text: string;
  reason: string;
}

export interface RsiRound {
  n: number;
  claims: RsiClaim[];
  dropped: RsiDroppedClaim[];
  newFindings: number;
  judgeDropped: RsiDroppedClaim[];
  judgeSkipped: boolean;
  stopReason: RsiStopReason | "continue";
}

export interface RsiCounters {
  rounds: number;
  findings: number;
  dropped: number;
  newFindingsByRound: number[];
  stopReason: RsiStopReason;
  /** configured cap, if any; the cap can never fire (see the header) */
  budgetTokens: number | null;
  /** always 0: the router reports no token usage */
  tokensUsed: number;
  channels: string[];
  roundCap: number;
}

/** A citation: a URL, a file path (with or without a line), or test output. */
export const RSI_CITATION_RE =
  /https?:\/\/\S+|\.mstack\/\S+|\b[\w./-]+\.(md|ts|js|mjs|rs|py|go|json|yaml|yml)\b(?::\d+)?|→/;

function normalizeClaim(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
}

/**
 * Parse m-researcher findings lines (`- claim — source — date — primary`)
 * into claims. A line with no ` — ` separator is a claim with no source.
 */
export function parseClaims(text: string, channel: string): RsiClaim[] {
  const out: RsiClaim[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2).trim();
    if (!body || /^drop:/i.test(body)) continue;
    const parts = body.split(" — ");
    const claimText = parts[0].trim();
    if (!claimText) continue;
    const source = parts.slice(1).join(" — ").trim();
    out.push({ text: claimText, source, channels: [channel], confirmed: false });
  }
  return out;
}

/**
 * Interrogate one round's claims: drop anything without a cited file,
 * line, or test output; dedupe across channels (the cross-validation);
 * count what is new against the claims seen in earlier rounds.
 */
export function interrogateClaims(
  claims: RsiClaim[],
  seen: Set<string>,
): { surviving: RsiClaim[]; dropped: RsiDroppedClaim[]; newFindings: number } {
  const byText = new Map<string, RsiClaim>();
  const dropped: RsiDroppedClaim[] = [];
  const droppedKeys = new Set<string>();
  for (const claim of claims) {
    const key = normalizeClaim(claim.text);
    if (!RSI_CITATION_RE.test(claim.source)) {
      if (!byText.has(key) && !droppedKeys.has(key)) {
        droppedKeys.add(key);
        dropped.push({ text: claim.text, reason: "no cited file, line, or test output" });
      }
      continue;
    }
    const existing = byText.get(key);
    if (existing) {
      for (const ch of claim.channels) {
        if (!existing.channels.includes(ch)) existing.channels.push(ch);
      }
      if (!existing.source && claim.source) existing.source = claim.source;
    } else {
      byText.set(key, { ...claim, channels: [...claim.channels] });
    }
  }
  const surviving = [...byText.values()].map((c) => ({
    ...c,
    confirmed: c.channels.length >= 2,
  }));
  let newFindings = 0;
  for (const claim of surviving) {
    if (!seen.has(normalizeClaim(claim.text))) newFindings++;
  }
  return { surviving, dropped, newFindings };
}

/** Parse the judge's verdict lines (`- DROP: <claim text>`). */
export function parseJudgeVerdicts(text: string): RsiDroppedClaim[] {
  const out: RsiDroppedClaim[] = [];
  for (const raw of text.split("\n")) {
    const match = /^-\s*DROP:\s*(.+)$/i.exec(raw.trim());
    if (match) out.push({ text: match[1].trim(), reason: "dropped by the judge pass" });
  }
  return out;
}

/** The grill: at most 3 premise-attacking questions with recommended defaults. */
export interface GrillQuestion {
  question: string;
  default: string;
}

export function grillQuestions(goal: string): GrillQuestion[] {
  return [
    {
      question: `What is the scope boundary of "${goal}" — what is the smallest change that satisfies it?`,
      default: "the smallest change that satisfies the goal as written",
    },
    {
      question: `What counts as done for "${goal}"?`,
      default: "a routed pass exits 0 with its evidence on disk",
    },
    {
      question: `What is explicitly out of scope for "${goal}"?`,
      default: "no outward action without a recorded grant; no merge",
    },
  ].slice(0, RSI_MAX_GRILL_QUESTIONS);
}

export function researchPrompt(goal: string, channel: string, round: number): string {
  return [
    `m-researcher, channel ${channel}, RSI round ${round} — research this goal: "${goal}".`,
    "Stay in your named channel; do not switch channels.",
    "Return findings as one line per claim, in this exact shape:",
    "- <claim> — <source URL or file path with line> — <date if it matters>",
    "Every claim needs its source on the same line. A claim you cannot source, label with an empty source — do not invent one.",
  ].join("\n");
}

export function judgePrompt(goal: string, claims: RsiClaim[]): string {
  const lines = claims.map((c) => `- ${c.text} — ${c.source} — channels: ${c.channels.join(", ")}`);
  return [
    `Judge these RSI findings for the goal "${goal}".`,
    "Drop a claim only when its citation does not support it, or when it contradicts a better-cited claim.",
    "Return one line per dropped claim, in this exact shape, and nothing else for drops:",
    "- DROP: <claim text>",
    "Claims:",
    ...lines,
  ].join("\n");
}

function renderRoundFile(slug: string, round: RsiRound, goal: string): string {
  const findingLines = round.claims.map(
    (c) =>
      `- ${c.text} — ${c.source} — channels: ${c.channels.join(", ")} (${c.confirmed ? "confirmed" : "single-source"})`,
  );
  const droppedLines = round.dropped.map((d) => `- ${d.text} — ${d.reason}`);
  const judgeLines = round.judgeDropped.map((d) => `- ${d.text} — ${d.reason}`);
  return [
    `# RSI round ${round.n} — ${slug}`,
    "",
    `- goal: ${goal}`,
    `- channels: ${RSI_CHANNELS.join(", ")}`,
    `- claims: ${round.claims.length + round.dropped.length + round.judgeDropped.length} total, ${round.claims.length} surviving, ${round.dropped.length} dropped uncited, ${round.judgeDropped.length} dropped by judge, ${round.newFindings} new`,
    `- judge: ${round.judgeSkipped ? "skipped (the judge pass failed — the evidence verdict stands)" : "ran"}`,
    `- stop: ${round.stopReason}`,
    "",
    "## Findings (surviving)",
    "",
    ...(findingLines.length ? findingLines : ["(none)"]),
    "",
    "## Dropped (no cited file, line, or test output)",
    "",
    ...(droppedLines.length ? droppedLines : ["(none)"]),
    "",
    "## Dropped by the judge",
    "",
    ...(judgeLines.length ? judgeLines : ["(none)"]),
    "",
  ].join("\n");
}

export interface PassResult {
  exitCode: number;
  finalText: string;
  agent?: string;
  modelRoute?: string;
}

export type RsiRunPass = (prompt: string, channel: string, round: number) => Promise<PassResult>;

/**
 * The production pass: one routed run per call through prepareRun /
 * executeRun, with the research task kind. The final text comes back
 * through executeRun's io.data (its `finalText` field).
 */
export function makeCmdRunPass(
  ctx: PluginContext,
  opts: {
    io: Io;
    cwd: string;
    policy: Policy;
    routing: RoutingTable | null;
    flags: RunFlags;
    traceId: string;
  },
): RsiRunPass {
  return async (prompt, channel, round) => {
    const routingKind = inferKind(prompt, opts.routing, "research");
    const prepared = await prepareRun(ctx, {
      taskKind: policyKindOf(routingKind),
      prompt,
      flags: opts.flags,
      cwd: opts.cwd,
      policy: opts.policy,
      routing: opts.routing,
      routingKind,
      kindSource: "guessed",
    });
    let runData: { finalText?: string; agent?: string; modelRoute?: string } | undefined;
    const runIo = {
      ...opts.io,
      data(v: unknown) {
        runData = v as typeof runData;
      },
    };
    const code = await executeRun(ctx, runIo, {
      prompt,
      prepared,
      runId: `${opts.traceId}-rsi-r${round}-${channel}`,
      command: "ultramode",
      argv: ["rsi", channel, `round-${round}`],
    });
    return {
      exitCode: code,
      finalText: runData?.finalText ?? "",
      agent: runData?.agent,
      modelRoute: runData?.modelRoute,
    };
  };
}

function roundFilePath(cwd: string, slug: string, n: number): string {
  return path.join(cwd, ".mstack", "research", slug, `round-${n}.md`);
}

function goalPaths(cwd: string, slug: string): { goalPath: string; statePath: string } {
  return {
    goalPath: path.join(cwd, ".mstack", "goals", `${slug}.md`),
    statePath: path.join(cwd, ".mstack", "goals", `${slug}.state.json`),
  };
}

function appendCheckpointRow(goalText: string, row: string): string {
  return goalText.replace("\n\n## Amendments", `\n${row}\n\n## Amendments`);
}

function recordFindingsInGoal(goalText: string, round: RsiRound): string {
  const lines = round.claims.map(
    (c) => `- round ${round.n}: ${c.text} — ${c.source} (${c.confirmed ? "confirmed" : "single-source"})`,
  );
  const section = `## Research findings\n\n${lines.join("\n")}\n`;
  if (goalText.includes("## Research findings")) {
    return goalText.replace("## Research findings\n", `## Research findings\n${lines.join("\n")}\n`);
  }
  if (goalText.includes("\n\n## Amendments")) {
    return goalText.replace("\n\n## Amendments", `\n\n${section}\n## Amendments`);
  }
  return `${goalText}\n\n${section}`;
}

function recordGrillInGoal(goalText: string, goal: string, round: number): string {
  const lines = grillQuestions(goal).map(
    (q) =>
      `- Q: ${q.question} | Default assumed: ${q.default} | Status: assumption (default assumed — amend this file to disagree)`,
  );
  const section = [
    `## Assumptions (grill, round ${round})`,
    "",
    "The mode grilled the goal statement and assumed the defaults below. These are attackable premises, not settled facts; a human amends this file between rounds if they disagree. The loop never blocks waiting for a human.",
    "",
    ...lines,
    "",
  ].join("\n");
  if (goalText.includes("\n\n## Closeout")) {
    return goalText.replace("\n\n## Closeout", `\n\n${section}\n## Closeout`);
  }
  return `${goalText}\n\n${section}`;
}

function writeCloseout(
  ctx: PluginContext,
  cwd: string,
  slug: string,
  goal: string,
  counters: RsiCounters,
  at: string,
): void {
  const { goalPath, statePath } = goalPaths(cwd, slug);
  const status = counters.stopReason === "failed" || counters.stopReason === "denied" ? "failed" : "done";
  const result =
    counters.stopReason === "saturated"
      ? `RSI saturated after ${counters.rounds} round(s): ${counters.findings} findings, ${counters.dropped} dropped uncited`
      : counters.stopReason === "round-cap"
        ? `RSI stopped at the round cap (${counters.roundCap}): ${counters.findings} findings, ${counters.dropped} dropped uncited`
        : counters.stopReason === "denied"
          ? "RSI stopped: a routed pass was denied by the route policy"
          : `RSI stopped: a research round failed (no retry) — ${counters.findings} findings recorded before the failure`;
  const closeout = [
    `- status: ${status}`,
    `- objective: ${goal}`,
    `- result: ${result}`,
    `- unfinished: ${status === "done" ? "(none — RSI loop closed)" : "the goal itself: the RSI loop did not complete"}`,
    `- known-issues: ${status === "done" ? "(none)" : result}`,
    "- lessons: none recorded in unit 5",
    "- gate:",
    "  - m-verify: claims without a cited file, line, or test output were dropped in interrogation",
    `  - rsi stop: ${counters.stopReason} (rounds ${counters.rounds}/${counters.roundCap}, findings ${counters.findings}, dropped ${counters.dropped}, tokensUsed ${counters.tokensUsed} — token accounting unavailable, a configured budget cap cannot fire)`,
    "- Attention: 无",
    `- resume-hint: read ${goalPath}, last checkpoint row`,
  ].join("\n");

  let current: string | undefined;
  try {
    current = ctx.fs.readFile(goalPath);
  } catch {
    current = undefined;
  }
  // The closeout row points at the last round file that actually exists:
  // a failed or denied round writes no round file, so it points at the
  // previous completed round, or says so when no round completed.
  const evidenceRef =
    counters.stopReason === "failed" || counters.stopReason === "denied"
      ? counters.rounds > 1
        ? `.mstack/research/${slug}/round-${counters.rounds - 1}.md`
        : "(no round evidence — the loop stopped before the first round completed)"
      : `.mstack/research/${slug}/round-${counters.rounds}.md`;
  if (current !== undefined) {
    const withRow = appendCheckpointRow(
      current,
      `| ${at} | closeout: rsi ${counters.stopReason} | ${result} | ${evidenceRef} | ${status} |`,
    );
    const closed = withRow.includes("(not yet closed — the loop is still running)")
      ? withRow.replace("(not yet closed — the loop is still running)", closeout)
      : `${withRow}\n\n## RSI closeout\n\n${closeout}\n`;
    ctx.fs.writeFile(goalPath, closed);
  }

  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(ctx.fs.readFile(statePath)) as Record<string, unknown>;
  } catch {
    state = { slug, status: "active", startCommit: null, minRounds: 1, rounds: 0, tokensUsed: 0, budgetPct: 0, failures: {}, lastProgressAt: null };
  }
  state.rsi = counters;
  state.status = status;
  state.updatedAt = at;
  ctx.fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
}

export interface RsiLoopOptions {
  slug: string;
  goal: string;
  cwd: string;
  runPass: RsiRunPass;
  roundCap?: number;
  /** recorded but never enforced: the router reports no token usage */
  budgetTokens?: number | null;
}

export interface RsiLoopResult {
  stopReason: RsiStopReason;
  rounds: number;
  findings: number;
  dropped: number;
  exitCode: ExitCode;
}

function denialOf(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "POLICY_DENIED" || code === "ROUTE_BANNED";
}

/**
 * The RSI loop. One round: 3 channel passes in parallel, interrogation
 * (drop uncited), one judge pass, grill on round 1, refinement into the
 * goal file, then the stop check. A failed research pass stops the loop
 * with a closeout; a denied route stops at 77; the judge failing never
 * blocks the loop — the evidence verdict stands and the skip is recorded.
 */
export async function runRsiLoop(
  ctx: PluginContext,
  io: Io,
  opts: RsiLoopOptions,
): Promise<RsiLoopResult> {
  const roundCap = opts.roundCap ?? RSI_DEFAULT_ROUND_CAP;
  const seen = new Set<string>();
  let dropped = 0;
  const newFindingsByRound: number[] = [];
  let roundsRun = 0;

  const finish = (reason: RsiStopReason): RsiLoopResult => {
    const counters: RsiCounters = {
      rounds: roundsRun,
      findings: seen.size,
      dropped,
      newFindingsByRound,
      stopReason: reason,
      budgetTokens: opts.budgetTokens ?? null,
      tokensUsed: 0,
      channels: [...RSI_CHANNELS],
      roundCap,
    };
    writeCloseout(ctx, opts.cwd, opts.slug, opts.goal, counters, new Date().toISOString());
    const exitCode = reason === "denied" ? ExitCode.NoPerm : reason === "failed" ? ExitCode.Error : ExitCode.Ok;
    return { stopReason: reason, rounds: roundsRun, findings: seen.size, dropped, exitCode };
  };

  for (let n = 1; n <= roundCap; n++) {
    roundsRun = n;
    const at = new Date().toISOString();
    let passes: PassResult[];
    try {
      passes = await Promise.all(
        RSI_CHANNELS.map((channel) => opts.runPass(researchPrompt(opts.goal, channel, n), channel, n)),
      );
    } catch (err) {
      return finish(denialOf(err) ? "denied" : "failed");
    }
    const failedPass = passes.find((p) => p.exitCode !== 0);
    if (failedPass) {
      return finish("failed");
    }

    const claims = passes.flatMap((p, i) => parseClaims(p.finalText, RSI_CHANNELS[i]));
    const { surviving, dropped: uncited } = interrogateClaims(claims, seen);

    // The judge: one routed pass over the surviving claims. A judge
    // failure never blocks the loop; the evidence verdict stands.
    let judgeDropped: RsiDroppedClaim[] = [];
    let judgeSkipped = false;
    try {
      const judge = await opts.runPass(judgePrompt(opts.goal, surviving), "judge", n);
      if (judge.exitCode !== 0) {
        judgeSkipped = true;
      } else {
        judgeDropped = parseJudgeVerdicts(judge.finalText);
      }
    } catch {
      judgeSkipped = true;
    }
    const droppedKeys = new Set(judgeDropped.map((d) => normalizeClaim(d.text)));
    const kept = surviving.filter((c) => !droppedKeys.has(normalizeClaim(c.text)));
    // Only drops that matched a surviving claim count: a DROP line naming
    // a claim that was never in the findings removed nothing.
    const actualJudgeDropped: RsiDroppedClaim[] = surviving
      .filter((c) => droppedKeys.has(normalizeClaim(c.text)))
      .map((c) => ({ text: c.text, reason: "dropped by the judge pass" }));
    const keptNew = kept.filter((c) => !seen.has(normalizeClaim(c.text))).length;
    for (const c of kept) seen.add(normalizeClaim(c.text));
    dropped += uncited.length + actualJudgeDropped.length;
    newFindingsByRound.push(keptNew);

    const round: RsiRound = {
      n,
      claims: kept,
      dropped: uncited,
      newFindings: keptNew,
      judgeDropped: actualJudgeDropped,
      judgeSkipped,
      stopReason: keptNew === 0 ? "saturated" : "continue",
    };
    ctx.fs.writeFile(roundFilePath(opts.cwd, opts.slug, n), renderRoundFile(opts.slug, round, opts.goal));

    // Grill once, on round 1: at most 3 questions with defaults, recorded
    // as assumptions in the goal file; the defaults are assumed and the
    // loop never waits for a human.
    let goalText: string | undefined;
    try {
      goalText = ctx.fs.readFile(goalPaths(opts.cwd, opts.slug).goalPath);
    } catch {
      goalText = undefined;
    }
    if (goalText !== undefined) {
      let updated = goalText;
      if (n === 1 && !updated.includes("## Assumptions (grill")) {
        updated = recordGrillInGoal(updated, opts.goal, n);
      }
      if (kept.length > 0) {
        updated = recordFindingsInGoal(updated, round);
      }
      updated = appendCheckpointRow(
        updated,
        `| ${at} | refine round ${n}: ${keptNew} new finding(s), ${kept.length} surviving, ${uncited.length + judgeDropped.length} dropped | round evidence .mstack/research/${opts.slug}/round-${n}.md | .mstack/research/${opts.slug}/round-${n}.md | active |`,
      );
      ctx.fs.writeFile(goalPaths(opts.cwd, opts.slug).goalPath, updated);
    }

    if (keptNew === 0) {
      return finish("saturated");
    }
  }
  return finish("round-cap");
}
