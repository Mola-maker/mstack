/**
 * herdr (github.com/herdrdev/herdr) keeps coding agents' terminals running and marks each pane working, blocked or
 * idle. mstack meets it in two places:
 *
 *  - `herdrAgents()` reads herdr's agent list, so the web console and the TUI can show herdr's agents beside
 *    mstack's own runs.
 *  - `reportRunToHerdr()` tells herdr what a `mola` run inside a herdr pane is doing, so the run shows up in herdr's
 *    sidebar and `herdr agent wait` works on it.
 *
 * Both talk to the `herdr` CLI, which speaks herdr's socket API; nothing here opens the socket itself. Both are
 * silent when herdr is not installed or not running: herdr is optional.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunProgress } from "./progress.js";

export interface HerdrAgent {
  pane: string;
  workspace: string;
  /** the name given with `herdr agent rename`, or null */
  name: string | null;
  /** which agent runs there: "claude", "codex", "mola", … */
  agent: string | null;
  status: "idle" | "working" | "blocked" | "done" | "unknown";
  cwd: string | null;
  title: string | null;
}

export type HerdrState =
  | { state: "absent" }
  | { state: "stopped" }
  | { state: "error"; message: string }
  | { state: "running"; agents: HerdrAgent[] };

/** The herdr executable: HERDR_BIN_PATH (set inside a herdr pane), PATH, then the per-user install directory. */
export function locateHerdr(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HERDR_BIN_PATH && fs.existsSync(env.HERDR_BIN_PATH)) return env.HERDR_BIN_PATH;
  const exe = process.platform === "win32" ? "herdr.exe" : "herdr";
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Programs", "herdr"));
  if (env.HOME) dirs.push(path.join(env.HOME, ".local", "bin"));
  for (const d of dirs) {
    const p = path.join(d, exe);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

const STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);
// herdr text is shown in a terminal and a page; nothing in it may move the cursor or reorder text
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v ? v.replace(CONTROL, " ").slice(0, max) : null);

/** Parse `herdr agent list` output: `{"result":{"type":"agent_list","agents":[…]}}` or `{"error":{"code",…}}`. */
export function parseAgentList(stdout: string): HerdrState {
  let j: unknown;
  try {
    j = JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    return { state: "error", message: "herdr printed something that is not JSON" };
  }
  const o = (j && typeof j === "object" ? j : {}) as { result?: { type?: unknown; agents?: unknown }; error?: { code?: unknown; message?: unknown } };
  if (o.error) {
    if (o.error.code === "server_not_running") return { state: "stopped" };
    return { state: "error", message: text(o.error.message) ?? String(o.error.code ?? "herdr error") };
  }
  if (o.result?.type !== "agent_list" || !Array.isArray(o.result.agents)) return { state: "error", message: "herdr answered without an agent list" };
  const agents = o.result.agents.slice(0, 100).flatMap((a): HerdrAgent[] => {
    const r = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    if (typeof r.pane_id !== "string") return [];
    const status = typeof r.agent_status === "string" && STATUSES.has(r.agent_status) ? (r.agent_status as HerdrAgent["status"]) : "unknown";
    return [{
      pane: r.pane_id.slice(0, 64),
      workspace: typeof r.workspace_id === "string" ? r.workspace_id.slice(0, 64) : "",
      name: text(r.name, 40),
      agent: text(r.display_agent, 40) ?? text(r.agent, 40),
      status,
      cwd: text(r.cwd, 300),
      title: text(r.title, 120) ?? text(r.terminal_title_stripped, 120),
    }];
  });
  return { state: "running", agents };
}

/** Ask herdr for its agents. Bounded by `timeoutMs`; never throws. */
export function herdrAgents(env: NodeJS.ProcessEnv = process.env, timeoutMs = 1500): HerdrState {
  const bin = locateHerdr(env);
  if (!bin) return { state: "absent" };
  try {
    const r = spawnSync(bin, ["agent", "list"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) return { state: "error", message: r.error.message.slice(0, 200) };
    return parseAgentList(`${r.stdout ?? ""}`.trim() || `${r.stderr ?? ""}`);
  } catch (err) {
    return { state: "error", message: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}

/** herdr's state for a run: working while it runs, blocked while it waits for a person, idle once it is over. */
export function herdrStateOf(p: Pick<RunProgress, "status">): "working" | "blocked" | "idle" {
  return p.status === "running" ? "working" : p.status === "blocked" ? "blocked" : "idle";
}

/**
 * Tell herdr what this run is doing, when this process runs inside a herdr pane (HERDR_ENV=1 with the pane and binary
 * set). Fire and forget: herdr's guidance is that a report must never slow the agent, so the child is detached and
 * its failure ignored. `seq` is the time in ms, which only grows, as herdr requires.
 */
const lastReport = new Map<string, string>();
let seq = 0;

export function reportRunToHerdr(
  p: Pick<RunProgress, "status" | "intent" | "stage"> & { blocked?: { reason: string } },
  env: NodeJS.ProcessEnv = process.env,
  launch: (bin: string, args: string[]) => void = (bin, args) => {
    try {
      const child = spawn(bin, args, { stdio: "ignore", detached: true, windowsHide: true });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // herdr is optional
    }
  },
): boolean {
  if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID || !env.HERDR_BIN_PATH) return false;
  const state = herdrStateOf(p);
  const message = (state === "blocked" ? (p.blocked?.reason ?? "waiting for you") : `${p.stage}: ${p.intent}`).replace(CONTROL, " ").slice(0, 200);
  // Progress is written about once a second while an agent talks; herdr only needs to hear when what it shows changes.
  const key = `${env.HERDR_PANE_ID}|${state}|${message}`;
  if (lastReport.get(env.HERDR_PANE_ID) === key) return false;
  lastReport.set(env.HERDR_PANE_ID, key);
  // herdr ignores a report whose seq is not above the last one from this source; two in the same millisecond would tie
  seq = Math.max(seq + 1, Date.now());
  launch(env.HERDR_BIN_PATH, [
    "pane", "report-agent", env.HERDR_PANE_ID,
    "--source", "mstack", "--agent", "mola", "--state", state,
    "--seq", String(seq),
    "--message", message,
  ]);
  return true;
}
