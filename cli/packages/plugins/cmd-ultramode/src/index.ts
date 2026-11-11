/**
 * cmd-ultramode (unit 2: routing and state).
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
import type { PluginContext } from "@mola/plugin-sdk";
import { definePlugin, ExitCode } from "@mola/plugin-sdk";
import {
  executeRun,
  inferKind,
  loadPolicy,
  loadRoutingFile,
  policyKindOf,
  prepareRun,
  readRunFlags,
} from "@mola/plugin-cmd-run";

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

/** Kebab-case slug from the goal text, truncated to 48 chars. */
export function slugifyGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = slug.slice(0, 48).replace(/-+$/, "");
  return cut || "goal";
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
 * the goal file, and records the outcome in the state file. Runs on every
 * exit path, including a denied route and a failed agent.
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
  const withRow = current.replace(
    "\n\n## Amendments",
    `\n| ${at} | closeout: ${input.outcome} | ${input.result} | exit ${input.exitCode}${input.agent ? `, agent ${input.agent}` : ""}${input.modelRoute ? `, route ${input.modelRoute}` : ""} | ${status} |\n\n## Amendments`,
  );
  const closed = withRow.replace(
    "(not yet closed — the loop is still running)",
    closeout,
  );
  ctx.fs.writeFile(goalPath, closed);

  const state: GoalStateFile = {
    slug,
    status,
    startCommit: null,
    minRounds: 1,
    rounds: 1,
    tokensUsed: 0,
    budgetPct: 0,
    failures: input.failureSignature ? { [input.failureSignature]: 1 } : {},
    lastProgressAt: status === "done" ? at : null,
    updatedAt: at,
  };
  ctx.fs.writeFile(statePath, renderStateFile(state));
}

function recordLastOutcome(ctx: PluginContext, outcome: UltramodeLastOutcome): void {
  ctx.state.set("lastOutcome", outcome);
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

        const flags = readRunFlags(args.flags);
        const slug = slugifyGoal(goal);
        const createdAt = new Date().toISOString();
        const { goalPath, statePath } = goalPaths(io.cwd, slug);
        ctx.fs.writeFile(goalPath, renderGoalFile(goal, slug, createdAt));
        ctx.fs.writeFile(statePath, renderStateFile(initialState(slug, createdAt)));
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
