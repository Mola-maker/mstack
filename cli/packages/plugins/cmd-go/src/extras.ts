/**
 * Run controls borrowed from T3 Code's thread model:
 *
 *   mola go say <run> "<note>"              queue a note; the next stage reads it (queue, not steer)
 *   mola go checkpoints <run>               the hidden-ref snapshots of the run
 *   mola go diff <run> [checkpoint] [--stat] one stage's own changes (default: base → last)
 *   mola go rewind <run> <checkpoint> [--yes] put the working tree back; saves `pre-rewind` first
 *   mola go later <run> --at <time>|--clear  resume a stopped/blocked run at a time (`mola serve` does it)
 */

import type { Io, RunProgress } from "@mola/plugin-sdk";
import {
  ExitCode,
  MolaError,
  addNote,
  diffCheckpoints,
  listCheckpoints,
  listProgress,
  pendingNotes,
  restoreCheckpoint,
  writeProgress,
} from "@mola/plugin-sdk";
import { resolveRun } from "./manage.js";

export function cmdSay(io: Io, id: string | undefined, text: string, by = "cli"): ExitCode {
  if (!id || !text.trim()) throw new MolaError("USAGE_ERROR", 'usage: mola go say <runId> "<note>"', ExitCode.Usage);
  const p = resolveRun(io.cwd, id);
  if (p.status === "done") throw new MolaError("USAGE_ERROR", `run ${p.id} is done; start a new one`, ExitCode.Usage);
  let res;
  try {
    res = addNote(io.cwd, p.id, text, by);
  } catch (err) {
    throw new MolaError("USAGE_ERROR", err instanceof Error ? err.message : String(err), ExitCode.Usage);
  }
  const queued = pendingNotes(io.cwd, p.id).length;
  io.data({ runId: p.id, note: res.note, queued, removedInvisible: res.removed });
  if (res.removed > 0) io.note(`mola: removed ${res.removed} invisible character${res.removed === 1 ? "" : "s"} from the note`);
  io.out(`queued for ${p.id}: the next stage reads it (${queued} unread)${p.status === "running" ? "" : ` — the run is ${p.status}; resume it with: mola go --resume ${p.id}`}`);
  return ExitCode.Ok;
}

export function cmdCheckpoints(io: Io, id: string | undefined): ExitCode {
  const p = resolveRun(io.cwd, id);
  const list = listCheckpoints(io.cwd, p.id);
  io.data({ runId: p.id, checkpoints: list });
  if (list.length === 0) io.out(`${p.id}: no checkpoints (not a git repo, or the run predates checkpoints)`);
  for (const c of list) io.out(`${c.name.padEnd(12)} ${c.commit.slice(0, 10)}  ${c.at}  ${c.ref}`);
  return ExitCode.Ok;
}

export function cmdDiff(io: Io, id: string | undefined, name: string | undefined, stat: boolean): ExitCode {
  const p = resolveRun(io.cwd, id);
  let text: string;
  try {
    text = diffCheckpoints(io.cwd, p.id, name, { stat });
  } catch (err) {
    throw new MolaError("NO_INPUT", err instanceof Error ? err.message : String(err), ExitCode.NoInput);
  }
  io.data({ runId: p.id, checkpoint: name ?? null, diff: text });
  if (!io.json) process.stdout.write(text ? text + "\n" : "(no changes)\n");
  return ExitCode.Ok;
}

/** Another run working in the same directory: rewinding under it would erase its work. */
export function busyRuns(cwd: string, except: string): RunProgress[] {
  return listProgress(cwd).filter((r) => r.id !== except && r.status === "running");
}

export function cmdRewind(io: Io, id: string | undefined, name: string | undefined, yes: boolean): ExitCode {
  if (!id || !name) throw new MolaError("USAGE_ERROR", "usage: mola go rewind <runId> <checkpoint> [--yes]", ExitCode.Usage);
  const p = resolveRun(io.cwd, id);
  if (p.status === "running") throw new MolaError("POLICY_DENIED", `run ${p.id} is running; stop it first (mola go stop ${p.id})`, ExitCode.NoPerm);
  const busy = busyRuns(io.cwd, p.id);
  if (busy.length > 0) {
    throw new MolaError("POLICY_DENIED", `refused: ${busy.map((b) => b.id).join(", ")} still work in this directory; a rewind would erase their changes`, ExitCode.NoPerm);
  }
  const list = listCheckpoints(io.cwd, p.id);
  if (!list.some((c) => c.name === name)) {
    throw new MolaError("NO_INPUT", `no checkpoint "${name}" in ${p.id} (have: ${list.map((c) => c.name).join(", ") || "none"})`, ExitCode.NoInput);
  }
  if (!(yes || io.yes)) {
    io.data({ runId: p.id, checkpoint: name, written: false });
    io.out(`would put the working tree of ${io.cwd} back to ${p.id}/${name}. .mstack/ is kept; the current tree is saved as "pre-rewind" first, so this can be undone with: mola go rewind ${p.id} pre-rewind --yes`);
    io.out("not done. Re-run with --yes.");
    return ExitCode.Ok;
  }
  const r = restoreCheckpoint(io.cwd, p.id, name);
  const progress = resolveRun(io.cwd, p.id);
  if (r.saved) {
    (progress.checkpoints ??= []).push({ name: r.saved.name, ref: r.saved.ref, commit: r.saved.commit, at: r.saved.at });
    writeProgress(progress);
  }
  io.data({ runId: p.id, restored: r.restored.name, removed: r.removed, saved: r.saved?.ref ?? null });
  io.out(`restored ${p.id}/${name}${r.removed.length ? `; removed ${r.removed.length} file(s) added since` : ""}${r.saved ? `; undo: mola go rewind ${p.id} pre-rewind --yes` : ""}`);
  return ExitCode.Ok;
}

/** `+30m`, `+2h`, `+1d`, or anything Date.parse reads. */
export function parseWhen(text: string, now = Date.now()): number | undefined {
  const rel = /^\+(\d+)\s*(m|min|h|d)$/i.exec(text.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    return now + n * (unit === "d" ? 86400000 : unit === "h" ? 3600000 : 60000);
  }
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : t;
}

export function cmdLater(io: Io, id: string | undefined, at: string | undefined, clear: boolean): ExitCode {
  const p = resolveRun(io.cwd, id);
  if (clear) {
    delete p.resumeAt;
    writeProgress(p);
    io.data({ runId: p.id, resumeAt: null });
    io.out(`${p.id}: no scheduled resume`);
    return ExitCode.Ok;
  }
  if (!at) throw new MolaError("USAGE_ERROR", "usage: mola go later <runId> --at <+30m|+2h|ISO time> | --clear", ExitCode.Usage);
  if (p.status === "done" || p.status === "running") throw new MolaError("USAGE_ERROR", `run ${p.id} is ${p.status}; only a stopped, failed or blocked run can be resumed later`, ExitCode.Usage);
  const when = parseWhen(at);
  if (when === undefined) throw new MolaError("USAGE_ERROR", `cannot read the time "${at}"`, ExitCode.Usage);
  p.resumeAt = new Date(when).toISOString();
  writeProgress(p);
  io.data({ runId: p.id, resumeAt: p.resumeAt });
  io.out(`${p.id} resumes at ${p.resumeAt} (needs \`mola serve\` running; cancel: mola go later ${p.id} --clear)`);
  return ExitCode.Ok;
}
