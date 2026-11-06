/**
 * tool-superagent (B2f): control of the two dsh-superagent bots from mola.
 *
 * Ground truth: cli/design/inputs/superagent-ops.md — both bots run in WSL,
 * each with a Management API at 127.0.0.1 (layerfs :3082, cad2gis :3083,
 * overridable in ~/.mola/config.jsonc under `superagent.instances`); every
 * request carries the header `x-orchestrator-request: 1`.
 *
 * Surfaces:
 *  - `mola superagent status [name]`  — setup problem (with its code and the
 *    exact fix hint), health parts, load, paused. Exit mirrors the WSL
 *    `dsh-superagent status` contract: 0 ok, 2 a part reports an error, 3
 *    waiting for setup, 69 unreachable.
 *  - `mola superagent tickets [name]` — per-Source state, stats, dropped
 *    messages, Source problems.
 *  - `mola superagent pause|resume [name]` and
 *    `mola superagent retry|stop <ticket> [name]` — mutations. Every mutation
 *    is approval-gated through the `mola.tool.before` policy waterfall unless
 *    `--yes` / MOLA_YES=1 (core §3): the gate below denies (exit 77), and the
 *    decision is recorded as `mola.approval.granted` / `.denied` on the bus.
 *  - the `superagent.<name>` doctor checks — they FAIL with the
 *    setup.problem code + detail + fix (today both bots report
 *    agentCliSignedOut / repositoryUnset: doctor must surface that).
 *  - the `superagent` ToolAdapter — `mola run` routes tickets through
 *    ctx.tools.get("superagent") in a later step.
 */

import type {
  CheckResult,
  DoctorCheck,
  PluginContext,
  ToolAdapter,
  ToolProbe,
} from "@mola/plugin-sdk";
import { definePlugin, ExitCode, MolaError, MolaEvents, PolicyDenial } from "@mola/plugin-sdk";
import { SuperagentApi, type FetchLike, type SuperagentSource, type SuperagentState } from "./api.js";
import { resolveInstances, type SuperagentInstance } from "./config.js";
import { interpretState, statusExitCode, type InstanceReport, type StatusReport } from "./report.js";

// ------------------------------------------------------------------ plumbing

/**
 * Per-context fetch override (tests mock HTTP here; nothing in production
 * calls this). Mirrors the per-context runner pattern of tool-magpie.
 */
const fetchOverrides = new WeakMap<PluginContext, FetchLike>();

/** Test seam: make every superagent API call of this context use `fetch`. */
export function injectFetch(ctx: PluginContext, fetch: FetchLike): void {
  fetchOverrides.set(ctx, fetch);
}

function apiFor(ctx: PluginContext, inst: SuperagentInstance): SuperagentApi {
  const fetch = fetchOverrides.get(ctx);
  return new SuperagentApi({ baseUrl: inst.url, ...(fetch ? { fetch } : {}) });
}

/** Resolve the instances a command targets: one named, or all configured. */
function pickInstances(ctx: PluginContext, positionals: string[], usage: string): SuperagentInstance[] {
  if (positionals.length > 1) {
    throw new MolaError("USAGE_ERROR", usage, ExitCode.Usage);
  }
  const all = resolveInstances(ctx.config);
  if (positionals.length === 0) return all;
  const name = positionals[0];
  const found = all.find((i) => i.name === name);
  if (!found) {
    throw new MolaError(
      "NO_INPUT",
      `unknown superagent instance "${name}" (configured: ${all.map((i) => i.name).join(", ")})`,
      ExitCode.NoInput,
      { name, known: all.map((i) => i.name) },
    );
  }
  return [found];
}

async function collectState(ctx: PluginContext, inst: SuperagentInstance): Promise<StatusReport> {
  try {
    const state = await apiFor(ctx, inst).state();
    return interpretState(inst.name, inst.url, inst.port, state);
  } catch (err) {
    return {
      name: inst.name,
      url: inst.url,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --------------------------------------------------------------------- gate

interface SuperagentMutationCall {
  tool?: string;
  /** "pause" | "resume" | "retry" | "stop" */
  mutation?: string;
  yes?: boolean;
}

/**
 * The approval gate for superagent mutations. It rides the same
 * `mola.tool.before` waterfall policy-approval listens on, and denies by
 * itself: pausing a bot or stopping a ticket is outward-facing state change,
 * so `--yes` (or MOLA_YES=1) must have been given explicitly. Read-only
 * commands (status, tickets) never pass a `mutation` and pass untouched.
 */
function gateMutations(ctx: PluginContext): void {
  ctx.events.hook(MolaEvents.ToolBefore, (value) => {
    const call = (value ?? {}) as SuperagentMutationCall;
    if (call.tool !== "superagent" || !call.mutation) return value;
    const rule = `superagent.${call.mutation}`;
    if (call.yes) {
      ctx.events.emit(MolaEvents.ApprovalGranted, { action: rule, rule, approver: "--yes" });
      return value;
    }
    ctx.events.emit(MolaEvents.ApprovalDenied, {
      action: rule,
      rule,
      reason: `policy: superagent ${call.mutation} changes the bot for the whole team — rerun with --yes (or MOLA_YES=1) or ask the human`,
    });
    throw new PolicyDenial(
      `policy: superagent ${call.mutation} requires approval — rerun with --yes (or MOLA_YES=1) or ask the human`,
      { rule },
    );
  });
}

// -------------------------------------------------------------- doctor check

function instanceCheck(ctx: PluginContext, inst: SuperagentInstance): DoctorCheck {
  return {
    id: `superagent.${inst.name}`,
    description: `dsh-superagent ${inst.name} Management API at ${inst.url} (setup + health)`,
    async run(): Promise<CheckResult> {
      let state: SuperagentState;
      try {
        state = await apiFor(ctx, inst).state();
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          exitCode: ExitCode.Unavailable,
        };
      }
      const report = interpretState(inst.name, inst.url, inst.port, state);
      if (!report.setup.ok) {
        const p = report.setup.problem!;
        return {
          ok: false,
          message:
            `setup incomplete: ${p.code ?? "unknown"} (${p.detail ?? "no detail"}) — fix: ${report.setup.fixHint}`,
          exitCode: ExitCode.Unavailable,
        };
      }
      if (report.healthProblems.length > 0) {
        const parts = report.healthProblems
          .map((h) => `${h.name}: ${h.state} — ${h.detail ?? "no detail"}`)
          .join("; ");
        return {
          ok: false,
          message: `${parts} (a restart will not fix this — see cli/design/inputs/superagent-ops.md)`,
          exitCode: ExitCode.Unavailable,
        };
      }
      const load = report.load;
      return {
        ok: true,
        message:
          `setup ok, ${load.running ?? "?"}/${load.maxWorkers ?? "?"} workers, ` +
          `${load.queued ?? 0} queued${report.paused ? ", paused" : ""}`,
      };
    },
  };
}

// -------------------------------------------------------------- tool adapter

export interface SuperagentToolAdapter extends ToolAdapter {
  /** the configured instances (config read at call time) */
  instances(): SuperagentInstance[];
  /** a client for one instance (fetch override respected) */
  api(inst: SuperagentInstance): SuperagentApi;
}

function makeAdapter(ctx: PluginContext): SuperagentToolAdapter {
  return {
    id: "superagent",
    instances: () => resolveInstances(ctx.config),
    api: (inst) => apiFor(ctx, inst),
    async probe(): Promise<ToolProbe> {
      const instances = resolveInstances(ctx.config);
      const problems: string[] = [];
      for (const inst of instances) {
        try {
          const state = await apiFor(ctx, inst).state();
          const report = interpretState(inst.name, inst.url, inst.port, state);
          if (!report.setup.ok) {
            const p = report.setup.problem!;
            problems.push(`${inst.name}: setup incomplete: ${p.code ?? "unknown"} (${p.detail ?? "no detail"})`);
          }
        } catch (err) {
          problems.push(
            `${inst.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (problems.length === 0) {
        return { ok: true, detail: `${instances.length} instance(s) ready (${instances.map((i) => i.name).join(", ")})` };
      }
      // a bot that cannot accept tickets is not usable for routing — but the
      // detail says exactly which setup step is missing
      return { ok: false, detail: problems.join("; ") };
    },
  };
}

// ------------------------------------------------------------------ commands

const USAGE_STATUS = "usage: mola superagent status [name]";
const USAGE_TICKETS = "usage: mola superagent tickets [name]";
const USAGE_PAUSE = "usage: mola superagent pause|resume [name]";

function humanStatusLine(report: StatusReport): string[] {
  if (!report.reachable) {
    return [`${report.name}\t${report.url}\tUNREACHABLE — ${report.error}`];
  }
  const r = report as InstanceReport;
  const lines = [
    `${r.name}\t${r.url}\t${r.paused ? "PAUSED" : "running"}\t` +
      `load ${r.load.running ?? "?"}/${r.load.maxWorkers ?? "?"} workers, ${r.load.queued ?? 0} queued` +
      (r.load.busy ? " (busy — not broken)" : ""),
  ];
  if (!r.setup.ok) {
    const p = r.setup.problem!;
    lines.push(`  setup: ${p.code ?? "unknown"}${p.place ? ` (${p.place})` : ""} — ${p.detail ?? "no detail"}`);
    lines.push(`  fix:   ${r.setup.fixHint}`);
  }
  for (const h of r.healthProblems) {
    lines.push(`  ${h.name}: ${h.state} — ${h.detail ?? "no detail"}`);
  }
  if (r.setup.ok && r.healthProblems.length === 0) {
    lines.push(`  setup ok, all health parts ready`);
  }
  return lines;
}

export default definePlugin({
  activate(ctx: PluginContext) {
    gateMutations(ctx);
    const adapter = makeAdapter(ctx);
    ctx.tools.register(adapter);
    for (const inst of resolveInstances(ctx.config)) {
      ctx.doctor.registerCheck(instanceCheck(ctx, inst));
    }

    // ------------------------------------------------- superagent status
    ctx.commands.register({
      path: ["superagent", "status"],
      description: "dsh-superagent bots: setup problem, health parts, load, paused",
      async handler(args, io) {
        const instances = pickInstances(ctx, args.positionals, USAGE_STATUS);
        const reports = await Promise.all(instances.map((inst) => collectState(ctx, inst)));
        io.data({ instances: reports });
        if (!io.json) {
          for (const report of reports) {
            for (const line of humanStatusLine(report)) io.out(line);
          }
        }
        return statusExitCode(reports) as ExitCode;
      },
    });

    // ------------------------------------------------ superagent tickets
    ctx.commands.register({
      path: ["superagent", "tickets"],
      description: "dsh-superagent Sources: state, stats, problems, dropped messages",
      async handler(args, io) {
        const instances = pickInstances(ctx, args.positionals, USAGE_TICKETS);
        const reports: Array<{
          name: string;
          url: string;
          reachable: boolean;
          error?: string;
          sources?: SuperagentSource[];
        }> = [];
        for (const inst of instances) {
          try {
            reports.push({ name: inst.name, url: inst.url, reachable: true, sources: await apiFor(ctx, inst).sources() });
          } catch (err) {
            reports.push({
              name: inst.name,
              url: inst.url,
              reachable: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        io.data({ instances: reports });
        if (!io.json) {
          for (const report of reports) {
            if (!report.reachable) {
              io.out(`${report.name}\t${report.url}\tUNREACHABLE — ${report.error}`);
              continue;
            }
            for (const src of report.sources ?? []) {
              const problem = src.problem ? ` — ${src.problem.code ?? "unknown"}: ${src.problem.detail ?? ""}` : "";
              io.out(
                `${report.name}\t${src.id}\t${src.state ?? "?"}\t` +
                  `received=${src.stats?.received ?? 0} filtered=${src.stats?.filtered ?? 0} dropped=${src.dropped?.length ?? 0}` +
                  problem,
              );
            }
          }
        }
        return (reports.some((r) => !r.reachable) ? ExitCode.Unavailable : ExitCode.Ok) as ExitCode;
      },
    });

    // -------------------------------------------- superagent pause/resume
    for (const [action, paused] of [
      ["pause", true],
      ["resume", false],
    ] as const) {
      ctx.commands.register({
        path: ["superagent", action],
        description: `${action} a dsh-superagent bot's executor (approval-gated unless --yes)`,
        async handler(args, io) {
          const instances = pickInstances(ctx, args.positionals, USAGE_PAUSE);
          await gate(ctx, io, action, instances);
          for (const inst of instances) {
            await apiFor(ctx, inst).setPaused(paused);
          }
          io.data({ action, paused, instances: instances.map((i) => ({ name: i.name, url: i.url })) });
          if (!io.json) {
            for (const inst of instances) io.out(`${inst.name}: ${action}d (${inst.url})`);
          }
          return ExitCode.Ok;
        },
      });
    }

    // -------------------------------------------- superagent retry / stop
    for (const action of ["retry", "stop"] as const) {
      const usage = `usage: mola superagent ${action} <ticket> [name]`;
      ctx.commands.register({
        path: ["superagent", action],
        description: `${action} one Ticket (approval-gated unless --yes); unnamed → every instance in turn`,
        async handler(args, io) {
          const ticket = args.positionals[0];
          if (!ticket) throw new MolaError("USAGE_ERROR", usage, ExitCode.Usage);
          const instances = pickInstances(ctx, args.positionals.slice(1), usage);
          await gate(ctx, io, action, instances);

          // Ticket ids are instance-local: with no instance named, try each
          // configured instance in order and stop at the first success.
          let lastError: unknown;
          for (const inst of instances) {
            const api = apiFor(ctx, inst);
            try {
              if (action === "retry") await api.retryTicket(ticket);
              else await api.stopTicket(ticket);
              io.data({ action, ticket, instance: inst.name, url: inst.url, ok: true });
              if (!io.json) io.out(`${action}: ${ticket} on ${inst.name} (${inst.url}) ok`);
              ctx.events.emit(MolaEvents.ToolAfter, {
                callId: io.traceId,
                tool: "superagent",
                mutation: action,
                ticket,
                instance: inst.name,
                ok: true,
              });
              return ExitCode.Ok;
            } catch (err) {
              lastError = err;
            }
          }
          throw lastError;
        },
      });
    }
  },
});

/** Run the mutation through the mola.tool.before policy waterfall. */
async function gate(
  ctx: PluginContext,
  io: { traceId: string; yes: boolean },
  action: string,
  instances: SuperagentInstance[],
): Promise<void> {
  await ctx.events.runWaterfall(MolaEvents.ToolBefore, {
    tool: "superagent",
    argv: ["superagent", action, ...instances.map((i) => i.name)],
    argsSummary: `superagent ${action} ${instances.map((i) => `${i.name}(${i.url})`).join(", ")}`,
    callId: io.traceId,
    mutation: action,
    yes: io.yes,
  });
}

export { resolveInstances, setupHint } from "./config.js";
export { SuperagentApi } from "./api.js";
export { interpretState, statusExitCode } from "./report.js";
export type { SuperagentInstance } from "./config.js";
export type {
  SuperagentState,
  SuperagentSource,
  SuperagentHealthPart,
  SuperagentProblem,
} from "./api.js";
export type { InstanceReport, StatusReport } from "./report.js";
