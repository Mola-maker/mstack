/**
 * `mola statusline` — the Claude Code statusLine command (FRAMEWORK §13.2).
 * Reads the hook's JSON from stdin, prints the active run's one-liner. It must
 * be fast and silent on failure: any error prints nothing of ours and exits 0.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { activeProgress, formatProgressLine, writeJsonAtomic } from "@mola/plugin-sdk";

/** The directory Claude Code says it is in: workspace.current_dir, else cwd, else `fallback`. */
export function cwdFromStdin(stdin: string, fallback: string): string {
  try {
    const j = JSON.parse(stdin) as { workspace?: { current_dir?: unknown }; cwd?: unknown };
    const dir = j?.workspace?.current_dir ?? j?.cwd;
    if (typeof dir === "string" && dir.trim()) return dir;
  } catch {
    // empty or malformed stdin: tolerated
  }
  return fallback;
}

/** Our line for `cwd`, or "" when no run is active or anything goes wrong. */
export function ourLine(cwd: string, now = Date.now()): string {
  try {
    const p = activeProgress(cwd);
    return p ? formatProgressLine(p, now) : "";
  } catch {
    return "";
  }
}

/** The nearest directory at or above `start` that holds `.mstack/`, or null. */
function projectRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".mstack"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function age(ts: unknown, now: number): string {
  const t = typeof ts === "string" ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The environment line: what the agent could not see from inside the session.
 *  - verify: the Stop reminder's last verdict for this project (`.mstack/verify/status.json`), with its age.
 *    It is a record of the last stop, not a fresh check: edits since then are not in it, which is why the age is shown.
 *  - gaps: what the last `mola doctor` found failing or worth a warning (`~/.mola/doctor-last.json`), with its age.
 * Reads two small files and runs nothing. "" when neither exists.
 */
export function envLine(cwd: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const parts: string[] = [];
  try {
    const root = projectRoot(cwd);
    const st = root ? readJson(path.join(root, ".mstack", "verify", "status.json")) : null;
    if (st) {
      const msg = typeof st.message === "string" ? st.message : "";
      const levels = /required (L\d), found ([^ ]+(?: [a-z]+)*?) for/.exec(msg);
      const body =
        st.ok === true
          ? "verify ✓"
          : st.ok === false
            ? `verify ✗ ${levels ? `${levels[2]} of ${levels[1]}` : "below the required level"}`
            : "verify ? check could not run";
      parts.push(`${body} (${age(st.ts, now)})`);
    }
    const doc = readJson(path.join(env.MOLA_HOME || path.join(os.homedir(), ".mola"), "doctor-last.json"));
    const gaps = Array.isArray(doc?.gaps) ? (doc!.gaps as Array<{ id?: unknown; ok?: unknown }>) : null;
    if (gaps) {
      const ids = gaps.map((g) => (typeof g.id === "string" ? g.id : "?"));
      parts.push(
        ids.length === 0
          ? `env ✓ (${age(doc!.ts, now)})`
          : `gaps ${ids.length}: ${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", …" : ""} (${age(doc!.ts, now)}; mola doctor)`,
      );
    }
  } catch {
    return "";
  }
  return parts.join(" · ");
}

/** Run the wrapped statusLine command with the same stdin; its trimmed stdout, or "" on any failure. */
export function runWrapped(command: string, stdin: string, timeoutMs = 3000): string {
  try {
    const r = childProcess.spawnSync(command, {
      shell: true,
      input: stdin,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return (r.stdout ?? "").replace(/\s+$/, "");
  } catch {
    return "";
  }
}

/** The whole statusline output (without trailing newline). Never throws. */
export function renderStatusline(opts: { stdin: string; cwd: string; wrap?: string; now?: number }): string {
  const parts: string[] = [];
  if (opts.wrap) {
    const wrapped = runWrapped(opts.wrap, opts.stdin);
    if (wrapped) parts.push(wrapped);
  }
  const cwd = cwdFromStdin(opts.stdin, opts.cwd);
  const line = ourLine(cwd, opts.now);
  if (line) parts.push(line);
  const env = envLine(cwd, opts.now);
  if (env) parts.push(env);
  return parts.join("\n");
}

/** Read stdin without ever hanging: a TTY or a silent pipe yields "" after `timeoutMs`. */
export function readStdin(stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin, timeoutMs = 250): Promise<string> {
  if (stream.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const onData = (c: Buffer | string): void => void chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // a statusline must not be kept alive by a stdin nobody closes
      stream.removeListener("data", onData);
      stream.removeListener("end", finish);
      stream.removeListener("error", finish);
      (stream as { pause?: () => void }).pause?.();
      (stream as { unref?: () => void }).unref?.();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.on("data", onData);
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

// ---------------------------------------------------------------- install

/** How Claude Code should start us: the standalone script (fast), by absolute path. */
export function fastBase(): string {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "statusline-bin.js");
  return `node "${file.replace(/\\/g, "/")}"`;
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
}

interface StatusLineSetting {
  type?: string;
  command?: string;
  [k: string]: unknown;
}

export interface InstallPlan {
  file: string;
  exists: boolean;
  before: StatusLineSetting | null;
  after: StatusLineSetting;
  /** already ours: nothing to change */
  already: boolean;
  settings: Record<string, unknown>;
}

/** The command line Claude Code should run. `base` is how mola is invoked. */
export function buildCommand(existing: string | undefined, base = "mola statusline"): string {
  if (!existing) return base;
  return `${base} --wrap "${existing.replace(/(["\\])/g, "\\$1")}"`;
}

export function planInstall(file: string, base?: string): InstallPlan {
  let settings: Record<string, unknown> = {};
  let exists = false;
  try {
    const text = fs.readFileSync(file, "utf8");
    exists = true;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings.json is not a JSON object");
    settings = parsed as Record<string, unknown>;
  } catch (err) {
    if (exists) throw new Error(`cannot parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const before = (settings.statusLine as StatusLineSetting | undefined) ?? null;
  const already = typeof before?.command === "string" && /\bmola\b.*\bstatusline\b|statusline-bin/.test(before.command);
  const command = already ? (before!.command as string) : buildCommand(before?.command, base);
  const after: StatusLineSetting = { ...(before ?? {}), type: "command", command };
  return { file, exists, before, after, already, settings };
}

/** Back up the old file to settings.json.bak-mola, then write the new statusLine atomically. */
export function applyInstall(plan: InstallPlan): { backup?: string } {
  let backup: string | undefined;
  if (plan.exists) {
    backup = `${plan.file}.bak-mola`;
    fs.copyFileSync(plan.file, backup);
  }
  writeJsonAtomic(plan.file, { ...plan.settings, statusLine: plan.after });
  return backup ? { backup } : {};
}
