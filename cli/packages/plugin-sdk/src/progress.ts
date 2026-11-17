/**
 * Shared run-progress contract for mstack 1.0 (FRAMEWORK.md §13): `mola go`
 * writes it, `mola statusline`, `mola dash` and `mola web` read it, and the
 * Claude Code `/go` command writes the same file. One file per run:
 * <cwd>/.mstack/runs/<id>/progress.json, plus approvals/<approvalId>.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type StageName = "think" | "plan" | "implement" | "verify" | "review" | "ship";
export const STAGES: readonly StageName[] = ["think", "plan", "implement", "verify", "review", "ship"];

export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped" | "blocked";
export type WorkerStatus = "working" | "blocked" | "idle" | "done" | "failed";
export type RunStatus = "running" | "blocked" | "done" | "failed" | "stopped";

export interface StageProgress {
  name: StageName;
  status: StageStatus;
  model?: string;
  agent?: string;
  startedAt?: string;
  endedAt?: string;
  costUsd?: number;
  /** one line: what this stage produced or why it failed */
  summary?: string;
  /** artifact path relative to the run dir, e.g. "plan.md" */
  artifact?: string;
}

export interface WorkerProgress {
  id: string;
  stage: StageName;
  status: WorkerStatus;
  model?: string;
  agent?: string;
  pid?: number;
  startedAt?: string;
  updatedAt?: string;
  costUsd?: number;
  /** last line of output, for live views */
  lastLine?: string;
}

export interface Approval {
  id: string;
  runId: string;
  stage: StageName;
  /** what will happen if approved, e.g. "git push origin feat/x and open a PR" */
  action: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface RunProgress {
  schemaVersion: 1;
  id: string;
  intent: string;
  cwd: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  /** stage currently running (or the last one reached) */
  stage: StageName;
  stages: StageProgress[];
  workers: WorkerProgress[];
  costUsd: number;
  /** set while status === "blocked" */
  blocked?: { reason: string; approvalId?: string };
  /** one line: what happens next, or what the user should do */
  next?: string;
  /** where this run came from: "cli" (mola go), "claude-code" (/go), "trigger" */
  origin?: string;
}

export const runsRoot = (cwd: string): string => path.join(cwd, ".mstack", "runs");
export const runDir = (cwd: string, id: string): string => path.join(runsRoot(cwd), id);
export const progressPath = (cwd: string, id: string): string => path.join(runDir(cwd, id), "progress.json");
export const approvalPath = (cwd: string, runId: string, approvalId: string): string =>
  path.join(runDir(cwd, runId), "approvals", `${approvalId}.json`);

/** Write JSON atomically (temp file + rename) so readers never see half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readProgress(cwd: string, id: string): RunProgress | undefined {
  const p = readJson<RunProgress>(progressPath(cwd, id));
  return p && p.schemaVersion === 1 ? p : undefined;
}

export function writeProgress(p: RunProgress): void {
  p.updatedAt = new Date().toISOString();
  p.costUsd = round(p.stages.reduce((s, x) => s + (x.costUsd ?? 0), 0));
  writeJsonAtomic(progressPath(p.cwd, p.id), p);
}

/** All runs under <cwd>/.mstack/runs that have a progress.json, newest first. */
export function listProgress(cwd: string): RunProgress[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(runsRoot(cwd));
  } catch {
    return [];
  }
  const out: RunProgress[] = [];
  for (const id of ids) {
    const p = readProgress(cwd, id);
    if (p) out.push(p);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The run a live view should show: newest running/blocked run, else undefined. */
export function activeProgress(cwd: string): RunProgress | undefined {
  return listProgress(cwd).find((p) => p.status === "running" || p.status === "blocked");
}

export function readApproval(cwd: string, runId: string, approvalId: string): Approval | undefined {
  return readJson<Approval>(approvalPath(cwd, runId, approvalId));
}

export function writeApproval(cwd: string, a: Approval): void {
  writeJsonAtomic(approvalPath(cwd, a.runId, a.id), a);
}

/** Record a decision on a pending approval. Returns false if it is missing or already decided. */
export function decideApproval(
  cwd: string,
  runId: string,
  approvalId: string,
  approved: boolean,
  by: string,
): boolean {
  const a = readApproval(cwd, runId, approvalId);
  if (!a || a.status !== "pending") return false;
  a.status = approved ? "approved" : "denied";
  a.decidedAt = new Date().toISOString();
  a.decidedBy = by;
  writeApproval(cwd, a);
  return true;
}

/** `go ▸ verify (4/6) · 3 agents · $0.42 · 6m`, or `go ⏸ blocked: <reason>`. */
export function formatProgressLine(p: RunProgress, now = Date.now()): string {
  const active = p.stages.filter((s) => s.status !== "skipped");
  const idx = Math.max(0, active.findIndex((s) => s.name === p.stage)) + 1;
  const working = p.workers.filter((w) => w.status === "working").length;
  const mins = Math.max(0, Math.round((now - Date.parse(p.startedAt)) / 60000));
  const parts = [
    p.status === "blocked" ? `go ⏸ ${p.stage}: ${p.blocked?.reason ?? "waiting"}` : `go ▸ ${p.stage} (${idx}/${active.length})`,
    `${working} agent${working === 1 ? "" : "s"}`,
    `$${p.costUsd.toFixed(2)}`,
    `${mins}m`,
  ];
  return parts.join(" · ");
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
