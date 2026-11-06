/**
 * rec-runs commands (B2, core-plugins §8.1):
 *
 *   mola runs list [--limit N] [--agent <id>]   run history from the state store
 *   mola runs show <traceId>                    one run + its artifacts
 *   mola hooks list                             active bus listeners + owners
 *
 * All three respect the global --json contract (core §8.2): one envelope on
 * stdout in --json mode, human tables only outside it. Exit 0 on success, 66
 * when a requested run was never recorded.
 */

import * as path from "node:path";
import type { Command, ParsedArgs } from "@mola/plugin-sdk";
import { ExitCode, MolaError, formatDuration, statusGlyph, table } from "@mola/plugin-sdk";
import type { ListenerInfo } from "@mola/core";
import type { DecisionFile, RunEntry } from "./recorder.js";

function flagInt(v: string | boolean | undefined, fallback: number): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function short(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 12);
}

function summarize(r: RunEntry) {
  return {
    runId: r.runId,
    traceId: r.traceId,
    command: r.command,
    agent: r.agent,
    machine: r.machine,
    modelRoute: r.modelRoute,
    exitCode: r.exitCode,
    status: r.status,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    runDir: r.runDir,
  };
}

function humanRunCells(r: RunEntry): string[] {
  const exit = r.exitCode === undefined ? "-" : String(r.exitCode);
  const who = r.agent ? `${r.agent}${r.machine ? `@${r.machine}` : ""}` : "-";
  return [
    statusGlyph(r.exitCode === undefined ? "warn" : r.exitCode === 0 ? "ok" : "fail"),
    r.startedAt.replace("T", " ").slice(0, 19),
    r.status,
    exit,
    r.command ?? "-",
    who,
    r.modelRoute ?? "-",
    short(r.runId),
  ];
}

const RUNS_HEADER = ["", "started", "state", "exit", "command", "agent", "route", "traceId"];

export function runsListCommand(all: () => RunEntry[]): Command {
  return {
    path: ["runs", "list"],
    description: "run history (dispatch, run) from the state store",
    async handler(args: ParsedArgs, io) {
      const limit = flagInt(args.flags.limit, 20);
      const agent = typeof args.flags.agent === "string" ? args.flags.agent : undefined;
      let rows = all().sort(
        (a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId),
      );
      if (agent) rows = rows.filter((r) => r.agent === agent);
      rows = rows.slice(0, limit);
      io.data(rows.map(summarize));
      if (!io.json) {
        for (const line of table({ header: RUNS_HEADER, rows: rows.map(humanRunCells) })) io.out(line);
        if (rows.length === 0) io.out("(no recorded runs — dispatch or run a task first)");
      }
      return ExitCode.Ok;
    },
  };
}

export interface RunShowData {
  run: ReturnType<typeof summarize>;
  decision?: DecisionFile;
  /** event kinds seen in events.jsonl, most frequent first */
  events: Array<{ kind: string; count: number }>;
}

export function runsShowCommand(
  get: (traceId: string) => RunEntry | undefined,
  readArtifact: (file: string) => string | undefined,
  runDirOf: (traceId: string) => string,
): Command {
  return {
    path: ["runs", "show"],
    description: "one recorded run: decision, exit, event kinds",
    async handler(args: ParsedArgs, io) {
      const traceId = args.positionals[0];
      if (!traceId) {
        throw new MolaError("USAGE_ERROR", "usage: mola runs show <traceId> [--json]", ExitCode.Usage);
      }
      const run = get(traceId) ?? fallbackEntry(traceId, readArtifact, runDirOf);
      if (!run) {
        throw new MolaError(
          "NO_INPUT",
          `no recorded run with traceId "${traceId}" — see "mola runs list"`,
          ExitCode.NoInput,
        );
      }

      let decision: DecisionFile | undefined;
      if (run.decisionFile) {
        const raw = readArtifact(run.decisionFile);
        if (raw) {
          try {
            decision = JSON.parse(raw) as DecisionFile;
          } catch {
            // corrupt decision.json is not fatal — the index entry still shows
          }
        }
      }

      const counts = new Map<string, number>();
      if (run.eventsFile) {
        const raw = readArtifact(run.eventsFile);
        if (raw) {
          for (const line of raw.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
              const kind = (JSON.parse(t) as { kind?: string }).kind;
              if (typeof kind === "string") counts.set(kind, (counts.get(kind) ?? 0) + 1);
            } catch {
              // one torn line must not hide the rest of the run
            }
          }
        }
      }
      const events = [...counts.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

      const data: RunShowData = { run: summarize(run), decision, events };
      io.data(data);
      if (!io.json) {
        const glyph = statusGlyph(run.exitCode === undefined ? "warn" : run.exitCode === 0 ? "ok" : "fail");
        const fields: Array<[string, string]> = [
          ["run", `${glyph}  ${run.runId} (${run.status})`],
          ["command", run.command ?? "-"],
        ];
        if (run.agent) fields.push(["agent", `${run.agent}${run.machine ? ` @ ${run.machine}` : ""}`]);
        if (run.modelRoute) fields.push(["route", run.modelRoute]);
        fields.push(["started", run.startedAt]);
        fields.push([
          "exit",
          `${run.exitCode ?? "-"}${run.durationMs !== undefined ? `  ${formatDuration(run.durationMs)}` : ""}`,
        ]);
        if (run.workspaceDir) fields.push(["workspace", run.workspaceDir]);
        for (const line of table({ rows: fields })) io.out(line);
        for (const e of events) io.out(`  event  ${e.kind} ×${e.count}`);
      }
      return ExitCode.Ok;
    },
  };
}

/**
 * Index-miss fallback: rebuild a minimal entry from the run's artifacts
 * (decision.json) — e.g. after the index was pruned, or for a traceId that
 * only exists as a state-store history row.
 */
function fallbackEntry(
  traceId: string,
  readArtifact: (file: string) => string | undefined,
  runDirOf: (traceId: string) => string,
): RunEntry | undefined {
  const runDir = runDirOf(traceId);
  const raw = readArtifact(path.join(runDir, "decision.json"));
  if (!raw) return undefined;
  try {
    const d = JSON.parse(raw) as DecisionFile;
    return {
      runId: traceId,
      traceId,
      status: "ended",
      startedAt: d.decidedAt,
      endedAt: d.endedAt,
      exitCode: d.exitCode,
      durationMs: d.durationMs,
      command: d.command,
      argv: d.argv,
      agent: d.agent,
      machine: d.machine,
      modelRoute: d.modelRoute,
      workspaceDir: d.workspaceDir,
      runDir,
      eventsFile: path.join(runDir, "events.jsonl"),
      decisionFile: path.join(runDir, "decision.json"),
    };
  } catch {
    return undefined;
  }
}

export function hooksListCommand(describe: () => ListenerInfo[]): Command {
  return {
    path: ["hooks", "list"],
    description: "active bus listeners and their owning plugins",
    async handler(_args: ParsedArgs, io) {
      const rows = describe().sort(
        (a, b) => a.event.localeCompare(b.event) || a.owner.localeCompare(b.owner) || a.kind.localeCompare(b.kind),
      );
      io.data(rows);
      if (!io.json) {
        if (rows.length === 0) {
          io.out("(no listeners registered)");
          return ExitCode.Ok;
        }
        for (const line of table({
          header: ["event", "kind", "owner"],
          rows: rows.map((r) => [r.event, r.kind, r.owner]),
        })) {
          io.out(line);
        }
      }
      return ExitCode.Ok;
    },
  };
}
