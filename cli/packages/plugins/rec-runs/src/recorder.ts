/**
 * Run recorder (B2, ADR-0004 §2): a bus listener that turns the canonical
 * broadcast events of a run into two replayable artifacts per run —
 *
 *   .mstack/runs/<runId>/events.jsonl   one envelope per line, in arrival order
 *   .mstack/runs/<runId>/decision.json  the routing decision (agent, machine,
 *                                       modelRoute, workspaceDir) + outcome
 *
 * plus a run index entry in the plugin's state namespace (`run:<runId>`) that
 * backs `mola runs list|show`. It works for every producer without editing
 * them: `mola dispatch` already emits mola.session.* / mola.task.done, and the
 * B2 `mola run` engine emits the same vocabulary (BATCHES B2). The runId is the
 * invocation's traceId (core bus stamps source.runId from it).
 *
 * Recording must never break a run: every failure is logged (broadcast
 * semantics) and swallowed; three consecutive failures would quarantine the
 * plugin through the core death-loop brake, so write errors are contained here.
 */

import * as path from "node:path";
import type { EventEnvelope, FsService, Logger, StateNamespace } from "@mola/plugin-sdk";
import { MolaEvents } from "@mola/plugin-sdk";

export interface RunEntry {
  runId: string;
  /** invocation traceId — equals runId for bus-recorded runs */
  traceId: string;
  status: "active" | "ended";
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  durationMs?: number;
  command?: string;
  argv?: string[];
  agent?: string;
  machine?: string;
  modelRoute?: string;
  workspaceDir?: string;
  runDir?: string;
  eventsFile?: string;
  decisionFile?: string;
}

export interface DecisionFile {
  schemaVersion: 1;
  runId: string;
  traceId: string;
  /** which event produced the decision, e.g. mola.session.started */
  source: string;
  decidedAt: string;
  agent?: string;
  machine?: string;
  modelRoute?: string;
  workspaceDir?: string;
  command?: string;
  argv?: string[];
  exitCode?: number;
  endedAt?: string;
  durationMs?: number;
}

/** Broadcast events the recorder follows (router bookkeeping + run vocabulary). */
export const RECORDER_EVENTS: readonly string[] = [
  MolaEvents.CommandStarted,
  MolaEvents.CommandEnded,
  MolaEvents.SessionStarted,
  MolaEvents.AgentMessage,
  MolaEvents.TurnCompleted,
  MolaEvents.AgentIdle,
  MolaEvents.ToolAfter,
  MolaEvents.PermissionRequested,
  MolaEvents.ApprovalGranted,
  MolaEvents.ApprovalDenied,
  MolaEvents.CostReported,
  MolaEvents.ErrorRaised,
  MolaEvents.TaskDone,
  MolaEvents.SessionEnded,
];

export function runKey(runId: string): string {
  return `run:${runId}`;
}

export interface RecorderDeps {
  /** the plugin's own KV namespace (persisted in ~/.mola/state.*) */
  state: StateNamespace;
  fs: FsService;
  log: Logger;
  /** workspace fallback when an event carries no cwd */
  cwd: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export class RunRecorder {
  constructor(private readonly deps: RecorderDeps) {}

  /** All recorded runs (unsorted — commands decide presentation). */
  entries(): RunEntry[] {
    const out: RunEntry[] = [];
    for (const k of this.deps.state.keys()) {
      if (!k.startsWith("run:")) continue;
      const e = this.deps.state.get<RunEntry>(k);
      if (e && typeof e.runId === "string") out.push(e);
    }
    return out;
  }

  get(traceId: string): RunEntry | undefined {
    return this.deps.state.get<RunEntry>(runKey(traceId));
  }

  /** Bus listener entry point — never throws (recording must not break runs). */
  handle(envelope: EventEnvelope): void {
    try {
      this.apply(envelope);
    } catch (err) {
      this.deps.log.warn("rec-runs: could not record event", {
        event: envelope.kind,
        runId: envelope.source?.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private apply(envelope: EventEnvelope): void {
    const runId =
      str(envelope.source?.runId) ??
      str(envelope.source?.sessionId) ??
      str((envelope.data as Record<string, unknown> | undefined)?.traceId);
    if (!runId) return; // nothing to key the run on

    const data = (envelope.data ?? {}) as Record<string, unknown>;
    const previous = this.get(runId);
    const entry: RunEntry = previous
      ? { ...previous }
      : { runId, traceId: runId, status: "active", startedAt: envelope.ts };

    switch (envelope.kind) {
      case MolaEvents.CommandStarted: {
        entry.command = str(data.path) ?? entry.command;
        entry.argv = Array.isArray(data.argv) ? (data.argv as string[]).map(String) : entry.argv;
        break;
      }
      case MolaEvents.SessionStarted: {
        entry.agent = str(data.agent) ?? entry.agent;
        entry.machine = str(data.machine) ?? entry.machine;
        entry.modelRoute = str(data.modelRoute) ?? entry.modelRoute;
        entry.workspaceDir = str(data.cwd) ?? entry.workspaceDir;
        break;
      }
      case MolaEvents.SessionEnded:
      case MolaEvents.CommandEnded: {
        if (data.exitCode !== undefined) entry.exitCode = Number(data.exitCode);
        if (data.durationMs !== undefined) entry.durationMs = Number(data.durationMs);
        if (entry.status !== "ended") {
          entry.status = "ended";
          entry.endedAt = envelope.ts;
          if (entry.durationMs === undefined && entry.startedAt) {
            const t0 = Date.parse(entry.startedAt);
            const t1 = Date.parse(envelope.ts);
            if (Number.isFinite(t0) && Number.isFinite(t1)) entry.durationMs = Math.max(0, t1 - t0);
          }
        }
        break;
      }
      default:
        break;
    }

    // per-run artifacts live under the workspace that produced the run
    const workspace = entry.workspaceDir ?? this.deps.cwd;
    entry.runDir = path.join(workspace, ".mstack", "runs", runId);
    entry.eventsFile = path.join(entry.runDir, "events.jsonl");
    entry.decisionFile = path.join(entry.runDir, "decision.json");

    this.appendLine(entry.eventsFile, JSON.stringify(envelope));
    if (envelope.kind === MolaEvents.SessionStarted || envelope.kind === MolaEvents.SessionEnded) {
      this.writeDecision(entry, envelope);
    }

    this.deps.state.set(runKey(runId), entry);
  }

  /** decision.json — the RouteDecision record (DESIGN §5) plus the outcome. */
  private writeDecision(entry: RunEntry, envelope: EventEnvelope): void {
    const file = entry.decisionFile as string;
    let decision: DecisionFile;
    try {
      const parsed = JSON.parse(this.deps.fs.readFile(file)) as DecisionFile;
      decision = { ...parsed, schemaVersion: 1, runId: entry.runId, traceId: entry.traceId };
    } catch {
      decision = {
        schemaVersion: 1,
        runId: entry.runId,
        traceId: entry.traceId,
        source: envelope.kind,
        decidedAt: envelope.ts,
      };
    }
    decision.agent = entry.agent;
    decision.machine = entry.machine;
    decision.modelRoute = entry.modelRoute;
    decision.workspaceDir = entry.workspaceDir;
    decision.command = entry.command;
    decision.argv = entry.argv;
    if (entry.exitCode !== undefined) decision.exitCode = entry.exitCode;
    if (entry.endedAt) decision.endedAt = entry.endedAt;
    if (entry.durationMs !== undefined) decision.durationMs = entry.durationMs;
    this.deps.fs.writeFile(file, JSON.stringify(decision, null, 2) + "\n");
  }

  /** events.jsonl append; the fs service has no append, so read-modify-write. */
  private appendLine(file: string, line: string): void {
    let previous = "";
    try {
      previous = this.deps.fs.readFile(file);
    } catch {
      // new file (or unreadable → rewritten; the state index still records the run)
    }
    this.deps.fs.writeFile(file, previous + line + "\n");
  }
}
