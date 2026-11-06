/**
 * tool-magpie (B1): magpie discovery + healthcheck, and the `mola agents`
 * command that merges PATH probes with `magpie ls`.
 *
 * magpie owns every agent's model list (BRIEF #3 / ADR-0003 §1). This plugin
 * only *reads* magpie (`magpie ls`, `magpie models <agent>`, `magpie <agent>`,
 * `magpie healthcheck`) and reports what it finds. Writing a model is
 * cmd-model's job, and it goes through magpie too.
 *
 * Doctor checks registered here (B1 acceptance #1):
 *   magpie.healthcheck — the gateway answers (exit 0)
 *   agent.<id>         — each agent CLI probed on PATH
 */

import type {
  AgentDetection,
  CheckResult,
  DoctorCheck,
  PluginContext,
  ToolAdapter,
  ToolProbe,
} from "@mola/plugin-sdk";
import { definePlugin, detectColor, MolaError, ExitCode, palette, statusGlyph, table } from "@mola/plugin-sdk";
import { AGENT_PROBES, mergeAgents, probeAgent, type AgentRecord } from "./agents.js";
import { createMagpieRunner, type MagpieRunner } from "./magpie.js";
import { parseMagpieLs, parseMagpieRoutes, visibleRouteNames, matchVisibleRoutes } from "./parse.js";

/** Shared magpie runner, one per plugin context (fresh per boot / per test). */
const runners = new WeakMap<PluginContext, MagpieRunner>();

function magpie(ctx: PluginContext): MagpieRunner {
  let r = runners.get(ctx);
  if (!r) {
    r = createMagpieRunner({ exec: ctx.process, timeoutMs: 30_000 });
    runners.set(ctx, r);
  }
  return r;
}

/**
 * The agent list: PATH probes merged with `magpie ls`.
 *
 * `magpieUnavailable` carries the reason magpie could not be read (it is
 * skipped, not fatal — the PATH probes still say what is installed). The
 * reason is surfaced as a clear message by the commands.
 */
async function readMagpieAgents(
  ctx: PluginContext,
): Promise<{ agents: AgentRecord[]; magpieUnavailable?: string }> {
  const res = await magpie(ctx).run(["ls"]);
  if (res.unavailable) {
    ctx.log.debug("magpie unavailable", { reason: res.unavailable });
    const agents = await mergeAgents(await probeAll(ctx), []);
    return { agents, magpieUnavailable: res.unavailable };
  }
  if (res.code !== 0) {
    ctx.log.debug("magpie ls failed", { code: res.code, stderr: res.stderr });
    const reason = res.stderr || `magpie ls exited ${res.code}`;
    const agents = await mergeAgents(await probeAll(ctx), []);
    return { agents, magpieUnavailable: reason };
  }
  const rows = parseMagpieLs(res.stdout);
  return { agents: mergeAgents(await probeAll(ctx), rows) };
}

async function probeAll(ctx: PluginContext) {
  return Promise.all(
    AGENT_PROBES.map(async (spec) => ({
      spec,
      detection: await probeAgent(spec, ctx.process),
    })),
  );
}

export default definePlugin({
  activate(ctx: PluginContext) {
    // ---------------------------------------------------------- tool adapter
    const magpieTool: ToolAdapter = {
      id: "magpie",
      async probe(): Promise<ToolProbe> {
        const res = await magpie(ctx).run(["healthcheck"]);
        if (res.unavailable) return { ok: false, detail: res.unavailable };
        return res.code === 0
          ? { ok: true, detail: "magpie gateway answers" }
          : { ok: false, detail: res.stderr || `magpie healthcheck exited ${res.code}` };
      },
    };
    ctx.tools.register(magpieTool);

    // ------------------------------------------------------- agent adapter
    // tool-magpie supplies the magpie side of agent discovery (SDK note on
    // AgentAdapter.detect): a probe of the magpie-managed agents.
    ctx.agents.register({
      id: "magpie",
      async detect(): Promise<AgentDetection> {
        const res = await magpie(ctx).run(["healthcheck"]);
        if (res.unavailable) return { available: false, health: "unknown", detail: res.unavailable };
        return {
          available: res.code === 0,
          managedByMagpie: true,
          health: res.code === 0 ? "ok" : "broken",
          detail: res.code === 0 ? "magpie gateway answers" : res.stderr || `exit ${res.code}`,
        };
      },
    });

    // -------------------------------------------------------- doctor checks
    const healthcheck: DoctorCheck = {
      id: "magpie.healthcheck",
      description: "magpie gateway answers (magpie healthcheck exits 0)",
      async run(): Promise<CheckResult> {
        const res = await magpie(ctx).run(["healthcheck"]);
        if (res.unavailable) {
          return {
            ok: false,
            message: `magpie not reachable: ${res.unavailable}`,
            exitCode: ExitCode.Unavailable,
          };
        }
        if (res.code === 0) return { ok: true, message: "magpie healthcheck ok" };
        return {
          ok: false,
          message: res.stderr || `magpie healthcheck exited ${res.code}`,
          exitCode: ExitCode.Unavailable,
        };
      },
    };
    ctx.doctor.registerCheck(healthcheck);

    for (const spec of AGENT_PROBES) {
      if (spec.id === "dsh") continue; // agent-dsh owns the agent.dsh check
      // agent.dsh is required (mola dispatches through it); the other CLIs are
      // optional — an absent or known-broken binary must not fail `mola
      // doctor` (B1 acceptance #1: exit 0 on a machine with magpie + dsh),
      // it is reported in the check message and in `mola agents list`.
      const required = spec.required ?? false;
      const check: DoctorCheck = {
        id: `agent.${spec.id}`,
        description: spec.machine
          ? `${spec.displayName} answers on ${spec.machine} (${spec.bin} --version)`
          : `${spec.displayName} CLI probe (${spec.bin} --version${required ? "" : "; optional"})`,
        async run(): Promise<CheckResult> {
          const detection = await probeAgent(spec, ctx.process);
          if (detection.available) {
            const version = detection.version ?? `${spec.bin} ok`;
            return { ok: true, message: spec.machine ? `${version} (${spec.machine})` : version };
          }
          if (detection.health === "broken") {
            const message = `broken — never routed (${detection.detail ?? "crashes on --version"})`;
            return required ? { ok: false, message, exitCode: ExitCode.Unavailable } : { ok: true, message };
          }
          const message = detection.detail ?? `${spec.bin} not found on PATH`;
          return required ? { ok: false, message, exitCode: ExitCode.Unavailable } : { ok: true, message: `${message} (optional)` };
        },
      };
      ctx.doctor.registerCheck(check);
    }

    // ------------------------------------------------------------ commands
    ctx.commands.register({
      path: ["agents", "list"],
      description: "discovered agents (PATH probe + `magpie ls` merge)",
      async handler(_args, io) {
        const { agents, magpieUnavailable } = await readMagpieAgents(ctx);
        if (magpieUnavailable) {
          // magpie is skipped, not fatal — the PATH probes still answer
          io.note(`magpie skipped: ${magpieUnavailable} (only PATH probes are shown)`);
        }
        io.data({ agents, magpieUnavailable: magpieUnavailable ?? null });
        if (!io.json) {
          const paint = palette(detectColor());
          const body = agents.map((a) => {
            const glyph = statusGlyph(a.health === "ok" ? "ok" : a.health === "broken" ? "fail" : "warn", paint);
            return [glyph, a.id, a.health ?? "unknown", a.model ?? "-", a.managedByMagpie ? "magpie" : a.source, a.machine];
          });
          for (const line of table({
            header: ["", "agent", "health", "route", "managed", "machine"],
            rows: body,
          })) {
            io.out(line);
          }
          if (agents.length === 0) io.out("(no agents detected)");
        }
        return ExitCode.Ok;
      },
    });

    ctx.commands.register({
      path: ["agents", "show"],
      description: "one agent: binary, version, magpie model route, config file",
      async handler(args, io) {
        const id = args.positionals[0];
        if (!id) {
          throw new MolaError("USAGE_ERROR", "usage: mola agents show <id>", ExitCode.Usage);
        }
        const { agents, magpieUnavailable } = await readMagpieAgents(ctx);
        if (magpieUnavailable) {
          io.note(`magpie skipped: ${magpieUnavailable} (only PATH probes are shown)`);
        }
        const agent = agents.find((a) => a.id === id || a.magpieId === id);
        if (!agent) {
          throw new MolaError(
            "AGENT_NOT_FOUND",
            `unknown agent: ${id}`,
            ExitCode.NoInput,
            { id, known: agents.map((a) => a.id) },
          );
        }
        io.data(agent);
        if (!io.json) {
          const paint = palette(detectColor());
          const glyph = statusGlyph(agent.health === "ok" ? "ok" : agent.health === "broken" ? "fail" : "warn", paint);
          const rows: Array<[string, string]> = [
            ["agent", agent.id],
            ["health", `${glyph}  ${agent.health ?? "unknown"}`],
            ["route", agent.model ?? "-"],
            ["machine", agent.machine],
            ["binary", agent.bin ?? "-"],
            ["managed", agent.managedByMagpie ? "magpie" : agent.source],
          ];
          if (agent.version) rows.push(["version", agent.version]);
          if (agent.configPath) rows.push(["config", agent.configPath]);
          if (agent.detail) rows.push(["detail", agent.detail]);
          for (const line of table({ rows })) io.out(line);
        }
        return ExitCode.Ok;
      },
    });

    // `mola agents routes <id>` — the route ids magpie shows this agent.
    ctx.commands.register({
      path: ["agents", "routes"],
      description: "the route ids magpie shows one agent (`magpie models <agent>`)",
      async handler(args, io) {
        const id = args.positionals[0];
        if (!id) {
          throw new MolaError("USAGE_ERROR", "usage: mola agents routes <id>", ExitCode.Usage);
        }
        const res = await magpie(ctx).run(["models", id]);
        if (res.unavailable) {
          throw new MolaError(
            "UPSTREAM_UNAVAILABLE",
            `cannot read routes for "${id}": ${res.unavailable}`,
            ExitCode.Unavailable,
          );
        }
        if (res.code !== 0) {
          throw new MolaError(
            "NO_INPUT",
            `magpie models ${id} failed: ${res.stderr || `exit ${res.code}`}`,
            ExitCode.NoInput,
          );
        }
        const routes = parseMagpieRoutes(res.stdout);
        const visible = matchVisibleRoutes(visibleRouteNames(res.stdout), routes);
        io.data({ agent: id, routes, visible });
        if (!io.json) {
          for (const r of routes) io.out(`${r}\t${visible.includes(r) ? "visible" : ""}`.trimEnd());
        }
        return ExitCode.Ok;
      },
    });
  },
});

export type { AgentRecord };
export { AGENT_PROBES, mergeAgents, probeAgent } from "./agents.js";
export { createMagpieRunner, stripLogNoise, magpieCandidates } from "./magpie.js";
export {
  agentIdFromName,
  extractFields,
  extractModel,
  machineOf,
  matchVisibleRoutes,
  parseMagpieAgent,
  parseMagpieLs,
  parseMagpieRoutes,
  visibleRouteNames,
} from "./parse.js";
