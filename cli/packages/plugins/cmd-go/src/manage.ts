/**
 * `mola go status | list | approve | deny | stop` — the read and control side
 * of a run. Everything goes through the shared progress contract; the running
 * `mola go` process picks decisions and the STOP flag up by polling.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Io } from "@mola/plugin-sdk";
import {
  ExitCode,
  MolaError,
  decideApproval,
  formatDuration,
  formatProgressLine,
  listProgress,
  readApproval,
  readProgress,
  runDir,
  table,
  type RunProgress,
} from "@mola/plugin-sdk";
import { stopFile } from "./engine.js";

/** Exact id, else the unique run whose id starts with / ends with the given text; default: newest run. */
export function resolveRun(cwd: string, idOrPrefix?: string): RunProgress {
  const all = listProgress(cwd);
  if (!idOrPrefix) {
    if (all.length === 0) throw new MolaError("NO_INPUT", "no runs yet (start one with: mola go \"<intent>\")", ExitCode.NoInput);
    return all[0];
  }
  const exact = readProgress(cwd, idOrPrefix);
  if (exact) return exact;
  const hits = all.filter((p) => p.id.startsWith(idOrPrefix) || p.id.endsWith(idOrPrefix));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new MolaError("USAGE_ERROR", `"${idOrPrefix}" matches ${hits.length} runs: ${hits.map((h) => h.id).join(", ")}`, ExitCode.Usage);
  throw new MolaError("NO_INPUT", `no such run: ${idOrPrefix}`, ExitCode.NoInput);
}

function elapsed(p: RunProgress, s: RunProgress["stages"][number]): string {
  if (!s.startedAt) return "";
  const end = s.endedAt ? Date.parse(s.endedAt) : Date.now();
  return formatDuration(Math.max(0, end - Date.parse(s.startedAt)));
}

export function statusLines(p: RunProgress): string[] {
  const rows = p.stages.map((s) => [
    s.name,
    s.status,
    s.model ?? "",
    s.costUsd ? `$${s.costUsd.toFixed(2)}` : "",
    elapsed(p, s),
    s.summary ?? "",
  ]);
  const lines = [
    formatProgressLine(p),
    `${p.id} · ${p.status} · ${p.intent}`,
    "",
    ...table({ header: ["stage", "status", "model", "cost", "time", "summary"], rows, indent: "  " }),
  ];
  const working = p.workers.filter((w) => w.status === "working");
  for (const w of working) lines.push("", `  ▸ ${w.id} ${w.agent ?? ""} ${w.model ?? ""}${w.lastLine ? ` — ${w.lastLine}` : ""}`.trimEnd());
  if (p.blocked) lines.push("", `  ⏸ ${p.blocked.reason}`);
  if (p.next) lines.push("", `  next: ${p.next}`);
  return lines;
}

export function cmdStatus(io: Io, id?: string): ExitCode {
  const p = resolveRun(io.cwd, id);
  if (io.json) {
    io.data(p);
    return ExitCode.Ok;
  }
  for (const l of statusLines(p)) io.out(l);
  io.data(p);
  return ExitCode.Ok;
}

export function cmdList(io: Io): ExitCode {
  const runs = listProgress(io.cwd);
  if (io.json) {
    io.data(runs);
    return ExitCode.Ok;
  }
  if (runs.length === 0) {
    io.out('no runs yet — try: mola go "<what you want done>"');
  } else {
    const rows = runs.map((p) => [p.id, p.status, p.stage, `$${p.costUsd.toFixed(2)}`, p.intent.replace(/\s+/g, " ").slice(0, 60)]);
    for (const l of table({ header: ["run", "status", "stage", "cost", "intent"], rows })) io.out(l);
  }
  io.data(runs);
  return ExitCode.Ok;
}

/** The approval a bare `approve <run>` means: the run's blocked.approvalId, else the only pending one on disk. */
export function pendingApprovalId(cwd: string, p: RunProgress): string | undefined {
  if (p.blocked?.approvalId) {
    const a = readApproval(cwd, p.id, p.blocked.approvalId);
    if (a?.status === "pending") return a.id;
  }
  try {
    const dir = path.join(runDir(cwd, p.id), "approvals");
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const a = readApproval(cwd, p.id, f.slice(0, -5));
      if (a?.status === "pending") return a.id;
    }
  } catch {
    // no approvals dir
  }
  return undefined;
}

export function cmdDecide(io: Io, approved: boolean, runId: string | undefined, approvalId?: string): ExitCode {
  if (!runId) throw new MolaError("USAGE_ERROR", `usage: mola go ${approved ? "approve" : "deny"} <runId> [approvalId]`, ExitCode.Usage);
  const p = resolveRun(io.cwd, runId);
  const id = approvalId ?? pendingApprovalId(io.cwd, p);
  if (!id) throw new MolaError("NO_INPUT", `run ${p.id} has no pending approval`, ExitCode.NoInput);
  if (!decideApproval(io.cwd, p.id, id, approved, "cli")) {
    throw new MolaError("NO_INPUT", `approval ${id} of ${p.id} is missing or already decided`, ExitCode.NoInput);
  }
  const verb = approved ? "approved" : "denied";
  io.data({ runId: p.id, approvalId: id, status: verb, by: "cli" });
  io.out(`${verb} ${id} (${p.id})`);
  return ExitCode.Ok;
}

export function cmdStop(io: Io, runId: string | undefined): ExitCode {
  if (!runId) throw new MolaError("USAGE_ERROR", "usage: mola go stop <runId>", ExitCode.Usage);
  const p = resolveRun(io.cwd, runId);
  if (p.status !== "running" && p.status !== "blocked") {
    io.out(`${p.id} is already ${p.status} — nothing to stop`);
    io.data({ runId: p.id, stopped: false, status: p.status });
    return ExitCode.Ok;
  }
  fs.mkdirSync(runDir(io.cwd, p.id), { recursive: true });
  fs.writeFileSync(stopFile(io.cwd, p.id), new Date().toISOString() + "\n", "utf8");
  io.data({ runId: p.id, stopped: true });
  io.out(`stop requested for ${p.id} — the run stops at its next check`);
  return ExitCode.Ok;
}
