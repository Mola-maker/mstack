/**
 * Stage checkpoints: the whole working tree (tracked edits and untracked files,
 * minus ignored files and `.mstack/`) saved as a commit under a hidden ref,
 * `refs/mstack/runs/<runId>/<n>-<name>`. Nothing is added to the user's branch
 * and the real index is never touched (a temporary index does the work).
 *
 * `diffCheckpoints` gives one stage's own changes; `restoreCheckpoint` puts the
 * working tree back to a checkpoint and first saves the current tree as
 * `pre-rewind`, so a rewind can itself be undone.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Checkpoint {
  name: string;
  ref: string;
  commit: string;
  tree: string;
  at: string;
}

const EXCLUDE = ":(exclude).mstack";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).out === "true";
}

/** Tree of the working tree as it is now (temp index; the real index is untouched). */
export function snapshotTree(cwd: string): string | undefined {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return undefined;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mola-ckpt-")), "index");
  try {
    const env = { GIT_INDEX_FILE: tmp };
    // start from HEAD's index when there is a HEAD, so unchanged files cost nothing
    if (git(top.out, ["rev-parse", "--verify", "-q", "HEAD"]).ok) git(top.out, ["read-tree", "HEAD"], env);
    const add = git(top.out, ["add", "-A", "--", ".", EXCLUDE], env);
    if (!add.ok) return undefined;
    // drop anything under .mstack that came in from HEAD
    git(top.out, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".mstack"], env);
    const tree = git(top.out, ["write-tree"], env);
    return tree.ok ? tree.out : undefined;
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

const refPrefix = (runId: string): string => `refs/mstack/runs/${runId}/`;

export function listCheckpoints(cwd: string, runId: string): Checkpoint[] {
  const r = git(cwd, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)", refPrefix(runId)]);
  if (!r.ok || !r.out) return [];
  const out: Checkpoint[] = [];
  for (const line of r.out.split("\n")) {
    const [ref, commit, at] = line.split("\t");
    const tree = git(cwd, ["rev-parse", `${commit}^{tree}`]).out;
    out.push({ ref, commit, tree, at, name: ref.slice(refPrefix(runId).length).replace(/^\d+-/, "") });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

/** Save the working tree as the next checkpoint of the run. Undefined outside a git repo. */
export function saveCheckpoint(cwd: string, runId: string, name: string): Checkpoint | undefined {
  if (!/^[\w.-]+$/.test(runId) || !/^[\w.-]+$/.test(name)) throw new Error("bad checkpoint name");
  const tree = snapshotTree(cwd);
  if (!tree) return undefined;
  const existing = listCheckpoints(cwd, runId);
  const parent = existing.at(-1)?.commit ?? (git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).out || undefined);
  const msg = `mstack checkpoint ${runId} ${name}`;
  const commit = git(cwd, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", msg], {
    GIT_AUTHOR_NAME: "mstack",
    GIT_AUTHOR_EMAIL: "mstack@localhost",
    GIT_COMMITTER_NAME: "mstack",
    GIT_COMMITTER_EMAIL: "mstack@localhost",
  });
  if (!commit.ok) return undefined;
  const ref = `${refPrefix(runId)}${existing.length}-${name}`;
  if (!git(cwd, ["update-ref", ref, commit.out]).ok) return undefined;
  return { name, ref, commit: commit.out, tree, at: new Date().toISOString() };
}

function findCheckpoint(list: Checkpoint[], name: string): number {
  // the last checkpoint with that name (a stage that ran twice has two)
  for (let i = list.length - 1; i >= 0; i--) if (list[i].name === name || list[i].ref.endsWith(`/${name}`)) return i;
  return -1;
}

/**
 * Unified diff. With `name`: that checkpoint against the one before it (the
 * stage's own changes). Without: the first checkpoint against the last.
 */
export function diffCheckpoints(cwd: string, runId: string, name?: string, opts: { stat?: boolean } = {}): string {
  const list = listCheckpoints(cwd, runId);
  if (list.length === 0) throw new Error(`run ${runId} has no checkpoints`);
  let from: Checkpoint;
  let to: Checkpoint;
  if (name) {
    const i = findCheckpoint(list, name);
    if (i < 0) throw new Error(`no checkpoint "${name}" in run ${runId} (have: ${list.map((c) => c.name).join(", ")})`);
    if (i === 0) return "";
    from = list[i - 1];
    to = list[i];
  } else {
    from = list[0];
    to = list[list.length - 1];
  }
  const r = git(cwd, ["diff", ...(opts.stat ? ["--stat"] : []), from.commit, to.commit]);
  if (!r.ok) throw new Error(r.err || "git diff failed");
  return r.out;
}

export interface RestoreResult {
  restored: Checkpoint;
  /** the tree as it was just before, saved so this rewind can be undone */
  saved?: Checkpoint;
  removed: string[];
}

/** Put the working tree back to a checkpoint. The real index and branch are not moved. */
export function restoreCheckpoint(cwd: string, runId: string, name: string): RestoreResult {
  const list = listCheckpoints(cwd, runId);
  const i = findCheckpoint(list, name);
  if (i < 0) throw new Error(`no checkpoint "${name}" in run ${runId} (have: ${list.map((c) => c.name).join(", ") || "none"})`);
  const target = list[i];
  const top = git(cwd, ["rev-parse", "--show-toplevel"]).out;
  const saved = saveCheckpoint(cwd, runId, "pre-rewind");
  const nowTree = saved?.tree ?? snapshotTree(cwd);
  // files that exist now but not in the target: delete them
  const removed: string[] = [];
  if (nowTree) {
    const added = git(top, ["diff", "--name-only", "--diff-filter=A", "-z", target.tree, nowTree]);
    for (const f of added.out.split("\0").filter(Boolean)) {
      try {
        fs.rmSync(path.join(top, f), { force: true });
        removed.push(f);
      } catch {
        // keep going; the report lists what went
      }
    }
  }
  const r = git(top, ["restore", `--source=${target.commit}`, "--worktree", "--", ".", EXCLUDE]);
  if (!r.ok) throw new Error(r.err || "git restore failed");
  return { restored: target, ...(saved ? { saved } : {}), removed };
}

/** Delete a run's checkpoint refs (the objects go with the next git gc). */
export function dropCheckpoints(cwd: string, runId: string): number {
  const list = listCheckpoints(cwd, runId);
  for (const c of list) git(cwd, ["update-ref", "-d", c.ref]);
  return list.length;
}
