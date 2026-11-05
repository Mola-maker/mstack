/**
 * tool-git — git/gh discovery and porcelain parsing (B1).
 *
 * Grounding (adapters-routing §3.1): only `gh-help.txt` was captured, so this
 * adapter stays on stable porcelain verbs — `git worktree add|remove|list
 * --porcelain`, `git rev-parse`, `git --version` — and never invents flags.
 * `gh` usage is limited to `gh --version` and `gh auth status` (both present in
 * the captured help / its own `--help`).
 *
 * Everything here is pure or plain filesystem work, so the unit tests drive it
 * with fixture directories and never touch the real machine's git.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface BinaryLocation {
  /** absolute path of the executable, or null when it was not found */
  path: string | null;
  /** how it was found */
  source: "path" | "none";
}

export interface BinaryInfo extends BinaryLocation {
  /** e.g. "2.53.0"; null when the version could not be read */
  version: string | null;
  /** raw first line of `--version`, kept for doctor output */
  raw: string | null;
}

/** PATHEXT on Windows; POSIX shells use an empty extension list. */
function exeExtensions(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [""];
  const pathext = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const list = pathext
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  return list.length > 0 ? [...list, ""] : [""];
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Scan PATH for `name` (plus PATHEXT variants on Windows). */
export function findOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  name: string,
): string | null {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  const dirs = raw.split(path.delimiter).filter((d) => d.length > 0);
  const exts = exeExtensions(env, platform);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Locate a binary by name on PATH. */
export function locateBinary(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BinaryLocation {
  const found = findOnPath(env, platform, name);
  return found ? { path: found, source: "path" } : { path: null, source: "none" };
}

/** Parse `git --version` ("git version 2.53.0") → "2.53.0". */
export function parseGitVersion(raw: string): string | null {
  const m = raw.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/** Parse `gh --version` ("gh version 2.103.3 (2026-10-26)") → "2.103.3". */
export function parseGhVersion(raw: string): string | null {
  const m = raw.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/** First non-empty line of a version output, trimmed. */
export function firstLine(raw: string): string | null {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? null;
}

// ------------------------------------------------------------- worktrees

export interface WorktreeInfo {
  /** absolute path of the worktree */
  path: string;
  /** commit the worktree points at */
  head: string;
  /** short branch name, e.g. "agent/my-task" (absent when detached) */
  branch?: string;
  /** full ref, e.g. "refs/heads/agent/my-task" */
  ref?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * The format is one record per worktree, records separated by a blank line:
 *
 *   worktree /path/to/wt
 *   HEAD 0f1e2d3…
 *   branch refs/heads/agent/task
 *
 * with the optional markers `detached`, `bare`, `locked`, `prunable`.
 */
export function parseWorktreeList(raw: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;

  const flush = (): void => {
    if (current) {
      out.push(current);
      current = null;
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      continue;
    }
    const space = trimmed.indexOf(" ");
    const key = space < 0 ? trimmed : trimmed.slice(0, space);
    const value = space < 0 ? "" : trimmed.slice(space + 1);
    switch (key) {
      case "worktree":
        flush();
        current = {
          path: value,
          head: "",
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
        };
        break;
      case "HEAD":
        if (current) current.head = value;
        break;
      case "branch":
        if (current) {
          current.ref = value;
          current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
        }
        break;
      case "bare":
        if (current) current.bare = true;
        break;
      case "detached":
        if (current) current.detached = true;
        break;
      case "locked":
        if (current) current.locked = true;
        break;
      case "prunable":
        if (current) current.prunable = true;
        break;
      default:
        break; // unknown markers are ignored on purpose (forward compatible)
    }
  }
  flush();
  return out;
}

/**
 * Normalise a worktree path to an absolute path. `git worktree list` already
 * prints absolute paths; `git worktree add` targets may be relative to the repo.
 */
export function absolutePath(cwd: string, target: string): string {
  return path.resolve(cwd, target);
}

/** Derive the default branch name for a task worktree (adapters-routing §3.1). */
export function taskBranchName(task: string): string {
  const slug = task
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `agent/${slug || "task"}`;
}
