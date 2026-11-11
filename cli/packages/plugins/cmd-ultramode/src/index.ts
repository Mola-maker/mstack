/**
 * cmd-ultramode — the long-run mode: one goal in, one routed pass out.
 *
 * One goal in, one routed pass out. The handler creates the m-goal state
 * (`.mstack/goals/<slug>.md` + `<slug>.state.json`), then routes and
 * executes the goal exactly once through cmd-run's `prepareRun` /
 * `executeRun` — routing is never re-implemented here. Every exit path
 * (success, agent failure, routing denial) writes the closeout.
 *
 * The FrontierHarness default (design §7) is expressed as a routing flag,
 * not a route id: the mode pins the agent to `dsh` (the DeepSeek Harness
 * adapter — "DSH Creator" is a harness class, not a magpie route id) unless
 * the user passes --agent, --route, or --kind. The route itself still comes
 * from prepareRun's precedence (flag, policy row, picks, default), and the
 * whitelist is never touched.
 */

import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Io, PluginContext } from "@mola/plugin-sdk";
import { definePlugin, ExitCode, MolaError, MolaEvents } from "@mola/plugin-sdk";
import {
  GRANT_SCOPE,
  SAMPLE_SHIP_ARGV,
  grantKey,
  readGrant,
  reviewFilePath,
  reviewGate,
  shipGate,
  type UltramodeGrant,
} from "./gates.js";
import {
  executeRun,
  inferKind,
  loadPolicy,
  loadRoutingFile,
  policyKindOf,
  prepareRun,
  readRunFlags,
} from "@mola/plugin-cmd-run";
import {
  branchName,
  parsePrCreateOutput,
  parsePrListJson,
  parseReview,
  pollChecks,
  renderCommitMessage,
  renderPrBody,
  type PollOptions,
  type ShipRecord,
  type ShipVerdict,
} from "./ship.js";
import {
  RSI_DEFAULT_ROUND_CAP,
  makeCmdRunPass,
  runRsiLoop,
  type RsiRunPass,
} from "./rsi.js";

const MODE_VERSION = "0.1.0";

const STATUS_USAGE = 'usage: mola ultramode ["<goal>"] [--json]';

/** The FrontierHarness default: DSH Creator class, Kimi K3 board. */
export const ULTRAMODE_DEFAULT_AGENT = "dsh";
export const ULTRAMODE_ROUTING_BASIS =
  "FrontierHarness K3 board (30 tasks, 360 runs): DSH Creator 63.3% pass rate, $3.28 effective cost per pass, 84.3% cache hit, 6m 44s median duration — no other configuration beats it on quality and cost at once (design §7)";

export const ULTRAMODE_STAGES = [
  "route",
  "review",
  "interrogate",
  "ship",
] as const;

/** The task kind of a bare `mola ultramode` — no skill wraps it. */
const DEFAULT_TASK_KIND = "implement";

export type UltramodeOutcome = "done" | "failed" | "denied" | "agent-not-found";

export interface UltramodeLastOutcome {
  slug: string;
  goal: string;
  outcome: UltramodeOutcome;
  status: "done" | "failed";
  exitCode: number;
  agent?: string;
  modelRoute?: string;
  at: string;
}

/** Short hash of the full goal text: the disambiguator for slugs that collide. */
function goalHash(goal: string): string {
  return createHash("sha256").update(goal, "utf8").digest("hex").slice(0, 8);
}

/**
 * Kebab-case slug from the goal text, truncated to 48 chars. Unicode
 * letters and numbers are kept, so Chinese goals slug distinctly instead
 * of all collapsing to "goal". When the slug is truncated, or empty after
 * cleaning, a short hash of the full goal text is appended so distinct
 * goals slug distinctly. Short ASCII slugs are unchanged.
 */
export function slugifyGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return `goal-${goalHash(goal)}`;
  if (slug.length > 48) {
    // Cut to 39 so the hash suffix keeps the total within 48 chars.
    const cut = slug.slice(0, 39).replace(/-+$/, "");
    return `${cut}-${goalHash(goal)}`;
  }
  return slug;
}

/** Append a checkpoint row before `## Amendments`, or at the end of the file when the anchor is gone. */
function appendCheckpointRow(text: string, row: string): string {
  const anchored = text.replace("\n\n## Amendments", `\n${row}\n\n## Amendments`);
  if (anchored !== text) return anchored;
  return `${text.endsWith("\n") ? text : `${text}\n`}${row}\n`;
}

/** Fill the `(not yet closed...)` placeholder, or append a new closeout block when it is already gone. */
function fillOrAppendCloseout(text: string, closeout: string, at: string): string {
  if (text.includes("(not yet closed — the loop is still running)")) {
    return text.replace("(not yet closed — the loop is still running)", closeout);
  }
  return `${text.endsWith("\n") ? text : `${text}\n`}\n## Closeout — ${at}\n\n${closeout}\n`;
}

function goalPaths(cwd: string, slug: string): { goalPath: string; statePath: string } {
  return {
    goalPath: path.join(cwd, ".mstack", "goals", `${slug}.md`),
    statePath: path.join(cwd, ".mstack", "goals", `${slug}.state.json`),
  };
}

function renderGoalFile(goal: string, slug: string, createdAt: string): string {
  return [
    `# Goal: ${goal}`,
    "",
    `- Created: ${createdAt}`,
    "- Budget: attempt cap 1 per task, min rounds 1, round cap 1, token budget none",
    "- Stop conditions: the single routed pass ends; the agent exits non-zero; routing is denied",
    "",
    "## Sub-goals (ordered by risk)",
    "",
    "1. [ ] Run the goal once through the existing router and record the outcome — acceptance criteria: prepareRun picks a whitelisted route; executeRun runs the agent; the goal file and state file record the outcome on every exit path",
    "",
    "## Checkpoints",
    "",
    "| ts | decision | why | evidence | result |",
    "|----|----------|-----|----------|--------|",
    `| ${createdAt} | goal created | ultramode run started | mola ultramode "${goal}" | active |`,
    `| ${createdAt} | Ruling: minRounds 1, single pass / unit 2 is the routing and state spine, the multi-round m-goal loop lands in unit 5 / if wrong, a later unit raises the minimum and re-runs | unit 2 scope is one routed pass | cli/design/ultramode.md §12 unit 2 | recorded |`,
    "",
    "## Amendments",
    "",
    "(none)",
    "",
    "## Closeout",
    "",
    "(not yet closed — the loop is still running)",
    "",
  ].join("\n");
}

interface GoalStateFile {
  slug: string;
  status: "active" | "done" | "failed";
  startCommit: null;
  minRounds: number;
  rounds: number;
  tokensUsed: number;
  budgetPct: number;
  failures: Record<string, number>;
  lastProgressAt: string | null;
  updatedAt: string;
  /** unit 4: the last ship attempt, if any */
  ship?: ShipRecord;
  /** unit 5: the RSI counters, if any — preserved across re-runs */
  rsi?: Record<string, unknown>;
}

function renderStateFile(state: GoalStateFile): string {
  return JSON.stringify(state, null, 2) + "\n";
}

function initialState(slug: string, createdAt: string): GoalStateFile {
  return {
    slug,
    status: "active",
    startCommit: null,
    minRounds: 1,
    rounds: 0,
    tokensUsed: 0,
    budgetPct: 0,
    failures: {},
    lastProgressAt: null,
    updatedAt: createdAt,
  };
}

interface CloseoutInput {
  outcome: UltramodeOutcome;
  exitCode: number;
  result: string;
  unfinished: string;
  knownIssues: string;
  failureSignature?: string;
  agent?: string;
  modelRoute?: string;
}

/**
 * The closeout write: appends one checkpoint row, fills `## Closeout` in
 * the goal file (or appends a new closeout block on a re-run, when the
 * placeholder is already gone), and records the outcome in the state
 * file — merging with the existing state, so a re-run never wipes prior
 * ship/rsi records. Runs on every exit path, including a denied route
 * and a failed agent.
 */
function closeGoal(
  ctx: PluginContext,
  cwd: string,
  slug: string,
  goal: string,
  input: CloseoutInput,
): void {
  const { goalPath, statePath } = goalPaths(cwd, slug);
  const at = new Date().toISOString();
  const status = input.outcome === "done" ? "done" : "failed";

  const closeout = [
    `- status: ${status}`,
    `- objective: ${goal}`,
    `- result: ${input.result}`,
    `- unfinished: ${input.unfinished}`,
    `- known-issues: ${input.knownIssues}`,
    "- lessons: none recorded in unit 2",
    "- gate:",
    "  - m-deslop: not run (unit 2 runs one routed pass only; the final gate lands with the unit 5 loop)",
    "  - m-verify: not run (same)",
    "  - m-review: not run (the review gate lands in unit 3)",
    "- Attention: 无",
    `- resume-hint: ${status === "done" ? "—" : `read ${goalPath}, last checkpoint row; blocker: ${input.knownIssues}`}`,
  ].join("\n");

  const current = ctx.fs.readFile(goalPath);
  const withRow = appendCheckpointRow(
    current,
    `| ${at} | closeout: ${input.outcome} | ${input.result} | exit ${input.exitCode}${input.agent ? `, agent ${input.agent}` : ""}${input.modelRoute ? `, route ${input.modelRoute}` : ""} | ${status} |`,
  );
  const closed = fillOrAppendCloseout(withRow, closeout, at);
  ctx.fs.writeFile(goalPath, closed);

  let existing: GoalStateFile | undefined;
  try {
    existing = JSON.parse(ctx.fs.readFile(statePath)) as GoalStateFile;
  } catch {
    existing = undefined;
  }
  const state: GoalStateFile = {
    ...(existing ?? initialState(slug, at)),
    slug,
    status,
    minRounds: existing?.minRounds ?? 1,
    rounds: (existing?.rounds ?? 0) + 1,
    tokensUsed: existing?.tokensUsed ?? 0,
    budgetPct: existing?.budgetPct ?? 0,
    failures: input.failureSignature
      ? { ...(existing?.failures ?? {}), [input.failureSignature]: (existing?.failures?.[input.failureSignature] ?? 0) + 1 }
      : { ...(existing?.failures ?? {}) },
    lastProgressAt: status === "done" ? at : (existing?.lastProgressAt ?? null),
    updatedAt: at,
  };
  ctx.fs.writeFile(statePath, renderStateFile(state));
}

function recordLastOutcome(ctx: PluginContext, outcome: UltramodeLastOutcome): void {
  ctx.state.set("lastOutcome", outcome);
}

/**
 * One stopped ship records the outcome and writes the closeout line, then
 * stops. Never retried: the caller returns 77 (gate denial) or 1 (exec
 * failure) immediately (unit 3 death-loop brake, unit 4 exec failures).
 */
function recordShipStop(
  ctx: PluginContext,
  cwd: string,
  slug: string,
  input: {
    label: string;
    result: string;
    unfinished: string;
    knownIssues: string;
    exitCode: number;
    via: string;
    outcome?: "denied" | "failed";
  },
): void {
  const at = new Date().toISOString();
  const { goalPath } = goalPaths(cwd, slug);
  let current: string | undefined;
  try {
    current = ctx.fs.readFile(goalPath);
  } catch {
    current = undefined; // no goal file to close — the state record below is the outcome
  }
  const goalText = current?.split("\n")[0]?.replace(/^# Goal: /, "").trim() || slug;
  recordLastOutcome(ctx, {
    slug,
    goal: goalText,
    outcome: input.outcome ?? "failed",
    status: "failed",
    exitCode: input.exitCode,
    at,
  });
  if (current === undefined) return;
  const withRow = appendCheckpointRow(
    current,
    `| ${at} | ${input.label} | ${input.result} | ${input.via} | failed |`,
  );
  const closed = fillOrAppendCloseout(
    withRow,
    [
      "- status: failed",
      `- objective: ${slug}`,
      `- result: ${input.result}`,
      `- unfinished: ${input.unfinished}`,
      `- known-issues: ${input.knownIssues}`,
      "- lessons: none recorded in unit 3",
      "- gate:",
      "  - m-review: not run",
      "  - ultramode ship: stopped",
      "- Attention: 无",
      `- resume-hint: read ${goalPath}, last checkpoint row; blocker: ${input.knownIssues}`,
    ].join("\n"),
    at,
  );
  ctx.fs.writeFile(goalPath, closed);
}

function recordGateDenial(
  ctx: PluginContext,
  cwd: string,
  slug: string,
  gate: "review" | "ship",
  reason: string,
  via = "ship --check",
): void {
  recordShipStop(ctx, cwd, slug, {
    label: `gate denied: ${gate}`,
    result: `gate denied at ${gate}: ${reason}`,
    unfinished: `the goal itself: shipping stopped at the ${gate} gate`,
    knownIssues: reason,
    exitCode: ExitCode.NoPerm,
    via,
    outcome: "denied",
  });
}

/** An exec failure during ship: clear message, closeout line, stop, no retry. */
function recordShipFailure(
  ctx: PluginContext,
  cwd: string,
  slug: string,
  stage: string,
  reason: string,
): void {
  recordShipStop(ctx, cwd, slug, {
    label: `ship failed: ${stage}`,
    result: `ship failed at ${stage}: ${reason}`,
    unfinished: `the goal itself: shipping stopped at ${stage}`,
    knownIssues: reason,
    exitCode: ExitCode.Error,
    via: "ship",
  });
}

/** Goal objective from the goal file (first line), or the slug when there is none. */
function readGoalText(ctx: PluginContext, cwd: string, slug: string): string {
  try {
    const first = ctx.fs.readFile(goalPaths(cwd, slug).goalPath).split("\n")[0] ?? "";
    return first.replace(/^# Goal: /, "").trim() || slug;
  } catch {
    return slug;
  }
}

/**
 * A ship outcome lands in the state file (merged, never wiping the run
 * record), in the last outcome, and as a checkpoint row + closeout in the
 * goal file when one exists.
 */
function recordShipOutcome(
  ctx: PluginContext,
  cwd: string,
  slug: string,
  record: ShipRecord,
  result: string,
): void {
  const at = record.at;
  const done = record.verdict === "shipped" || record.verdict === "prepared" || record.verdict === "duplicate";
  const { goalPath, statePath } = goalPaths(cwd, slug);
  let state: GoalStateFile;
  try {
    state = JSON.parse(ctx.fs.readFile(statePath)) as GoalStateFile;
  } catch {
    state = initialState(slug, at);
  }
  state.ship = record;
  state.status = done ? "done" : "failed";
  state.updatedAt = at;
  ctx.fs.writeFile(statePath, renderStateFile(state));

  const goalText = readGoalText(ctx, cwd, slug);
  const lastOutcome = ctx.state.get<UltramodeLastOutcome>("lastOutcome");
  recordLastOutcome(ctx, {
    slug,
    goal: goalText,
    outcome: done ? "done" : "failed",
    status: done ? "done" : "failed",
    exitCode: done ? ExitCode.Ok : ExitCode.Error,
    agent: lastOutcome?.slug === slug ? lastOutcome.agent : undefined,
    modelRoute: lastOutcome?.slug === slug ? lastOutcome.modelRoute : undefined,
    at,
  });

  let current: string | undefined;
  try {
    current = ctx.fs.readFile(goalPath);
  } catch {
    current = undefined;
  }
  if (current === undefined) return;
  const withRow = appendCheckpointRow(
    current,
    `| ${at} | ship: ${record.verdict} | ${result} | ship | ${done ? "done" : "failed"} |`,
  );
  const closed = fillOrAppendCloseout(
    withRow,
    [
      `- status: ${done ? "done" : "failed"}`,
      `- objective: ${goalText}`,
      `- result: ${result}`,
      `- unfinished: ${done ? "(none — ship outcome recorded)" : "the goal itself: shipping did not complete"}`,
      `- known-issues: ${record.verdict === "blocked" ? `failing checks: ${(record.failing ?? []).join(", ")}` : record.reason ?? "(none)"}`,
      "- lessons: none recorded in unit 4",
      "- gate:",
      "  - m-review: passed",
      `  - ultramode ship: ${record.verdict}`,
      "- Attention: 无",
      `- resume-hint: read ${goalPath}, last checkpoint row`,
    ].join("\n"),
    at,
  );
  ctx.fs.writeFile(goalPath, closed);
}

const GRANT_USAGE = "usage: mola ultramode grant <slug>";
const REVOKE_USAGE = "usage: mola ultramode revoke <slug>";
const SHIP_USAGE = "usage: mola ultramode ship <slug> | mola ultramode ship --check <slug>";
const RSI_USAGE = "usage: mola ultramode rsi <slug> [--rounds N] [--budget-tokens N] [--agent <id>] [--route <id>]";

/**
 * `rsi <slug>` (unit 5): the RSI loop for an existing goal — search,
 * interrogate, refine, repeat until saturation, the round cap, a denied
 * route, or a failed round. Every research pass is a routed run through
 * prepareRun / executeRun (see makeCmdRunPass); the loop never blocks
 * waiting for a human and never retries a failed round.
 */
async function runRsiCommand(
  ctx: PluginContext,
  io: Io,
  slug: string,
  flags: Record<string, string | boolean>,
): Promise<ExitCode> {
  const cwd = io.cwd;
  // readGoalText falls back to the slug when the file is missing; the
  // goal file must actually exist, otherwise there is nothing to refine.
  try {
    ctx.fs.readFile(goalPaths(cwd, slug).goalPath);
  } catch {
    throw new MolaError("USAGE_ERROR", `no goal file for "${slug}" — run \`mola ultramode "<goal>"\` first`, ExitCode.Usage);
  }
  const goalText = readGoalText(ctx, cwd, slug);
  const roundsRaw = typeof flags.rounds === "string" ? Number(flags.rounds) : NaN;
  const roundCap = Number.isInteger(roundsRaw) && roundsRaw > 0 ? roundsRaw : RSI_DEFAULT_ROUND_CAP;
  const budgetRaw = typeof flags["budget-tokens"] === "string" ? Number(flags["budget-tokens"]) : NaN;
  const budgetTokens = Number.isInteger(budgetRaw) && budgetRaw > 0 ? budgetRaw : null;

  const policy = loadPolicy(ctx.fs, cwd);
  for (const warning of policy.warnings) io.note(`mola: ${warning}`);
  const loaded = loadRoutingFile();
  if (loaded.warning) io.note(`mola: routing file: ${loaded.warning} — routing by policy only`);
  const runFlags = readRunFlags(flags);
  if (!runFlags.agent) runFlags.agent = ULTRAMODE_DEFAULT_AGENT;
  const runPass: RsiRunPass = makeCmdRunPass(ctx, {
    io,
    cwd,
    policy,
    routing: loaded.table,
    flags: runFlags,
    traceId: io.traceId,
  });

  const result = await runRsiLoop(ctx, io, {
    slug,
    goal: goalText,
    cwd,
    runPass,
    roundCap,
    budgetTokens,
  });
  io.data({
    rsi: {
      slug,
      goal: goalText,
      stopReason: result.stopReason,
      rounds: result.rounds,
      roundCap,
      findings: result.findings,
      dropped: result.dropped,
      budgetTokens,
      tokensUsed: 0,
    },
  });
  if (!io.json) {
    io.out(
      `ultramode rsi ${slug}: ${result.stopReason} after ${result.rounds} round(s) — ${result.findings} findings, ${result.dropped} dropped`,
    );
  }
  return result.exitCode;
}

/**
 * `ship <slug>`: the real ship (unit 4). Order: review gate, branch +
 * commit on `ultramode/<slug>`, prepared-PR fallback without a grant,
 * duplicate-PR check, then per-action ship gates for push and PR create,
 * then the CI poll. A gate denial stops at 77; any exec failure stops
 * with a closeout line; nothing retries, nothing merges.
 */
export async function runShip(
  ctx: PluginContext,
  io: Io,
  slug: string,
  opts: PollOptions = {},
): Promise<ExitCode> {
  const cwd = io.cwd;
  const branch = branchName(slug);
  const goalText = readGoalText(ctx, cwd, slug);
  const lastOutcome = ctx.state.get<UltramodeLastOutcome>("lastOutcome");
  const sameGoal = lastOutcome?.slug === slug;
  const writer = sameGoal ? lastOutcome.agent : undefined;
  const agent = sameGoal ? lastOutcome.agent : undefined;
  const modelRoute = sameGoal ? lastOutcome.modelRoute : undefined;
  const exec = (argv: string[]) => ctx.process.exec(argv, { cwd });

  const fail = (stage: string, reason: string): ExitCode => {
    recordShipFailure(ctx, cwd, slug, stage, reason);
    io.data({ ship: { slug, verdict: "failed", stage, reason } });
    if (!io.json) io.out(`ultramode ship ${slug}: FAILED at ${stage} — ${reason}`);
    return ExitCode.Error;
  };
  const deny = (gate: "review" | "ship", reason: string, extra: Record<string, unknown> = {}): ExitCode => {
    recordGateDenial(ctx, cwd, slug, gate, reason, "ship");
    io.data({ ship: { slug, verdict: "denied", gate, reason, ...extra } });
    if (!io.json) io.out(`ultramode ship ${slug}: DENIED at the ${gate} gate — ${reason}`);
    return ExitCode.NoPerm;
  };

  // 1. Review gate — no exec runs before it passes.
  let reviewText: string;
  try {
    await ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug, cwd, writer });
    reviewText = ctx.fs.readFile(reviewFilePath(cwd, slug));
  } catch (err) {
    return deny("review", err instanceof Error ? err.message : String(err));
  }
  const review = parseReview(reviewText);

  // 2. Branch: create `ultramode/<slug>` from HEAD, or switch to it.
  const current = await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.code !== 0) {
    return fail("branch", `git rev-parse --abbrev-ref HEAD exited ${current.code}: ${(current.stderr || current.stdout).trim()}`);
  }
  const currentBranch = current.stdout.trim();
  const exists = (await exec(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  const checkoutArgv = exists ? ["git", "checkout", branch] : ["git", "checkout", "-b", branch];
  const checkout = await exec(checkoutArgv);
  if (checkout.code !== 0) {
    const detail = (checkout.stderr || checkout.stdout).trim();
    const reason =
      currentBranch === "master" || currentBranch === "main"
        ? `cannot create ${branch} from ${currentBranch} (${detail}); refusing to push ${currentBranch} — fix the branch and retry`
        : `cannot switch to ${branch}: ${detail}`;
    return fail("branch", reason);
  }

  // 3. Commit the workspace changes on the ultramode branch.
  const add = await exec(["git", "add", "-A"]);
  if (add.code !== 0) {
    return fail("commit", `git add -A exited ${add.code}: ${(add.stderr || add.stdout).trim()}`);
  }
  const grant = readGrant(ctx, slug, cwd);
  const granted = !!grant && grant.workspace === cwd;
  const commitMessage = renderCommitMessage({
    goal: goalText,
    outcome: sameGoal ? lastOutcome.outcome : undefined,
    review,
    granted,
  });
  const commit = await exec(["git", "commit", "-m", commitMessage]);
  const commitOut = `${commit.stdout}\n${commit.stderr}`;
  if (commit.code !== 0 && !/nothing to commit/i.test(commitOut)) {
    return fail("commit", `git commit exited ${commit.code}: ${commitOut.trim()}`);
  }
  const sha = await exec(["git", "rev-parse", "HEAD"]);
  if (sha.code !== 0) {
    return fail("commit", `git rev-parse HEAD exited ${sha.code}: ${(sha.stderr || sha.stdout).trim()}`);
  }
  const commitSha = sha.stdout.trim();

  const prBody = renderPrBody({
    goal: goalText,
    outcome: sameGoal ? lastOutcome.outcome : undefined,
    review,
    agent,
    modelRoute,
    granted,
  });

  // 4. No grant: prepared PR only — commit stays local, nothing is pushed.
  if (!granted) {
    const prBodyPath = path.join(cwd, ".mstack", "goals", `${slug}.pr.md`);
    ctx.fs.writeFile(prBodyPath, prBody);
    const record: ShipRecord = {
      slug,
      verdict: "prepared",
      branch,
      commit: commitSha,
      prBodyPath,
      pushed: false,
      at: new Date().toISOString(),
    };
    recordShipOutcome(ctx, cwd, slug, record, `prepared PR on ${branch} at ${commitSha} — nothing pushed, PR body written to ${prBodyPath}`);
    io.data({ ship: record });
    if (!io.json) {
      io.out(`ultramode ship ${slug}: prepared only — committed ${commitSha} on ${branch}, nothing pushed; PR body in ${prBodyPath}`);
    }
    return ExitCode.Ok;
  }

  // 5. Duplicate PR check, before anything is created.
  const list = await exec(["gh", "pr", "list", "--head", branch, "--json", "number,url", "--limit", "1"]);
  if (list.code !== 0) {
    return fail("pr-list", `gh pr list exited ${list.code}: ${(list.stderr || list.stdout).trim()}`);
  }
  let existing: { number: number; url: string } | undefined;
  try {
    existing = parsePrListJson(list.stdout);
  } catch {
    return fail("pr-list", `gh pr list returned unparsable output: ${list.stdout.trim()}`);
  }
  if (existing) {
    const record: ShipRecord = {
      slug,
      verdict: "duplicate",
      branch,
      commit: commitSha,
      prUrl: existing.url,
      prNumber: existing.number,
      pushed: false,
      at: new Date().toISOString(),
    };
    recordShipOutcome(ctx, cwd, slug, record, `PR already exists: ${existing.url} — no duplicate created`);
    io.data({ ship: record });
    if (!io.json) io.out(`ultramode ship ${slug}: PR already exists — ${existing.url} (no duplicate created)`);
    return ExitCode.Ok;
  }

  // 6. Push, gated with the exact argv.
  const pushArgv = ["git", "push", "-u", "origin", branch];
  try {
    await ctx.events.runWaterfall(MolaEvents.UltramodeShip, { slug, cwd, argv: pushArgv });
  } catch (err) {
    return deny("ship", err instanceof Error ? err.message : String(err), { branch, commit: commitSha, pushed: false });
  }
  const push = await exec(pushArgv);
  if (push.code !== 0) {
    return fail("push", `git push exited ${push.code}: ${(push.stderr || push.stdout).trim()}`);
  }

  // 7. Create the PR, gated with the exact argv.
  const prArgv = ["gh", "pr", "create", "--title", goalText, "--body", prBody];
  try {
    await ctx.events.runWaterfall(MolaEvents.UltramodeShip, { slug, cwd, argv: prArgv });
  } catch (err) {
    return deny("ship", err instanceof Error ? err.message : String(err), { branch, commit: commitSha, pushed: true });
  }
  const created = await exec(prArgv);
  if (created.code !== 0) {
    return fail("pr-create", `gh pr create exited ${created.code}: ${(created.stderr || created.stdout).trim()}`);
  }
  const pr = parsePrCreateOutput(created.stdout);
  if (!pr) {
    return fail("pr-create", `gh pr create did not print a PR URL: ${created.stdout.trim()}`);
  }

  // 8. Poll CI. Never auto-merge. A gh failure that yields no parseable
  // JSON is an exec failure at the ci-poll stage, never blocked/running.
  let poll: Awaited<ReturnType<typeof pollChecks>>;
  try {
    poll = await pollChecks(exec, pr.number, opts);
  } catch (err) {
    return fail("ci-poll", err instanceof Error ? err.message : String(err));
  }
  const verdict: ShipVerdict = poll.verdict;
  const record: ShipRecord = {
    slug,
    verdict,
    branch,
    commit: commitSha,
    prUrl: pr.url,
    prNumber: pr.number,
    failing: poll.failing,
    pushed: true,
    at: new Date().toISOString(),
  };
  const result =
    verdict === "shipped"
      ? `shipped: PR ${pr.url} — all checks passed`
      : verdict === "blocked"
        ? `blocked: PR ${pr.url} — failing checks: ${(poll.failing ?? []).join(", ")}`
        : `running: PR ${pr.url} — checks still running at the poll cap`;
  recordShipOutcome(ctx, cwd, slug, record, result);
  io.data({ ship: record });
  if (!io.json) {
    io.out(
      `ultramode ship ${slug}: ${verdict} — ${pr.url}${verdict === "blocked" ? ` (failing: ${(poll.failing ?? []).join(", ")})` : ""}`,
    );
  }
  return verdict === "shipped" ? ExitCode.Ok : ExitCode.Error;
}

/** `ship --check`: review gate, then ship gate, with a sample outward argv. No outward action. */
async function runShipCheck(ctx: PluginContext, io: Io, slug: string): Promise<ExitCode> {
  const lastOutcome = ctx.state.get<UltramodeLastOutcome>("lastOutcome");
  const writer = lastOutcome?.slug === slug ? lastOutcome.agent : undefined;
  try {
    await ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug, cwd: io.cwd, writer });
    await ctx.events.runWaterfall(MolaEvents.UltramodeShip, {
      slug,
      cwd: io.cwd,
      argv: SAMPLE_SHIP_ARGV,
      // a probe: the ship gate runs the ToolBefore waterfall but emits
      // no approval record for an action that never happened.
      probe: true,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const gate = reason.startsWith("review:") ? "review" : "ship";
    recordGateDenial(ctx, io.cwd, slug, gate, reason);
    io.data({ shipCheck: { slug, ok: false, gate, reason } });
    if (!io.json) io.out(`ultramode ship --check ${slug}: DENIED at the ${gate} gate — ${reason}`);
    return ExitCode.NoPerm;
  }
  io.data({
    shipCheck: { slug, ok: true, review: "passed", ship: "passed", argv: [...SAMPLE_SHIP_ARGV] },
  });
  if (!io.json) io.out(`ultramode ship --check ${slug}: pass (review + ship gates)`);
  return ExitCode.Ok;
}

async function handleSubcommand(
  ctx: PluginContext,
  io: Io,
  sub: string,
  subArg: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<ExitCode> {
  if (sub === "grant") {
    if (!subArg) throw new MolaError("USAGE_ERROR", GRANT_USAGE, ExitCode.Usage);
    const grant: UltramodeGrant = {
      slug: subArg,
      workspace: io.cwd,
      grantedBy: io.traceId,
      at: new Date().toISOString(),
      scope: GRANT_SCOPE,
    };
    ctx.state.set(grantKey(subArg, io.cwd), grant);
    io.data({ granted: true, grant });
    if (!io.json) io.out(`ultramode grant recorded: ${subArg} (workspace ${io.cwd}, by ${io.traceId})`);
    return ExitCode.Ok;
  }
  if (sub === "revoke") {
    if (!subArg) throw new MolaError("USAGE_ERROR", REVOKE_USAGE, ExitCode.Usage);
    const hadGrant = readGrant(ctx, subArg, io.cwd) !== undefined;
    ctx.state.delete(grantKey(subArg, io.cwd));
    io.data({ revoked: true, slug: subArg, hadGrant });
    if (!io.json) io.out(`ultramode grant revoked: ${subArg}${hadGrant ? "" : " (none existed)"}`);
    return ExitCode.Ok;
  }
  // `ship --check <slug>` keeps its unit 3 meaning (gates only, no outward
  // action); bare `ship <slug>` is the real ship. Bare `ship` is a usage error.
  if (sub === "ship") {
    if (typeof flags.check === "string") return runShipCheck(ctx, io, flags.check);
    if ("check" in flags) throw new MolaError("USAGE_ERROR", SHIP_USAGE, ExitCode.Usage);
    if (!subArg) throw new MolaError("USAGE_ERROR", SHIP_USAGE, ExitCode.Usage);
    return runShip(ctx, io, subArg);
  }
  if (sub === "rsi") {
    if (!subArg) throw new MolaError("USAGE_ERROR", RSI_USAGE, ExitCode.Usage);
    return runRsiCommand(ctx, io, subArg, flags);
  }
  throw new MolaError("USAGE_ERROR", SHIP_USAGE, ExitCode.Usage);
}

/** The flags as argv entries (for the run record). */
function flagArgs(flags: { agent?: string; on?: string; route?: string; kind?: string }): string[] {
  const out: string[] = [];
  if (flags.agent) out.push("--agent", flags.agent);
  if (flags.on) out.push("--on", flags.on);
  if (flags.route) out.push("--route", flags.route);
  if (flags.kind) out.push("--kind", flags.kind);
  return out;
}

function outcomeOfError(err: unknown): { outcome: UltramodeOutcome; failureSignature: string } {
  const code = (err as { code?: string } | null)?.code;
  if (code === "POLICY_DENIED" || code === "ROUTE_BANNED") {
    return { outcome: "denied", failureSignature: "routing-denied" };
  }
  if (code === "AGENT_NOT_FOUND") {
    return { outcome: "agent-not-found", failureSignature: "agent-not-found" };
  }
  return { outcome: "failed", failureSignature: "run-error" };
}

export function statusData(ctx: PluginContext): Record<string, unknown> {
  const activeGoal = ctx.state.get<string>("activeGoal");
  const lastOutcome = ctx.state.get<UltramodeLastOutcome>("lastOutcome");
  return {
    mode: "ultramode",
    version: MODE_VERSION,
    stages: [...ULTRAMODE_STAGES],
    activeGoal: activeGoal ?? null,
    lastOutcome: lastOutcome ?? null,
    shippingNeedsGrant: true,
    grantSource: "ultramode grant, recorded in the mode state (never --yes)",
  };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    // unit 3 gates: both waterfall, rejection is the denial path (exit 77)
    ctx.events.hook(MolaEvents.UltramodeReview, reviewGate(ctx));
    ctx.events.hook(MolaEvents.UltramodeShip, shipGate(ctx));

    ctx.commands.register({
      path: ["ultramode"],
      description: "the long-run mode: route, review, interrogate, ship (gates + grant)",
      async handler(args, io) {
        const goal = args.positionals.join(" ").trim();
        if (!goal) {
          const data = statusData(ctx);
          io.data(data);
          if (!io.json) {
            io.out(`mola ultramode ${MODE_VERSION} — stages: ${ULTRAMODE_STAGES.join(" → ")}`);
            const activeGoal = data.activeGoal as string | null;
            const lastOutcome = data.lastOutcome as UltramodeLastOutcome | null;
            io.out(activeGoal ? `goal active: ${activeGoal}` : "no goal active");
            if (lastOutcome) {
              io.out(`last outcome: ${lastOutcome.slug} — ${lastOutcome.outcome} (exit ${lastOutcome.exitCode})`);
            }
            io.out("shipping needs a recorded ultramode grant (never --yes)");
            io.out(STATUS_USAGE);
          }
          return ExitCode.Ok;
        }

        const [sub, subArg] = args.positionals;
        // A subcommand only when there are at least 2 positionals — a
        // bare single word ("ship", "grant", "rsi") is a goal, not a
        // subcommand — except `ship --check <slug>`, which carries its
        // slug in the flag and has one positional by design.
        const isSubcommand =
          args.positionals.length >= 2 || (sub === "ship" && "check" in args.flags);
        if (isSubcommand && (sub === "grant" || sub === "revoke" || sub === "ship" || sub === "rsi")) {
          return handleSubcommand(ctx, io, sub, subArg, args.flags);
        }

        const flags = readRunFlags(args.flags);
        const slug = slugifyGoal(goal);
        const createdAt = new Date().toISOString();
        const { goalPath, statePath } = goalPaths(io.cwd, slug);
        // A re-run keeps the existing goal file and state (history, ship
        // and rsi records survive) and appends a re-run checkpoint row;
        // only a first run writes them from scratch.
        let existingGoal: string | undefined;
        try {
          existingGoal = ctx.fs.readFile(goalPath);
        } catch {
          existingGoal = undefined;
        }
        if (existingGoal === undefined) {
          ctx.fs.writeFile(goalPath, renderGoalFile(goal, slug, createdAt));
          ctx.fs.writeFile(statePath, renderStateFile(initialState(slug, createdAt)));
        } else {
          ctx.fs.writeFile(
            goalPath,
            appendCheckpointRow(
              existingGoal,
              `| ${createdAt} | re-run: goal re-entered | prior goal file and state kept, history preserved | mola ultramode "${goal}" | active |`,
            ),
          );
          let state: GoalStateFile;
          try {
            state = JSON.parse(ctx.fs.readFile(statePath)) as GoalStateFile;
          } catch {
            state = initialState(slug, createdAt);
          }
          state.status = "active";
          state.updatedAt = createdAt;
          ctx.fs.writeFile(statePath, renderStateFile(state));
        }
        ctx.state.set("activeGoal", slug);

        const policy = loadPolicy(ctx.fs, io.cwd);
        for (const warning of policy.warnings) io.note(`mola: ${warning}`);
        const loaded = loadRoutingFile();
        if (loaded.warning) io.note(`mola: routing file: ${loaded.warning} — routing by policy only`);
        const table = loaded.table;
        const routingKind = flags.kind ?? inferKind(goal, table, DEFAULT_TASK_KIND);
        const kindSource = flags.kind ? "--kind" : "guessed";
        const taskKind = flags.kind ? policyKindOf(routingKind) : DEFAULT_TASK_KIND;

        const overriddenBy: string[] = [];
        if (flags.agent) overriddenBy.push("--agent");
        if (flags.route) overriddenBy.push("--route");
        if (flags.kind) overriddenBy.push("--kind");
        const routingDefault = {
          agent: ULTRAMODE_DEFAULT_AGENT,
          basis: ULTRAMODE_ROUTING_BASIS,
          applied: overriddenBy.length === 0,
          overriddenBy,
        };
        const runFlags = routingDefault.applied ? { ...flags, agent: ULTRAMODE_DEFAULT_AGENT } : flags;

        let prepared: Awaited<ReturnType<typeof prepareRun>>;
        try {
          prepared = await prepareRun(ctx, {
            taskKind,
            prompt: goal,
            flags: runFlags,
            cwd: io.cwd,
            policy,
            routing: table,
            routingKind,
            kindSource,
          });
        } catch (err) {
          const classified = outcomeOfError(err);
          const message = (err as { message?: string } | null)?.message ?? String(err);
          closeGoal(ctx, io.cwd, slug, goal, {
            outcome: classified.outcome,
            exitCode: (err as { exitCode?: number } | null)?.exitCode ?? ExitCode.NoPerm,
            result: `routing ${classified.outcome}: ${message}`,
            unfinished: "the goal itself: no routed pass ran",
            knownIssues: message,
            failureSignature: classified.failureSignature,
          });
          recordLastOutcome(ctx, {
            slug,
            goal,
            outcome: classified.outcome,
            status: "failed",
            exitCode: (err as { exitCode?: number } | null)?.exitCode ?? ExitCode.NoPerm,
            at: new Date().toISOString(),
          });
          throw err;
        }

        let runData: unknown;
        const runIo = { ...io, data(v: unknown) { runData = v; } };
        let exitCode: ExitCode;
        try {
          exitCode = await executeRun(ctx, runIo, {
            prompt: goal,
            prepared,
            runId: io.traceId,
            command: "ultramode",
            argv: [goal, ...flagArgs(runFlags)],
          });
        } catch (err) {
          const classified = outcomeOfError(err);
          const message = (err as { message?: string } | null)?.message ?? String(err);
          closeGoal(ctx, io.cwd, slug, goal, {
            outcome: classified.outcome,
            exitCode: (err as { exitCode?: number } | null)?.exitCode ?? ExitCode.Error,
            result: `run ${classified.outcome}: ${message}`,
            unfinished: "the goal itself: the routed pass did not complete",
            knownIssues: message,
            failureSignature: classified.failureSignature,
            agent: prepared.decision.agent,
            modelRoute: prepared.decision.modelRoute,
          });
          recordLastOutcome(ctx, {
            slug,
            goal,
            outcome: classified.outcome,
            status: "failed",
            exitCode: (err as { exitCode?: number } | null)?.exitCode ?? ExitCode.Error,
            agent: prepared.decision.agent,
            modelRoute: prepared.decision.modelRoute,
            at: new Date().toISOString(),
          });
          throw err;
        }

        const outcome: UltramodeOutcome = exitCode === 0 ? "done" : "failed";
        closeGoal(ctx, io.cwd, slug, goal, {
          outcome,
          exitCode,
          result:
            exitCode === 0
              ? `agent ${prepared.decision.agent} exited 0 via ${prepared.decision.modelRoute} (routing default ${routingDefault.agent} ${routingDefault.applied ? "applied" : `overridden by ${routingDefault.overriddenBy.join(", ")}`})`
              : `agent ${prepared.decision.agent} exited ${exitCode} via ${prepared.decision.modelRoute}`,
          unfinished: exitCode === 0 ? "(none — single pass complete)" : "the goal itself: the single routed pass did not complete",
          knownIssues: exitCode === 0 ? "(none)" : `agent exited ${exitCode}`,
          failureSignature: exitCode === 0 ? undefined : `agent-exit-${exitCode}`,
          agent: prepared.decision.agent,
          modelRoute: prepared.decision.modelRoute,
        });
        recordLastOutcome(ctx, {
          slug,
          goal,
          outcome,
          status: outcome === "done" ? "done" : "failed",
          exitCode,
          agent: prepared.decision.agent,
          modelRoute: prepared.decision.modelRoute,
          at: new Date().toISOString(),
        });

        const existing = ctx.state.get<Record<string, unknown>>(`run:${io.traceId}`) ?? {};
        ctx.state.set(`run:${io.traceId}`, {
          ...existing,
          ultramode: {
            slug,
            goal,
            routingDefault,
            outcome,
            taskKind: routingKind,
            kindSource,
          },
        });
        io.data({
          ...((runData ?? {}) as Record<string, unknown>),
          ultramode: {
            slug,
            goal,
            goalPath,
            statePath,
            routingDefault,
            outcome,
            taskKind: routingKind,
            kindSource,
          },
        });
        if (!io.json) io.note(`mola: ultramode goal ${slug}: ${outcome} — ${goalPath}`);
        return exitCode;
      },
    });
  },
});
