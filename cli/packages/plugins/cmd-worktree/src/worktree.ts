/**
 * Agent worktrees with a lifecycle (after T3 Code's `t3.json` setup scripts and
 * storage cleanup):
 *
 * `.mstack/worktree.json` in the repo:
 *   {
 *     "setup": "pnpm install --frozen-lockfile",   // runs in a new worktree; failure rolls the worktree back
 *     "teardown": "cargo clean",                    // runs before gc removes a worktree
 *     "root": "../mstack-wt",                       // where new worktrees go (default ../<repo>-wt)
 *     "gc": { "inactiveDays": 14 }
 *   }
 * Commands run through the platform shell with MOLA_PROJECT_ROOT, MOLA_WORKTREE_ROOT,
 * MOLA_WORKTREE_BRANCH and MOLA_WORKTREE_BASE set, ten minutes each.
 *
 * gc only touches `agent/*` worktrees. It removes one whose branch is merged into
 * the base, or that is inactive past `inactiveDays`; it keeps any with uncommitted
 * or untracked changes, a lock, or a running go run, and says why. Folders in the
 * worktree root that git does not know are listed with their size and never deleted.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { listProgress } from "@mola/plugin-sdk";

export interface WorktreeConfig {
  setup?: string;
  teardown?: string;
  root?: string;
  gc?: { inactiveDays?: number };
}

export function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function readConfig(top: string): WorktreeConfig {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(top, ".mstack", "worktree.json"), "utf8")) as WorktreeConfig;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function mainTop(cwd: string): string {
  // the main checkout, also when called from inside a worktree
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new Error("not inside a git repository");
  return path.dirname(common.out);
}

export function worktreeRoot(top: string, cfg: WorktreeConfig): string {
  return path.resolve(top, cfg.root ?? path.join("..", `${path.basename(top)}-wt`));
}

export interface HookRun {
  ok: boolean;
  code: number | null;
  output: string;
}

export function runCommand(command: string, cwd: string, env: Record<string, string>, timeoutMs = 600000): HookRun {
  const win = process.platform === "win32";
  const r = spawnSync(win ? "cmd.exe" : "sh", win ? ["/d", "/s", "/c", command] : ["-c", command], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, code: r.status, output: output.slice(-4000) || (r.error?.message ?? "") };
}

export interface NewResult {
  path: string;
  branch: string;
  base: string;
  setup?: HookRun;
}

export function newWorktree(cwd: string, name: string, opts: { base?: string; keepOnFailure?: boolean } = {}): NewResult {
  if (!/^[\w][\w.-]{0,60}$/.test(name)) throw new Error("the name is letters, digits, . _ - (up to 61)");
  const top = mainTop(cwd);
  const cfg = readConfig(top);
  const branch = `agent/${name}`;
  const base = opts.base ?? "HEAD";
  const dir = path.join(worktreeRoot(top, cfg), name);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  const exists = git(top, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).ok;
  const add = git(top, ["worktree", "add", dir, ...(exists ? [branch] : ["-b", branch, base])]);
  if (!add.ok) throw new Error(`git worktree add failed: ${add.err}`);
  const res: NewResult = { path: dir, branch, base };
  if (cfg.setup) {
    res.setup = runCommand(cfg.setup, dir, {
      MOLA_PROJECT_ROOT: top,
      MOLA_WORKTREE_ROOT: dir,
      MOLA_WORKTREE_BRANCH: branch,
      MOLA_WORKTREE_BASE: base,
    });
    if (!res.setup.ok && !opts.keepOnFailure) {
      git(top, ["worktree", "remove", "--force", dir]);
      if (!exists) git(top, ["branch", "-D", branch]);
    }
  }
  return res;
}

export interface GcItem {
  path: string;
  branch: string;
  action: "remove" | "keep";
  reason: string;
}

function defaultBase(top: string): string {
  const head = git(top, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.out) return head.out;
  for (const b of ["main", "master"]) if (git(top, ["rev-parse", "--verify", "-q", `refs/heads/${b}`]).ok) return b;
  return "HEAD";
}

function lastActivity(dir: string, top: string, branch: string): number {
  const commit = Number(git(top, ["log", "-1", "--format=%ct", branch]).out) * 1000 || 0;
  let mtime = 0;
  try {
    mtime = fs.statSync(dir).mtimeMs;
  } catch {
    // gone
  }
  return Math.max(commit, mtime);
}

export function planGc(cwd: string, opts: { inactiveDays?: number; now?: number } = {}): { items: GcItem[]; orphans: { path: string; bytes: number }[]; base: string } {
  const top = mainTop(cwd);
  const cfg = readConfig(top);
  const days = opts.inactiveDays ?? cfg.gc?.inactiveDays ?? 14;
  const now = opts.now ?? Date.now();
  const base = defaultBase(top);
  const list = git(top, ["worktree", "list", "--porcelain"]).out.split("\n\n");
  const items: GcItem[] = [];
  const known = new Set<string>();
  const running = new Set(
    listProgress(top)
      .filter((p) => p.status === "running")
      .map((p) => path.resolve(p.cwd)),
  );
  for (const block of list) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    if (!wt) continue;
    known.add(path.resolve(wt));
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "";
    if (path.resolve(wt) === path.resolve(top) || !branch.startsWith("agent/")) continue;
    const keep = (reason: string): void => void items.push({ path: wt, branch, action: "keep", reason });
    if (/^locked/m.test(block)) {
      keep("locked");
      continue;
    }
    if (!fs.existsSync(wt)) {
      items.push({ path: wt, branch, action: "remove", reason: "folder is gone (prune)" });
      continue;
    }
    if (running.has(path.resolve(wt)) || listProgress(wt).some((p) => p.status === "running")) {
      keep("a go run is running there");
      continue;
    }
    const dirty = git(wt, ["status", "--porcelain"]).out;
    if (dirty) {
      keep(`uncommitted or untracked changes (${dirty.split("\n").length} paths)`);
      continue;
    }
    const merged = git(top, ["merge-base", "--is-ancestor", branch, base]).ok;
    if (merged) {
      items.push({ path: wt, branch, action: "remove", reason: `merged into ${base}` });
      continue;
    }
    const idle = (now - lastActivity(wt, top, branch)) / 86400000;
    if (idle >= days) items.push({ path: wt, branch, action: "remove", reason: `inactive ${Math.floor(idle)} days (≥ ${days}); branch ${branch} is kept` });
    else keep(`active ${Math.floor(idle)} of ${days} days`);
  }
  const orphans: { path: string; bytes: number }[] = [];
  const root = worktreeRoot(top, cfg);
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, e.name);
      if (e.isDirectory() && !known.has(path.resolve(p))) orphans.push({ path: p, bytes: duBytes(p) });
    }
  } catch {
    // no root yet
  }
  return { items, orphans, base };
}

function duBytes(dir: string, budget = { n: 200000 }): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (--budget.n < 0) break;
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += duBytes(p, budget);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch {
      // unreadable
    }
  }
  return total;
}

export function applyGc(cwd: string, items: GcItem[]): { removed: string[]; failed: { path: string; error: string }[]; teardown: Record<string, HookRun> } {
  const top = mainTop(cwd);
  const cfg = readConfig(top);
  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];
  const teardown: Record<string, HookRun> = {};
  for (const it of items.filter((i) => i.action === "remove")) {
    if (cfg.teardown && fs.existsSync(it.path)) {
      teardown[it.path] = runCommand(cfg.teardown, it.path, { MOLA_PROJECT_ROOT: top, MOLA_WORKTREE_ROOT: it.path, MOLA_WORKTREE_BRANCH: it.branch, MOLA_WORKTREE_BASE: "" });
    }
    // no --force: git itself refuses a worktree that changed since the plan
    const r = fs.existsSync(it.path) ? git(top, ["worktree", "remove", it.path]) : git(top, ["worktree", "prune"]);
    if (r.ok) removed.push(it.path);
    else failed.push({ path: it.path, error: r.err });
  }
  return { removed, failed, teardown };
}

export const fmtBytes = (b: number): string => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GiB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MiB` : `${Math.round(b / 1024)} KiB`);
