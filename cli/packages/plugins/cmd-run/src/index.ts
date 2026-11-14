/**
 * cmd-run (B2 — the routing engine and the skill commands).
 *
 *   mola run "<task>" [--agent <id>] [--on <machine>] [--route <id>] [--json]
 *   mola think|plan|goal|team|review|ship "<topic>" [same flags]
 *
 * `mola run` is the general router (ADR-0003): it filters the registered
 * `HeadlessAgentAdapter`s (health, capabilities, machine, pinned agent), scores
 * the survivors (kind affinity, cost, route fit, machine rank, failure
 * memory), picks a magpie route under the whitelist (`group/*` / `auto/*` —
 * never `deepseek/*`), and calls `AgentAdapter.run()`. A quota failure (402 /
 * rate limit) is first-class: the recovery ladder of ADR-0003 §4 retries on the
 * same route, waits on `magpie quota wait`, switches route, switches agent, and
 * finally reports.
 *
 * The run's decision reaches `.mstack/runs/<runId>/decision.json` through the
 * bus: the adapter emits `mola.session.started` (agent, machine, cwd,
 * modelRoute) and the rec-runs plugin records it — no producer edit needed.
 *
 * The six skill commands wrap the matching mstack skill (m-think, m-plan,
 * m-goal, m-team, m-review, m-ship) with a prompt that names the skill and
 * its `.mstack/` state paths, and run it through the same router.
 */

import * as path from "node:path";
import type {
  HeadlessAgentAdapter,
  HookEvent,
  PluginContext,
  RunRequest,
  RunResult,
} from "@mola/plugin-sdk";
import { definePlugin, ExitCode, formatDuration, ioSpinner, MolaError, MolaEvents, verboseRequested } from "@mola/plugin-sdk";
import {
  checkRoute,
  loadPolicy,
  type Policy,
  type TaskKind,
} from "./policy.js";
import {
  approvalFor,
  collectCandidates,
  explain,
  filterCandidates,
  machineMatches,
  permissionProfileFor,
  routeFit,
  routeForTaskKind,
  runnableAdapters,
  scoreCandidates,
  type RouteDecision,
  type RouteRequest,
} from "./router.js";
import {
  allowedAlternates,
  makeQuotaWaitRunner,
  planLadder,
  providerOfRoute,
  summarize,
  type LadderAttempt,
} from "./quota.js";
import {
  SKILL_COMMANDS,
  buildSkillPrompt,
  findMstackRoot,
  resolveStatePaths,
  skillFile,
  skillSpec,
  statePathsFromSkill,
  type SkillSpec,
} from "./skills.js";
import {
  RUN_STREAM_EVENTS,
  eventKinds,
  makeEnvelope,
  ndjsonSink,
  recordingSink,
  type EventSink,
} from "./stream.js";
import { probeVisibleRoutesFor } from "./visible.js";
import {
  adaptPrompt,
  inferKind,
  loadRouting,
  loadRoutingFile,
  planRoutes,
  policyKindOf,
  routingKindOf,
  type PromptAdapter,
  type RoutePlan,
  type RoutingTable,
} from "./routing.js";

const RUN_USAGE =
  'usage: mola run "<task>" [--agent <id>] [--on <machine>] [--route <id>] [--kind <task-kind>] [--json]';

export type KindSource = "--kind" | "guessed" | "skill";
export type RouteSource = "flag" | "policy" | "picks" | "default";

/** The task kind of a bare `mola run` — no skill wraps it. */
const DEFAULT_TASK_KIND: TaskKind = "implement";

interface RunFlags {
  agent?: string;
  on?: string;
  route?: string;
  /** the model-routing task kind (config/model-routing.json); inferred from the prompt when absent */
  kind?: string;
}

/** The flags every mola run / skill command accepts. */
export function readRunFlags(flags: Record<string, string | boolean>): RunFlags {
  const out: RunFlags = {};
  if (typeof flags.agent === "string" && flags.agent.trim()) out.agent = flags.agent.trim();
  if (typeof flags.on === "string" && flags.on.trim()) out.on = flags.on.trim();
  if (typeof flags.route === "string" && flags.route.trim()) out.route = flags.route.trim();
  if (typeof flags.kind === "string" && flags.kind.trim()) out.kind = flags.kind.trim();
  return out;
}

/** The task text: the positionals joined (a quoted task may arrive as one token). */
export function taskText(positionals: string[]): string {
  return positionals.join(" ").trim();
}

interface PreparedRun {
  decision: RouteDecision;
  policy: Policy;
  adapter: HeadlessAgentAdapter;
  route: string;
  permissionProfile: string;
  approval: "interactive" | "batch-approved";
  budgetUsd?: number;
  visibleRoutes: Map<string, string[]>;
  /** which source chose the primary route */
  routeSource: RouteSource;
  /** the model layer: present when config/model-routing.json was found */
  routing?: {
    table: RoutingTable;
    kind: string;
    /** how the kind was chosen: the user's --kind, a guess from the prompt, or the skill command */
    kindSource: KindSource;
    /** the plan from the picks list; null when no pick survived the whitelist */
    plan: RoutePlan | null;
    /** the routes the quota ladder walks after the primary one */
    ladder: string[];
  };
}

/**
 * The routing half of `mola run`: filter, score, pick the route, check the
 * whitelist. Pure enough to test — the adapters are injected.
 */
export async function prepareRun(
  ctx: PluginContext,
  opts: {
    taskKind: TaskKind;
    prompt: string;
    flags: RunFlags;
    cwd: string;
    policy: Policy;
    visibleRoutes?: Map<string, string[]>;
    detect?: boolean;
    /** the model-routing table; defaults to the checkout's config/model-routing.json */
    routing?: RoutingTable | null;
    /** the routing task kind (from --kind, a skill command, or inferred) */
    routingKind?: string;
    /** how `routingKind` was chosen (recorded in decision.json) */
    kindSource?: KindSource;
  },
): Promise<PreparedRun> {
  const policy = opts.policy;
  const table = opts.routing === undefined ? loadRouting() : opts.routing;
  const routingKind =
    opts.routingKind ?? opts.flags.kind ?? inferKind(opts.prompt, table, routingKindOf(opts.taskKind));
  const kindSource: KindSource = opts.kindSource ?? (opts.flags.kind ? "--kind" : "guessed");
  if (table && !table.tasks[routingKind]) {
    throw new MolaError(
      "USAGE_ERROR",
      `unknown task kind "${routingKind}" (known: ${Object.keys(table.tasks).join(", ")})`,
      ExitCode.Usage,
      { kind: routingKind, known: Object.keys(table.tasks) },
    );
  }
  const visibleRoutes = opts.visibleRoutes ?? new Map<string, string[]>();

  const adapters = runnableAdapters(ctx.agents.list());
  if (adapters.length === 0) {
    throw new MolaError(
      "AGENT_NOT_FOUND",
      "no runnable agent adapters are registered (nothing to route to)",
      ExitCode.NoInput,
    );
  }
  if (opts.flags.agent && !adapters.some((a) => a.id === opts.flags.agent)) {
    throw new MolaError(
      "AGENT_NOT_FOUND",
      `unknown agent: ${opts.flags.agent}`,
      ExitCode.NoInput,
      { id: opts.flags.agent, known: adapters.map((a) => a.id) },
    );
  }

  const req: RouteRequest = {
    taskKind: opts.taskKind,
    prompt: opts.prompt,
    approval: approvalFor(opts.taskKind, policy),
    ...(opts.flags.agent ? { prefersAgent: opts.flags.agent } : {}),
    ...(opts.flags.on ? { prefersMachine: opts.flags.on } : {}),
    ...(policy.defaults.budgetUsdPerRun !== undefined
      ? { budgetUsd: policy.defaults.budgetUsdPerRun }
      : {}),
  };

  const candidates = await collectCandidates(adapters, { detect: opts.detect });
  const { kept, rejected } = filterCandidates(candidates, req);
  if (kept.length === 0) {
    const why = rejected.map((r) => `${r.id}: ${r.why}`).join("; ");
    throw new MolaError(
      "AGENT_NOT_FOUND",
      `no candidate agent for this task${why ? ` (${why})` : ""}`,
      ExitCode.NoInput,
      { rejected },
    );
  }

  // The route, by precedence: --route; else the user's own policy row for this
  // task kind (a policy row OVERRIDES the picks — it is the user's explicit
  // choice); else the first whitelisted pick of the model layer; else the policy
  // default. A policy row only applies when it belongs to the kind in play: a
  // kind guessed from the prompt never borrows the row of the default kind.
  const plan = table ? planRoutes(table, routingKind, policy.modelRoutes) : null;
  const rowApplies = !table || policyKindOf(routingKind) === opts.taskKind;
  const policyRow = rowApplies ? policy.routes.byTaskKind[opts.taskKind]?.route : undefined;
  const primaryRoute =
    opts.flags.route ?? policyRow ?? plan?.route ?? routeForTaskKind(opts.taskKind, policy, "group/smart-split");
  const routeSource: RouteSource = opts.flags.route
    ? "flag"
    : policyRow
      ? "policy"
      : plan
        ? "picks"
        : "default";
  const verdict = checkRoute(primaryRoute, policy.modelRoutes);
  if (!verdict.ok) {
    throw new MolaError(
      verdict.code ?? "POLICY_DENIED",
      verdict.message ?? `route "${primaryRoute}" is not allowed`,
      ExitCode.NoPerm,
      { route: primaryRoute, allowed: policy.modelRoutes.allowedHeadless, banned: policy.modelRoutes.bannedHeadless },
    );
  }

  // the agents' visible route sets (ADR-0003 §3 routeFit): the route must be
  // one an agent can actually pick. magpie is optional — when it cannot be
  // read the fit stays neutral (the router says so, it never guesses).
  const visible = visibleRoutes.size
    ? visibleRoutes
    : (await probeVisibleRoutesFor(ctx.process, kept.map((k) => k.id))).map;

  const ranked = scoreCandidates(kept, req, policy, primaryRoute, visible);
  const best = ranked[0];
  const fallbacks = ranked
    .slice(1, 3)
    .map((r) => ({ agent: r.id, modelRoute: primaryRoute }))
    .filter((f) => checkRoute(f.modelRoute, policy.modelRoutes).ok);

  const decision: RouteDecision = {
    agent: best.id,
    machine: best.machine,
    workspaceDir: opts.cwd,
    modelRoute: primaryRoute,
    fallbacks,
    reason: explain({
      taskKind: opts.taskKind,
      agent: best.id,
      machine: best.machine,
      modelRoute: primaryRoute,
      pinned: Boolean(opts.flags.agent || opts.flags.on || opts.flags.route),
    }),
    ranked: ranked.map((r) => ({
      agent: r.id,
      machine: r.machine,
      score: Number(r.score.toFixed(4)),
      reason: explain({
        taskKind: opts.taskKind,
        agent: r.id,
        machine: r.machine,
        modelRoute: primaryRoute,
      }),
    })),
  };

  return {
    decision,
    policy,
    adapter: best.adapter,
    route: primaryRoute,
    routeSource,
    permissionProfile: permissionProfileFor(opts.taskKind, policy),
    approval: req.approval,
    ...(req.budgetUsd !== undefined ? { budgetUsd: req.budgetUsd } : {}),
    visibleRoutes: visible,
    ...(table
      ? {
          routing: {
            table,
            kind: routingKind,
            kindSource,
            plan,
            // the picks after the primary, then the policy's alternateRoutes;
            // deduped and whitelist-filtered
            ladder: dedupe(
              allowedAlternates(policy, [
                ...(plan ? [plan.route, ...plan.ladder] : []),
                ...policy.fallback.alternateRoutes,
              ]),
            ).filter((r) => r !== primaryRoute),
          },
        }
      : {}),
  };
}

/**
 * The permission profile the adapter gets.
 *
 * BRIEF #7 / ADR-0003 §5: `full-auto` (claude `bypassPermissions`, codex
 * `danger-full-access`) is only allowed behind an approval — the policy's
 * `approval: batch-approved`, the `--yes` flag, or an interactive yes. Without
 * one the profile is downgraded to `workspace-write` and the downgrade is
 * reported, never silent.
 */
export function gatePermissionProfile(
  profile: string,
  opts: { approval: "interactive" | "batch-approved"; yes: boolean },
): { profile: string; downgraded: boolean } {
  if (profile !== "full-auto") return { profile, downgraded: false };
  if (opts.approval === "batch-approved" || opts.yes) return { profile, downgraded: false };
  return { profile: "workspace-write", downgraded: true };
}

/** The run request the adapter gets (the prompt is passed through verbatim). */
export function buildRunRequest(opts: {
  prompt: string;
  cwd: string;
  /** omitted when the route is not in the agent's magpie-visible set: the agent then uses its own model */
  modelRoute?: string;
  permissionProfile: string;
  budgetUsd?: number;
  runId: string;
  onEvent?: (e: HookEvent) => void;
}): RunRequest {
  return {
    prompt: opts.prompt,
    cwd: opts.cwd,
    ...(opts.modelRoute ? { modelRoute: opts.modelRoute } : {}),
    permissionProfile: opts.permissionProfile as RunRequest["permissionProfile"],
    ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
    runId: opts.runId,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  };
}

/**
 * The event stream: NDJSON on stderr (core §8.2 — stdout stays one envelope).
 *
 * The sink is injectable so a test can capture the stream instead of writing
 * to the real stderr; the production wiring writes to `process.stderr`.
 */
export function makeRunStream(opts: { write?: (line: string) => void } = {}): EventSink {
  return ndjsonSink(opts);
}

/**
 * The quota ladder walk (ADR-0003 §4). It re-runs the task with another
 * route/agent when the failure is quota-shaped; every step is recorded.
 *
 * The caller has already made the first attempt — the ladder continues from
 * there. `switch-route` walks every allowed alternate route; `switch-agent`
 * walks every fallback agent of the decision.
 */
function dedupe(routes: string[]): string[] {
  return routes.filter((r, i) => routes.indexOf(r) === i);
}

export async function runLadder(opts: {
  attempt: (agent: string, route: string) => Promise<RunResult>;
  primary: { agent: string; route: string };
  fallbacks: Array<{ agent: string; modelRoute: string }>;
  policy: Policy;
  wait: (provider: string, timeoutSec: number) => Promise<{ ok: boolean; detail?: string }>;
  quotaTimeoutSec?: number;
  /** the ladder routes of the model layer (picks, then the policy's alternateRoutes); when given they replace the policy's list */
  alternates?: string[];
}): Promise<{ result?: RunResult; attempts: LadderAttempt[]; exhausted: boolean }> {
  const { attempt, primary, policy } = opts;
  const attempts: LadderAttempt[] = [];
  const plan = planLadder(policy, opts.fallbacks.map((f) => f.agent), primary.route);
  const alternates = allowedAlternates(policy, opts.alternates ?? plan.alternateRoutes).filter(
    (r) => r !== primary.route,
  );

  const succeeded = (result: RunResult): boolean =>
    result.exitCode === 0 && !result.quotaFailure;

  for (const step of plan.steps) {
    if (step === "report") break;

    if (step === "retry-same-route-once") {
      const result = await attempt(primary.agent, primary.route);
      attempts.push({
        step,
        agent: primary.agent,
        modelRoute: primary.route,
        cause: "quota failure",
        ok: succeeded(result),
      });
      if (succeeded(result)) return { result, attempts, exhausted: false };
      continue;
    }

    if (step === "magpie-quota-wait") {
      const provider = providerOfRoute(primary.route);
      const w = await opts.wait(provider, opts.quotaTimeoutSec ?? 60);
      attempts.push({
        step,
        agent: primary.agent,
        modelRoute: primary.route,
        cause: "quota failure",
        ok: w.ok,
        detail: w.detail,
      });
      if (w.ok) {
        const result = await attempt(primary.agent, primary.route);
        attempts.push({
          step: "retry-same-route-once",
          agent: primary.agent,
          modelRoute: primary.route,
          cause: "after the quota window reset",
          ok: succeeded(result),
        });
        if (succeeded(result)) return { result, attempts, exhausted: false };
      }
      continue;
    }

    if (step === "switch-route") {
      for (const route of alternates) {
        const result = await attempt(primary.agent, route);
        attempts.push({
          step,
          agent: primary.agent,
          modelRoute: route,
          cause: "quota failure",
          ok: succeeded(result),
        });
        if (succeeded(result)) return { result, attempts, exhausted: false };
      }
      continue;
    }

    if (step === "switch-agent") {
      for (const fallback of opts.fallbacks) {
        const result = await attempt(fallback.agent, fallback.modelRoute);
        attempts.push({
          step,
          agent: fallback.agent,
          modelRoute: fallback.modelRoute,
          cause: "quota failure",
          ok: succeeded(result),
        });
        if (succeeded(result)) return { result, attempts, exhausted: false };
      }
      continue;
    }
  }

  const outcome = summarize(attempts);
  return { attempts: outcome.attempts, exhausted: outcome.exhausted };
}

/** The final answer of a run (the adapter's final text). */
function finalTextOf(result: RunResult | undefined): string {
  return result?.finalText ?? "";
}

export default definePlugin({
  activate(ctx: PluginContext) {
    // ------------------------------------------------------------ mola run
    ctx.commands.register({
      path: ["run"],
      description: "route a task to an agent (ADR-0003 filter + score, quota ladder)",
      async handler(args, io) {
        const task = taskText(args.positionals);
        if (!task) throw new MolaError("USAGE_ERROR", RUN_USAGE, ExitCode.Usage);
        const flags = readRunFlags(args.flags);
        const policy = loadPolicy(ctx.fs, io.cwd);
        for (const warning of policy.warnings) io.note(`mola: ${warning}`);

        const loaded = loadRoutingFile();
        if (loaded.warning) io.note(`mola: routing file: ${loaded.warning} — routing by policy only`);
        const table = loaded.table;
        // the guess only picks the model route; the permission/approval row
        // follows the default kind unless the user named one with --kind
        const routingKind = flags.kind ?? inferKind(task, table, routingKindOf(DEFAULT_TASK_KIND));
        const kindSource: KindSource = flags.kind ? "--kind" : "guessed";
        io.note(`mola: kind: ${routingKind} (${kindSource})`);
        const prepared = await prepareRun(ctx, {
          taskKind: flags.kind ? policyKindOf(routingKind) : DEFAULT_TASK_KIND,
          prompt: task,
          flags,
          cwd: io.cwd,
          policy,
          routing: table,
          routingKind,
          kindSource,
        });

        return executeRun(ctx, io, {
          prompt: task,
          prepared,
          runId: io.traceId,
          command: "run",
          argv: [task, ...flagArgs(flags)],
        });
      },
    });

    // ------------------------------------------------- mola skill commands
    for (const spec of SKILL_COMMANDS) {
      ctx.commands.register({
        path: [spec.command],
        description: spec.description,
        async handler(args, io) {
          const topic = taskText(args.positionals);
          if (!topic) {
            throw new MolaError(
              "USAGE_ERROR",
              `usage: mola ${spec.command} "<topic>" [--agent <id>] [--on <machine>] [--route <id>] [--json]`,
              ExitCode.Usage,
            );
          }
          const flags = readRunFlags(args.flags);
          const policy = loadPolicy(ctx.fs, io.cwd);
          for (const warning of policy.warnings) io.note(`mola: ${warning}`);

          const root = findMstackRoot({
            cwd: io.cwd,
            configSource: ctx.config.get<string>("skills.source"),
          });
          const path_ = skillFile(root, spec.skill);
          if (!path_) {
            io.note(
              `mola: skill ${spec.skill} not found under ${root ?? "<mstack repo>"} — the agent gets the procedure without the file`,
            );
          }
          const prompt = buildSkillPrompt(spec, topic, {
            cwd: io.cwd,
            ...(path_ ? { skillPath: path_ } : {}),
            statePaths: resolveStatePaths(spec, path_),
          });

          const loaded = loadRoutingFile();
          if (loaded.warning) io.note(`mola: routing file: ${loaded.warning} — routing by policy only`);
          const prepared = await prepareRun(ctx, {
            taskKind: spec.taskKind,
            prompt,
            flags,
            cwd: io.cwd,
            policy,
            routing: loaded.table,
            routingKind: flags.kind ?? routingKindOf(spec.taskKind),
            kindSource: flags.kind ? "--kind" : "skill",
          });

          return executeRun(ctx, io, {
            prompt,
            prepared,
            runId: io.traceId,
            command: spec.command,
            argv: [topic, ...flagArgs(flags)],
            skill: spec,
            ...(root ? { mstackRoot: root } : {}),
          });
        },
      });
    }
  },
});

/** The flags as argv entries (for the run record). */
function flagArgs(flags: RunFlags): string[] {
  const out: string[] = [];
  if (flags.agent) out.push("--agent", flags.agent);
  if (flags.on) out.push("--on", flags.on);
  if (flags.route) out.push("--route", flags.route);
  if (flags.kind) out.push("--kind", flags.kind);
  return out;
}

interface ExecuteRunOptions {
  prompt: string;
  prepared: PreparedRun;
  runId: string;
  command: string;
  argv: string[];
  skill?: SkillSpec;
  mstackRoot?: string;
  /** the NDJSON run-event sink (stderr by default; injectable for tests) */
  sink?: EventSink;
}

/**
 * The execution half of `mola run`: the pre-dispatch gate, the adapter call,
 * the quota ladder and the report.
 */
export async function executeRun(
  ctx: PluginContext,
  io: {
    json: boolean;
    quiet: boolean;
    yes: boolean;
    traceId: string;
    cwd: string;
    data(v: unknown): void;
    out(line: string): void;
    note(m: string): void;
  },
  opts: ExecuteRunOptions,
): Promise<ExitCode> {
  const { prepared, runId } = opts;
  const { decision, policy, adapter, routing } = prepared;
  const t0 = Date.now();
  // NDJSON on stderr only for --json and -v. Human mode gets a spinner instead.
  const streamEvents = io.json || verboseRequested();

  // the routing policy gate (policy-approval): route whitelist before any
  // worker starts (ADR-0003 §2; the rejection is the denial path, exit 77)
  const approved = (await ctx.events.runWaterfall(MolaEvents.TaskPreDispatch, {
    agent: decision.agent,
    machine: decision.machine,
    modelRoute: decision.modelRoute,
    task: opts.prompt,
    taskChars: opts.prompt.length,
    runId,
    cwd: io.cwd,
    command: opts.command,
    yes: io.yes,
  })) as { modelRoute: string };
  const route = approved.modelRoute ?? decision.modelRoute;
  // the prompt adapter of the first route (the family style); the ladder may
  // change route, and runOnce re-adapts the ORIGINAL prompt for each one
  const adaptedFor = (modelRoute: string): { prompt: string; adapter: PromptAdapter } =>
    adaptPrompt(routing?.table ?? null, modelRoute, opts.prompt);
  const firstAdapter = adaptedFor(route).adapter;
  const adaptersUsed: PromptAdapter[] = [];

  // BRIEF #7: full-auto needs an approval; without one it is downgraded and
  // the downgrade is said out loud (never silently).
  const gated = gatePermissionProfile(prepared.permissionProfile, {
    approval: prepared.approval,
    yes: io.yes,
  });
  if (gated.downgraded) {
    io.note(
      "mola: full-auto needs an approval (policy approval: batch-approved, or --yes) — running with workspace-write",
    );
  }

  // The router's own fact on the bus: this run was routed to agent X on
  // machine Y via route Z. The adapters emit their own mola.session.started
  // when the agent's session really begins; this one carries the routing
  // decision (agent + machine + modelRoute + cwd), which is what
  // .mstack/runs/<runId>/decision.json must name (ADR-0003 §3).
  //
  // The same envelope goes into the NDJSON stream on stderr: the routing
  // decision is the run's FIRST event, so a watcher of stderr sees which
  // agent/machine/route took the task before anything else happens.
  const routingEnvelope = makeEnvelope({
    kind: MolaEvents.SessionStarted,
    agent: decision.agent,
    machine: decision.machine,
    runId,
    data: {
      agent: decision.agent,
      machine: decision.machine,
      modelRoute: route,
      cwd: io.cwd,
      runId,
      command: opts.command,
      permissionProfile: gated.profile,
      approval: prepared.approval,
      reason: decision.reason,
      ...(routing
        ? { taskKind: routing.kind, kindSource: routing.kindSource, routeSource: prepared.routeSource, promptAdapter: firstAdapter, ladderRoutes: routing.ladder }
        : {}),
      ...(opts.skill ? { skill: opts.skill.skill } : {}),
    },
  });
  const decisionExtras = (): Record<string, unknown> =>
    routing
      ? {
          taskKind: routing.kind,
          kindSource: routing.kindSource,
          routeSource: prepared.routeSource,
          picks: routing.plan ? [routing.plan.route, ...routing.plan.ladder] : [],
          ladderRoutes: routing.ladder,
          promptAdapter: adaptersUsed[adaptersUsed.length - 1] ?? firstAdapter,
          promptAdapters: adaptersUsed.length ? adaptersUsed : [firstAdapter],
        }
      : {};
  if (routing) recordDecisionExtras(ctx, io.cwd, runId, decisionExtras());
  ctx.events.emit(
    MolaEvents.SessionStarted,
    routingEnvelope.data,
    { agent: decision.agent, machine: decision.machine, runId },
  );

  // The stream sink: every envelope the run produced passes through it, so it
  // is also the authoritative list of what the run emitted. The adapter's
  // `RunResult.events` is optional in the SDK — the stream is not.
  const streamed: HookEvent[] = [];
  const sink = opts.sink ?? (streamEvents ? makeRunStream() : () => {});
  const spin = streamEvents ? undefined : ioSpinner(io, `${decision.agent} · ${decision.machine} · ${route}`);
  spin?.start();
  // The permission profile the AGENT actually applied (ADR-0003 §5: the router
  // must know what is in effect, not only what it asked for). The adapters
  // report it in their own mola.session.started (`permissionMode`), and they
  // report `null` when the agent has no preset for the requested profile.
  let appliedPermissionProfile: string | null = null;
  let appliedProfileKnown = false;
  const emitToStream = (e: HookEvent): void => {
    if (e.kind === MolaEvents.SessionStarted && e.data && typeof e.data === "object") {
      const reported = (e.data as Record<string, unknown>).permissionMode;
      if (reported !== undefined) {
        appliedPermissionProfile = typeof reported === "string" ? reported : null;
        appliedProfileKnown = true;
      }
    }
    streamed.push(e);
    sink(e);
    if (spin) spin.update(progressLine(e));
  };
  emitToStream(routingEnvelope);
  const runOnce = async (agentId: string, modelRoute: string): Promise<RunResult> => {
    const target = agentId === decision.agent ? adapter : ctx.agents.get(agentId);
    if (!target || typeof (target as HeadlessAgentAdapter).run !== "function") {
      throw new MolaError(
        "AGENT_NOT_FOUND",
        `agent "${agentId}" is not runnable`,
        ExitCode.NoInput,
      );
    }
    const adapted = adaptedFor(modelRoute);
    adaptersUsed.push(adapted.adapter);
    const req = buildRunRequest({
      prompt: adapted.prompt,
      cwd: io.cwd,
      modelRoute,
      permissionProfile: gated.profile,
      ...(prepared.budgetUsd !== undefined ? { budgetUsd: prepared.budgetUsd } : {}),
      runId,
      onEvent: emitToStream,
    });
    return (target as HeadlessAgentAdapter).run(req);
  };

  let first: RunResult;
  try {
    first = await runOnce(decision.agent, route);
  } catch (err) {
    spin?.fail(`${decision.agent} failed`);
    throw err;
  }
  let result = first;
  let attempts: LadderAttempt[] = [];
  let exhausted = false;

  // a run that succeeded is never a quota failure, whatever its output mentions
  if (first.exitCode !== 0 && (first.quotaFailure || looksQuotaShaped(first))) {
    io.note(
      `mola: quota failure on ${decision.agent}/${route} (${first.quotaFailure?.status ?? "unknown"}) — walking the ADR-0003 §4 ladder`,
    );
    const walk = await runLadder({
      attempt: runOnce,
      primary: { agent: decision.agent, route },
      fallbacks: decision.fallbacks,
      policy,
      wait: makeQuotaWaitRunner(ctx.process).wait,
      ...(routing ? { alternates: routing.ladder } : {}),
    });
    attempts = walk.attempts;
    exhausted = walk.exhausted;
    if (walk.result) result = walk.result;
  }

  if (routing) recordDecisionExtras(ctx, io.cwd, runId, decisionExtras());

  // success wins: an agent that exited 0 delivered, whatever its output mentioned
  const exitCode: ExitCode =
    result.exitCode === 0
      ? ExitCode.Ok
      : ((result.exitCode || ExitCode.Error) as ExitCode);

  // The run's event kinds, in the order they were produced — the ADR-0004 §1
  // vocabulary the run actually emitted (the routing event plus the adapter's
  // tap). A consumer can assert the run produced the expected sequence
  // without reading the NDJSON stream.
  const kinds = eventKinds(streamed);

  ctx.state.set(`run:${runId}`, {
    runId,
    traceId: runId,
    command: opts.command,
    argv: opts.argv,
    agent: decision.agent,
    machine: decision.machine,
    modelRoute: route,
    exitCode: result.exitCode,
    eventKinds: kinds,
    ...(routing ? { taskKind: routing.kind, promptAdapter: adaptersUsed[adaptersUsed.length - 1] ?? firstAdapter } : {}),
    ...(opts.skill ? { skill: opts.skill.skill } : {}),
  });

  io.data({
    runId,
    traceId: runId,
    command: opts.command,
    agent: decision.agent,
    machine: decision.machine,
    modelRoute: route,
    permissionProfile: gated.profile,
    // what the agent ACTUALLY applied (null = the agent has no preset for the
    // requested profile) — the router never claims a profile it did not get
    ...(appliedProfileKnown ? { permissionProfileApplied: appliedPermissionProfile } : {}),
    approval: prepared.approval,
    workspaceDir: decision.workspaceDir,
    reason: decision.reason,
    ranked: decision.ranked,
    fallbacks: decision.fallbacks,
    ...(routing
      ? {
          taskKind: routing.kind,
          kindSource: routing.kindSource,
          routeSource: prepared.routeSource,
          routingFile: routing.table.file,
          picks: routing.plan ? [routing.plan.route, ...routing.plan.ladder] : [],
          droppedPicks: routing.plan?.dropped ?? [],
          ladderRoutes: routing.ladder,
          // the adapter of the first attempt, then the one of every retry
          promptAdapter: firstAdapter,
          promptAdapters: adaptersUsed,
        }
      : {}),
    exitCode: result.exitCode,
    sessionId: result.sessionId ?? null,
    finalText: finalTextOf(result),
    eventKinds: kinds,
    ...(result.quotaFailure && result.exitCode !== 0 ? { quotaFailure: result.quotaFailure } : {}),
    ...(attempts.length ? { ladder: attempts } : {}),
    ...(opts.skill ? { skill: opts.skill.skill } : {}),
    ...(opts.mstackRoot ? { mstackRoot: opts.mstackRoot } : {}),
  });

  spin?.stop();
  if (!io.json) {
    const text = finalTextOf(result);
    if (text) io.out(text);
    else io.note(`mola: no final answer (exit ${result.exitCode})`);
    if (exhausted) io.note("mola: the quota ladder is exhausted — no route or agent could take the task");
    // one line: agent, machine, route, duration, run id
    io.note(`${decision.agent} · ${decision.machine} · ${route} · ${formatDuration(Date.now() - t0)} · ${runId}`);
  }
  return exitCode;
}

/**
 * Put the model-layer facts into `.mstack/runs/<runId>/decision.json`. The
 * rec-runs recorder copies only its own fields from the bus events but keeps
 * every other field already in the file, so the extras are merged in here.
 * Best effort: a run is never failed by its own bookkeeping.
 */
function recordDecisionExtras(
  ctx: PluginContext,
  cwd: string,
  runId: string,
  extras: Record<string, unknown>,
): void {
  const file = path.join(cwd, ".mstack", "runs", runId, "decision.json");
  try {
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(ctx.fs.readFile(file)) as Record<string, unknown>;
    } catch {
      // first write
    }
    ctx.fs.writeFile(file, JSON.stringify({ ...current, ...extras }, null, 2) + "\n");
  } catch (err) {
    ctx.log.debug("cmd-run: could not record the decision extras", { error: String(err) });
  }
}

/** One line of human progress from a run event. Never more than one line. */
function progressLine(e: HookEvent): string {
  const data = (e.data ?? {}) as Record<string, unknown>;
  if (e.kind === "mola.agent.message") {
    const text = typeof data.textExcerpt === "string" ? data.textExcerpt : typeof data.text === "string" ? data.text : "";
    const one = text.replace(/\s+/g, " ").trim().slice(0, 72);
    return one || "agent message";
  }
  if (e.kind === "mola.session.started") {
    const agent = typeof data.agent === "string" ? data.agent : e.source.agent;
    const machine = typeof data.machine === "string" ? data.machine : e.source.machine;
    const modelRoute = typeof data.modelRoute === "string" ? data.modelRoute : "";
    return [agent, machine, modelRoute].filter(Boolean).join(" · ");
  }
  return e.kind.replace(/^mola\./, "").replace(/\./g, " ");
}

/**
 * Should the next route on the ladder be tried? Yes for a quota-shaped failure the adapter did not normalize,
 * and for a route that does not exist on this machine (a role group that was never created, or has no member):
 * the older picks behind it still work.
 */
export function looksQuotaShaped(result: RunResult): boolean {
  if (result.quotaFailure) return true;
  const text = `${result.finalText ?? ""}`;
  return (
    /\b402\b/.test(text) ||
    /\b429\b/.test(text) ||
    /rate\s*limit|insufficient.*(quota|balance|credit)/i.test(text) ||
    /unknown[_ ]model|no configured model|model[^.\n]{0,40}(not found|does not exist|not available)|no member ready/i.test(text)
  );
}

export {
  checkRoute,
  loadPolicy,
  routeForTaskKind,
  approvalFor,
  permissionProfileFor,
  collectCandidates,
  filterCandidates,
  scoreCandidates,
  runnableAdapters,
  machineMatches,
  routeFit,
  planLadder,
  allowedAlternates,
  providerOfRoute,
  makeQuotaWaitRunner,
  SKILL_COMMANDS,
  buildSkillPrompt,
  findMstackRoot,
  resolveStatePaths,
  skillFile,
  skillSpec,
  statePathsFromSkill,
  RUN_STREAM_EVENTS,
  eventKinds,
  makeEnvelope,
  ndjsonSink,
  recordingSink,
};
export { adaptPrompt, classifyKind, familyOf, judgeFamilyOf, inferKind, loadRouting, loadRoutingFile, planRoutes, policyKindOf, routingFilePath, routingKindOf } from "./routing.js";
export type { RoutingTable, RoutePlan, PromptAdapter } from "./routing.js";
export type { Policy, TaskKind, RouteDecision, RouteRequest, SkillSpec, LadderAttempt };
export type { EventSink } from "./stream.js";
