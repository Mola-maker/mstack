/**
 * cmd-tui model: state, the pure `reduce`, effect execution and data loading.
 * Nothing here touches the terminal. `reduce` never does IO: it queues
 * `effects` (approve / deny / stop / spawn / refresh) which `applyEffects`
 * performs through the plugin-sdk helpers, mirroring cmd-web.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  decideApproval,
  listProgress,
  readApproval,
  runDir,
  type Approval,
  type RunProgress,
} from "@mola/plugin-sdk";

export interface RunView {
  cwd: string;
  p: RunProgress;
  /** the approval the run is blocked on, when readable */
  approval?: Approval;
}

export type Effect =
  | { kind: "decide"; cwd: string; runId: string; approvalId: string; approved: boolean }
  | { kind: "stop"; cwd: string; runId: string }
  | { kind: "spawn"; intent: string; cwd: string }
  | { kind: "refresh" };

export interface Confirm {
  kind: "approve" | "deny" | "stop";
  cwd: string;
  runId: string;
  approvalId?: string;
  /** the question shown in the bottom bar */
  text: string;
}

export interface State {
  cwds: string[];
  runs: RunView[];
  /** selected run key `cwd|id`; the index follows data reorders */
  selKey?: string;
  detail: boolean;
  help: boolean;
  mode: "normal" | "confirm" | "prompt";
  confirm?: Confirm;
  prompt: string;
  msg?: string;
  /** log tail of the selected run */
  log: string[];
  logSource?: string;
  /** artifact names of the selected run (detail view) */
  artifacts: string[];
  cols: number;
  rows: number;
  /** spinner frame counter */
  tick: number;
  now: number;
  quit: boolean;
  /** set after `g`: select the first run that was not there before */
  launch?: { known: string[]; at: number };
  effects: Effect[];
}

export type Key = string; // "up" "down" "enter" "esc" "backspace" "ctrl-c" "pgup" "pgdn", or one character

export type Event =
  | { type: "key"; key: Key }
  | { type: "data"; runs: RunView[]; log?: string[]; logSource?: string; artifacts?: string[]; now: number }
  | { type: "resize"; cols: number; rows: number }
  | { type: "tick" };

export const runKey = (r: { cwd: string; p: { id: string } }): string => `${r.cwd}|${r.p.id}`;

export function initialState(cwds: string[], size = { cols: 100, rows: 30 }, now = Date.now()): State {
  return {
    cwds,
    runs: [],
    detail: false,
    help: false,
    mode: "normal",
    prompt: "",
    log: [],
    artifacts: [],
    cols: size.cols,
    rows: size.rows,
    tick: 0,
    now,
    quit: false,
    effects: [],
  };
}

export function selectedIndex(s: State): number {
  if (s.runs.length === 0) return -1;
  const i = s.selKey ? s.runs.findIndex((r) => runKey(r) === s.selKey) : -1;
  return i >= 0 ? i : 0;
}

export function selectedRun(s: State): RunView | undefined {
  const i = selectedIndex(s);
  return i >= 0 ? s.runs[i] : undefined;
}

const LAUNCH_WAIT_MS = 15_000;

function move(s: State, delta: number): State {
  if (s.runs.length === 0) return s;
  const i = Math.max(0, Math.min(s.runs.length - 1, selectedIndex(s) + delta));
  return { ...s, selKey: runKey(s.runs[i]), msg: undefined };
}

export function reduce(s: State, e: Event): State {
  switch (e.type) {
    case "resize":
      return { ...s, cols: Math.max(1, e.cols), rows: Math.max(1, e.rows) };
    case "tick":
      return { ...s, tick: s.tick + 1 };
    case "data":
      return reduceData(s, e);
    case "key":
      return reduceKey(s, e.key);
  }
}

function reduceData(s: State, e: Extract<Event, { type: "data" }>): State {
  let next: State = {
    ...s,
    runs: e.runs,
    now: e.now,
    log: e.log ?? s.log,
    logSource: e.logSource ?? (e.log ? undefined : s.logSource),
    artifacts: e.artifacts ?? s.artifacts,
  };
  if (s.launch) {
    const fresh = e.runs.find((r) => !s.launch!.known.includes(runKey(r)));
    if (fresh) next = { ...next, selKey: runKey(fresh), launch: undefined, msg: `started ${fresh.p.id}` };
    else if (e.now - s.launch.at > LAUNCH_WAIT_MS) {
      next = { ...next, launch: undefined, msg: "launched, but no new run appeared yet (see .mstack/runs/go-launch-*.log)" };
    }
  }
  if (next.selKey && !next.runs.some((r) => runKey(r) === next.selKey)) next = { ...next, selKey: undefined };
  return next;
}

function reduceKey(s: State, key: Key): State {
  if (key === "ctrl-c") return { ...s, quit: true };

  if (s.mode === "prompt") {
    if (key === "esc") return { ...s, mode: "normal", prompt: "", msg: "cancelled" };
    if (key === "enter") {
      const intent = s.prompt.trim();
      if (!intent) return { ...s, mode: "normal", prompt: "" };
      const cwd = selectedRun(s)?.cwd ?? s.cwds[0] ?? process.cwd();
      return {
        ...s,
        mode: "normal",
        prompt: "",
        msg: `launching: ${intent}`,
        launch: { known: s.runs.map(runKey), at: s.now },
        effects: [...s.effects, { kind: "spawn", intent, cwd }],
      };
    }
    if (key === "backspace") return { ...s, prompt: [...s.prompt].slice(0, -1).join("") };
    if ([...key].length === 1 && key >= " " && key !== "\x7f") return { ...s, prompt: s.prompt + key };
    return s;
  }

  if (s.mode === "confirm" && s.confirm) {
    const c = s.confirm;
    if (key !== "y" && key !== "Y") return { ...s, mode: "normal", confirm: undefined, msg: "cancelled" };
    const effect: Effect =
      c.kind === "stop"
        ? { kind: "stop", cwd: c.cwd, runId: c.runId }
        : { kind: "decide", cwd: c.cwd, runId: c.runId, approvalId: c.approvalId!, approved: c.kind === "approve" };
    return { ...s, mode: "normal", confirm: undefined, effects: [...s.effects, effect] };
  }

  if (s.help) {
    if (key === "q") return { ...s, quit: true };
    return { ...s, help: false };
  }

  switch (key) {
    case "q":
      return { ...s, quit: true };
    case "up":
    case "k":
      return move(s, -1);
    case "down":
    case "j":
      return move(s, 1);
    case "pgup":
      return move(s, -5);
    case "pgdn":
      return move(s, 5);
    case "enter":
      return { ...s, detail: !s.detail };
    case "esc":
      return s.detail ? { ...s, detail: false } : { ...s, msg: undefined };
    case "?":
      return { ...s, help: true };
    case "r":
      return { ...s, msg: "refreshed", effects: [...s.effects, { kind: "refresh" }] };
    case "g":
      return { ...s, mode: "prompt", prompt: "", msg: undefined };
    case "a":
    case "d": {
      const r = selectedRun(s);
      const aid = r?.p.blocked?.approvalId;
      if (!r || r.p.status !== "blocked" || !aid || (r.approval && r.approval.status !== "pending")) {
        return { ...s, msg: "no pending approval on the selected run" };
      }
      const approve = key === "a";
      return {
        ...s,
        mode: "confirm",
        confirm: {
          kind: approve ? "approve" : "deny",
          cwd: r.cwd,
          runId: r.p.id,
          approvalId: aid,
          text: `${approve ? "Approve" : "Deny"} ${r.p.id}${r.approval ? `: ${r.approval.action}` : ""}? [y/n]`,
        },
        msg: undefined,
      };
    }
    case "s": {
      const r = selectedRun(s);
      if (!r || (r.p.status !== "running" && r.p.status !== "blocked")) {
        return { ...s, msg: "the selected run is not active" };
      }
      return {
        ...s,
        mode: "confirm",
        confirm: { kind: "stop", cwd: r.cwd, runId: r.p.id, text: `Stop ${r.p.id}? writes STOP [y/n]` },
        msg: undefined,
      };
    }
    default:
      return s;
  }
}

// ------------------------------------------------------------------ effects

export interface LaunchRequest {
  intent: string;
  cwd: string;
}

export interface EffectDeps {
  /** start `mola go`; returns the log file it writes to */
  spawn(req: LaunchRequest): string | void;
}

/** Perform the queued effects (the only place reduce's requests touch disk or spawn). */
export function applyEffects(s: State, deps: EffectDeps): State {
  if (s.effects.length === 0) return s;
  let msg = s.msg;
  let launch = s.launch;
  for (const e of s.effects) {
    try {
      if (e.kind === "decide") {
        const ok = decideApproval(e.cwd, e.runId, e.approvalId, e.approved, "tui");
        msg = ok ? `${e.approved ? "approved" : "denied"} ${e.runId}` : "approval missing or already decided";
      } else if (e.kind === "stop") {
        const dir = runDir(e.cwd, e.runId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "STOP"), new Date().toISOString() + "\n", "utf8");
        msg = `STOP written for ${e.runId}`;
      } else if (e.kind === "spawn") {
        const log = deps.spawn({ intent: e.intent, cwd: e.cwd });
        msg = `launched mola go${log ? ` (log: ${path.basename(log)})` : ""}`;
      }
    } catch (err) {
      msg = `failed: ${err instanceof Error ? err.message : String(err)}`;
      if (e.kind === "spawn") launch = undefined;
    }
  }
  return { ...s, effects: [], msg, launch };
}

/** The `mola go` child to start; pure so tests can check it. */
export function buildLaunch(
  req: LaunchRequest,
  molaBin: string,
  execPath: string,
  now: number,
): { command: string; args: string[]; cwd: string; logFile: string } {
  return {
    command: execPath,
    args: [molaBin, "go", req.intent],
    cwd: req.cwd,
    logFile: path.join(req.cwd, ".mstack", "runs", `go-launch-${now}.log`),
  };
}

// --------------------------------------------------------------------- data

const TAIL_LINES = 200;

export function tailLines(file: string, n = TAIL_LINES): string[] | undefined {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n);
  } catch {
    return undefined;
  }
}

function loadView(cwd: string, p: RunProgress): RunView {
  const v: RunView = { cwd, p };
  if (p.status === "blocked" && p.blocked?.approvalId) {
    const a = readApproval(cwd, p.id, p.blocked.approvalId);
    if (a) v.approval = a;
  }
  return v;
}

export function loadRuns(cwds: string[]): RunView[] {
  return cwds
    .flatMap((c) => listProgress(c).map((p) => loadView(c, p)))
    .sort((a, b) => b.p.updatedAt.localeCompare(a.p.updatedAt));
}

/** events.jsonl tail of a run, else the tail of the newest file in its dir. */
export function loadLog(r: RunView): { log: string[]; source?: string } {
  const dir = runDir(r.cwd, r.p.id);
  const ev = tailLines(path.join(dir, "events.jsonl"));
  if (ev && ev.length > 0) return { log: ev, source: "events.jsonl" };
  let best: { name: string; mtime: number } | undefined;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || ent.name === "progress.json" || ent.name === "STOP" || ent.name.endsWith(".tmp")) continue;
      const m = fs.statSync(path.join(dir, ent.name)).mtimeMs;
      if (!best || m > best.mtime) best = { name: ent.name, mtime: m };
    }
  } catch {
    /* no run dir */
  }
  if (best) {
    const t = tailLines(path.join(dir, best.name));
    if (t) return { log: t, source: best.name };
  }
  return { log: [] };
}

export function loadArtifacts(r: RunView): string[] {
  const out = new Set<string>();
  for (const s of r.p.stages) if (s.artifact) out.add(s.artifact);
  try {
    for (const ent of fs.readdirSync(runDir(r.cwd, r.p.id), { withFileTypes: true })) {
      if (ent.isFile() && ent.name !== "progress.json" && !ent.name.endsWith(".tmp")) out.add(ent.name);
    }
  } catch {
    /* ignore */
  }
  return [...out];
}

export interface Snapshot {
  runs: RunView[];
  log: string[];
  logSource?: string;
  artifacts: string[];
}

/** One poll: all runs plus the log and artifacts of the one that is selected. */
export function loadSnapshot(cwds: string[], selKey?: string): Snapshot {
  const runs = loadRuns(cwds);
  const sel = (selKey ? runs.find((r) => runKey(r) === selKey) : undefined) ?? runs[0];
  if (!sel) return { runs, log: [], artifacts: [] };
  const { log, source } = loadLog(sel);
  return { runs, log, ...(source ? { logSource: source } : {}), artifacts: loadArtifacts(sel) };
}

// -------------------------------------------------------------------- input

/** Split a raw stdin chunk into keys. */
export function parseKeys(chunk: string): Key[] {
  const out: Key[] = [];
  const chars = [...chunk];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\x1b") {
      const n = chars[i + 1];
      if ((n === "[" || n === "O") && i + 2 < chars.length) {
        // CSI: parameters then a final byte
        let j = i + 2;
        let params = "";
        while (j < chars.length && /[0-9;]/.test(chars[j])) params += chars[j++];
        const fin = chars[j] ?? "";
        i = j;
        if (fin === "A") out.push("up");
        else if (fin === "B") out.push("down");
        else if (fin === "~" && params === "5") out.push("pgup");
        else if (fin === "~" && params === "6") out.push("pgdn");
        continue;
      }
      out.push("esc");
    } else if (c === "\r" || c === "\n") out.push("enter");
    else if (c === "\x7f" || c === "\b") out.push("backspace");
    else if (c === "\x03") out.push("ctrl-c");
    else if (c >= " ") out.push(c);
  }
  return out;
}

/** `--cwd` may repeat; parseArgv keeps the last, so also scan the raw argv. */
export function cwdFlags(flag: string | boolean | undefined, argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--cwd" && argv[i + 1] && !argv[i + 1].startsWith("-")) out.push(argv[++i]);
    else if (t.startsWith("--cwd=")) out.push(t.slice(6));
  }
  if (typeof flag === "string" && !out.includes(flag)) out.push(flag);
  return out;
}
