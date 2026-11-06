/**
 * cmd-dash (B2e): `mola dash [--watch [seconds]] [--json]` — one screen of
 * what mola already knows. It does not re-probe on its own:
 *
 *   Agents       ctx.agents  (each adapter's detect())
 *   Superagents  ctx.tools "superagent" (instances + api + interpretState)
 *   Recent runs  the rec-runs index in the state store (run:<id>)
 *   Health       the doctor checks magpie / rtk / git / gh
 *
 * --json is one snapshot envelope. --watch redraws on a TTY (default 5s)
 * until Ctrl-C; off a TTY it prints once, so pipes and tests don't loop.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { AgentDetection, DoctorCheck, PluginContext } from "@mola/plugin-sdk";
import {
  definePlugin,
  detectColor,
  ExitCode,
  formatDuration,
  MolaError,
  palette,
  statusGlyph,
  table,
  type Palette,
  type Status,
} from "@mola/plugin-sdk";
import { openStateStore, type StateStore } from "@mola/core";
import { interpretState, type SuperagentToolAdapter } from "@mola/plugin-tool-superagent";

const USAGE = "usage: mola dash [--watch [seconds]] [--json]";
const REC_PLUGIN = "mola-rec-runs";
const HEALTH_IDS = ["magpie.healthcheck", "tool.rtk", "tool.git", "tool.gh"] as const;
const RUN_LIMIT = 8;

export interface DashAgent {
  id: string;
  health: "ok" | "broken" | "unknown";
  available: boolean;
  detail?: string;
  version?: string;
}

export interface DashSuper {
  name: string;
  url: string;
  reachable: boolean;
  error?: string;
  paused?: boolean;
  setupOk?: boolean;
  /** setup problem, "code — detail" */
  problem?: string;
  fix?: string;
  /** health parts in state "error", joined */
  healthNote?: string;
  running?: number;
  max?: number;
  queued?: number;
  /** source count from the Management API (it has no ticket-list call) */
  tickets?: number;
}

export interface DashRun {
  time: string;
  agent: string;
  route: string;
  exit: string;
  duration: string;
  runId: string;
}

export interface DashHealth {
  id: string;
  ok: boolean;
  message?: string;
  missing?: boolean;
}

export interface DashSnapshot {
  agents: DashAgent[];
  superagents: DashSuper[];
  runs: DashRun[];
  health: DashHealth[];
}

/** `--watch` → 5, `--watch N` → N, absent → not watching. */
export function watchInterval(flag: string | boolean | undefined): number | undefined {
  if (flag === undefined || flag === false) return undefined;
  if (flag === true) return 5;
  const n = Number(flag);
  if (!Number.isFinite(n) || n <= 0) {
    throw new MolaError("USAGE_ERROR", `${USAGE} — watch interval must be a positive number of seconds`, ExitCode.Usage);
  }
  return n;
}

function agentHealth(d: AgentDetection): DashAgent["health"] {
  if (d.health === "ok" || d.health === "broken" || d.health === "unknown") return d.health;
  return d.available ? "ok" : "unknown";
}

async function readAgents(ctx: PluginContext): Promise<DashAgent[]> {
  const rows = await Promise.all(
    ctx.agents.list().map(async (adapter) => {
      try {
        const d = await adapter.detect();
        return {
          id: adapter.id,
          health: agentHealth(d),
          available: d.available,
          ...(d.detail ? { detail: d.detail } : {}),
          ...(d.version ? { version: d.version } : {}),
        };
      } catch (err) {
        return {
          id: adapter.id,
          health: "broken" as const,
          available: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

async function readSuperagents(ctx: PluginContext): Promise<DashSuper[]> {
  const tool = ctx.tools.get("superagent") as SuperagentToolAdapter | undefined;
  if (!tool || typeof tool.instances !== "function" || typeof tool.api !== "function") return [];
  return Promise.all(
    tool.instances().map(async (inst): Promise<DashSuper> => {
      try {
        const api = tool.api(inst);
        const state = await api.state();
        const report = interpretState(inst.name, inst.url, inst.port, state);
        let tickets: number | undefined;
        try {
          // no ticket-list endpoint exists: report the messages the Sources received instead
          const sources = (await api.sources()) as Array<{ stats?: { received?: number } }>;
          tickets = sources.reduce((n, s) => n + (typeof s.stats?.received === "number" ? s.stats.received : 0), 0);
        } catch {
          tickets = undefined;
        }
        const problem = report.setup.problem;
        const healthNote = report.healthProblems
          .map((h) => `${h.name}: ${h.state ?? "?"}${h.detail ? ` — ${h.detail}` : ""}`)
          .join("; ");
        return {
          name: inst.name,
          url: inst.url,
          reachable: true,
          paused: report.paused,
          setupOk: report.setup.ok,
          ...(problem
            ? {
                problem: `${problem.code ?? "unknown"}${problem.detail ? ` — ${problem.detail}` : ""}`,
                ...(report.setup.fixHint ? { fix: report.setup.fixHint } : {}),
              }
            : {}),
          ...(healthNote ? { healthNote } : {}),
          running: report.load.running,
          max: report.load.maxWorkers,
          queued: report.load.queued,
          ...(tickets !== undefined ? { tickets } : {}),
        };
      } catch (err) {
        return {
          name: inst.name,
          url: inst.url,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

function readRuns(store: StateStore, limit = RUN_LIMIT): DashRun[] {
  const ns = store.namespace(REC_PLUGIN);
  const rows: Array<Record<string, unknown>> = [];
  for (const key of ns.keys()) {
    if (!key.startsWith("run:")) continue;
    const entry = ns.get<Record<string, unknown>>(key);
    // only agent runs (run / dispatch): other commands are recorded too, without an agent
    if (entry && typeof entry.runId === "string" && typeof entry.agent === "string" && entry.agent) rows.push(entry);
  }
  rows.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  return rows.slice(0, limit).map((entry) => ({
    time: String(entry.startedAt ?? "").replace("T", " ").slice(0, 19) || "-",
    agent: typeof entry.agent === "string" && entry.agent ? entry.agent : "-",
    route: typeof entry.modelRoute === "string" && entry.modelRoute ? entry.modelRoute : "-",
    exit: entry.exitCode === undefined || entry.exitCode === null ? "-" : String(entry.exitCode),
    duration: formatDuration(typeof entry.durationMs === "number" ? entry.durationMs : undefined),
    runId: String(entry.runId),
  }));
}

function openRuns(): StateStore | undefined {
  const home = process.env.MOLA_HOME || path.join(os.homedir(), ".mola");
  try {
    return openStateStore(home);
  } catch {
    return undefined;
  }
}

async function readHealth(checks: DoctorCheck[]): Promise<DashHealth[]> {
  const out: DashHealth[] = [];
  for (const id of HEALTH_IDS) {
    const check = checks.find((c) => c.id === id);
    if (!check) {
      out.push({ id, ok: false, missing: true, message: "not registered" });
      continue;
    }
    try {
      const result = await check.run();
      out.push({ id, ok: result.ok, ...(result.message ? { message: result.message } : {}) });
    } catch (err) {
      out.push({ id, ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export async function collectDash(
  ctx: PluginContext,
  runs: () => DashRun[] = () => {
    const store = openRuns();
    return store ? readRuns(store) : [];
  },
): Promise<DashSnapshot> {
  const [agents, superagents, health] = await Promise.all([
    readAgents(ctx),
    readSuperagents(ctx),
    readHealth(ctx.doctor.list()),
  ]);
  return { agents, superagents, runs: runs(), health };
}

function glyphFor(status: Status, p: Palette): string {
  return statusGlyph(status, p);
}

/** The human screen. `color` defaults off so tests and pipes stay plain. */
export function renderDash(snap: DashSnapshot, color = false): string[] {
  const p = palette(color);
  const lines: string[] = [p.bold("mola dash"), ""];

  lines.push(p.bold("Agents"));
  if (snap.agents.length === 0) lines.push("  (no agents registered)");
  else {
    lines.push(
      ...table({
        header: ["", "agent", "health", "detail"],
        indent: "  ",
        rows: snap.agents.map((a) => [
          glyphFor(a.health === "ok" ? "ok" : a.health === "broken" ? "fail" : "warn", p),
          a.id,
          a.health,
          a.detail ?? a.version ?? "",
        ]),
      }),
    );
  }

  lines.push("", p.bold("Superagents"));
  if (snap.superagents.length === 0) lines.push("  (no superagent tool registered)");
  else {
    for (const s of snap.superagents) {
      if (!s.reachable) {
        lines.push(`  ${glyphFor("fail", p)}  ${s.name}  ${s.url}  UNREACHABLE — ${s.error ?? ""}`);
        continue;
      }
      const bad = s.setupOk === false || Boolean(s.healthNote);
      const glyph = glyphFor(bad ? "fail" : s.paused ? "warn" : "ok", p);
      const setup = s.setupOk === false ? s.problem ?? "setup problem" : "setup ok";
      const load = `load ${s.running ?? "?"}/${s.max ?? "?"}  queued ${s.queued ?? 0}  received ${s.tickets ?? "?"}`;
      lines.push(`  ${glyph}  ${s.name}  ${s.paused ? "paused" : "running"}  ${setup}  ${load}`);
      if (s.fix) lines.push(`     fix: ${s.fix}`);
      if (s.healthNote) lines.push(`     ${s.healthNote}`);
    }
  }

  lines.push("", p.bold("Recent runs"));
  if (snap.runs.length === 0) lines.push("  (no recorded runs)");
  else {
    lines.push(
      ...table({
        header: ["time", "agent", "route", "exit", "duration", "run"],
        indent: "  ",
        rows: snap.runs.map((r) => [r.time, r.agent, r.route, r.exit, r.duration, r.runId.slice(0, 12)]),
      }),
    );
  }

  lines.push("", p.bold("Health"));
  const health = [...snap.health.filter((h) => !h.ok), ...snap.health.filter((h) => h.ok)];
  lines.push(
    ...table({
      indent: "  ",
      rows: health.map((h) => [
        glyphFor(h.missing ? "warn" : h.ok ? "ok" : "fail", p),
        h.id,
        h.message ?? (h.ok ? "ok" : "fail"),
      ]),
    }),
  );
  return lines;
}

function sleep(ms: number, aborted: () => boolean): Promise<void> {
  const step = 100;
  return new Promise((resolve) => {
    let left = ms;
    const tick = () => {
      if (left <= 0 || aborted()) {
        resolve();
        return;
      }
      const wait = Math.min(step, left);
      left -= wait;
      setTimeout(tick, wait);
    };
    tick();
  });
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["dash"],
      description: "one screen: agents, superagents, recent runs, health",
      async handler(args, io) {
        if (args.positionals.length > 0) throw new MolaError("USAGE_ERROR", USAGE, ExitCode.Usage);
        const seconds = watchInterval(args.flags.watch);
        const store = openRuns();
        const runs = () => (store ? readRuns(store) : []);
        const paint = !io.json && detectColor();

        const once = async (): Promise<DashSnapshot> => collectDash(ctx, runs);

        // --json is one snapshot envelope, watch or not. stdout stays one document.
        if (io.json) {
          io.data(await once());
          return ExitCode.Ok;
        }

        const draw = async () => {
          for (const line of renderDash(await once(), paint)) io.out(line);
        };

        if (seconds === undefined || process.stdout.isTTY !== true) {
          await draw();
          return ExitCode.Ok;
        }

        let stop = false;
        const onSigint = () => {
          stop = true;
        };
        process.on("SIGINT", onSigint);
        try {
          while (!stop) {
            process.stdout.write("\x1b[2J\x1b[H");
            await draw();
            await sleep(seconds * 1000, () => stop);
          }
        } finally {
          process.off("SIGINT", onSigint);
        }
        return ExitCode.Ok;
      },
    });
  },
});
