/**
 * The two environment facts every surface shows (status line, TUI, web console), read in one place:
 *
 *  - the Stop reminder's last verdict for a checkout: `<git root>/.mstack/verify/status.json`
 *  - the last `mola doctor` result: `<mola home>/doctor-last.json`
 *
 * Both readers only read small files; they run no check. The verdict file sits inside a repository, so a clone
 * can ship its own: nothing from it is passed on except a boolean, two values from a fixed list, and a
 * timestamp that parsed as a date. Doctor messages come from the user's own home; control characters are
 * stripped so they can be shown in a terminal or a page.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface VerifyStatus {
  /** true: receipt at the required level; false: below it; null: the check could not run */
  ok: boolean | null;
  /** e.g. "L3"; absent when the record does not say */
  required?: string;
  /** "L1", "no receipt", "no passing check" or "no valid receipt" */
  found?: string;
  /** ms since the epoch of the stop that produced the verdict; absent when unreadable */
  at?: number;
  /** the git checkout the verdict belongs to */
  root: string;
}

export interface DoctorGap {
  id: string;
  /** false: the check failed; true: it passed with a warning */
  ok: boolean;
  message: string;
}

export interface DoctorStatus {
  at?: number;
  total?: number;
  gaps: DoctorGap[];
}

/**
 * The git checkout `start` is in: the nearest directory at or above it holding `.git` (a directory, or the
 * file a worktree has). The Stop hook writes its verdict at the git toplevel, so this is where to read it.
 */
export function gitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readObject(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function when(ts: unknown): number | undefined {
  const t = typeof ts === "string" ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** The last verdict for the checkout `cwd` is in, or null when there is none. */
export function verifyStatus(cwd: string): VerifyStatus | null {
  const root = gitRoot(cwd);
  const st = root ? readObject(path.join(root, ".mstack", "verify", "status.json")) : null;
  if (!root || !st) return null;
  const msg = typeof st.message === "string" ? st.message.slice(0, 400) : "";
  const m = /required (L[0-5]), found (L[0-5]|no receipt|no passing check|no valid receipt)\b/.exec(msg);
  const at = when(st.ts);
  return {
    ok: st.ok === true ? true : st.ok === false ? false : null,
    ...(m ? { required: m[1], found: m[2] } : {}),
    ...(at !== undefined ? { at } : {}),
    root,
  };
}

/** Where `mola doctor` keeps its last result. */
export function doctorCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.MOLA_HOME || path.join(os.homedir(), ".mola"), "doctor-last.json");
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** The last doctor result: the checks that failed or warned. Null when doctor has not run. */
export function doctorStatus(env: NodeJS.ProcessEnv = process.env): DoctorStatus | null {
  const doc = readObject(doctorCachePath(env));
  if (!doc || !Array.isArray(doc.gaps)) return null;
  const gaps = (doc.gaps as unknown[]).slice(0, 200).map((g): DoctorGap => {
    const o = (g && typeof g === "object" ? g : {}) as Record<string, unknown>;
    // check ids are short dotted names; anything else is not passed on
    const id = typeof o.id === "string" && /^[\w.>=<:-]{1,60}$/.test(o.id) ? o.id : "?";
    const message = typeof o.message === "string" ? o.message.replace(CONTROL, " ").slice(0, 600) : "";
    return { id, ok: o.ok === true, message };
  });
  const at = when(doc.ts);
  return { ...(at !== undefined ? { at } : {}), ...(typeof doc.total === "number" ? { total: doc.total } : {}), gaps };
}

/** "7m ago", "2h ago", "3d ago", "just now"; "" when the time is unknown. */
export function ago(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return "";
  const m = Math.max(0, Math.round((now - at) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}
