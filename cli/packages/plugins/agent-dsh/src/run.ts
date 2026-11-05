/**
 * agent-dsh run surface (B2 — adapters-routing §2.10, ADR-0004 stream bridge).
 * The same tested headless flow as cmd-dispatch, as an `HeadlessAgentAdapter`:
 *
 *   bash -lc '[ -f env.sh ] && source env.sh; cd <wsl-cwd>; \
 *     dsh --profile mola-cli [--patch <overlay>] --json [--session-id <id>] \
 *     [--permission-mode workspace-write]'   (prompt on stdin)
 *
 * Flags are ONLY from cli/design/inputs/dsh-cli-help.md (--json, --session-id,
 * --permission-mode, --add-dir, --approval-policy) + the tested mola-cli
 * profile (DESIGN §11 conflict 7). Each run emits the ADR-0004 events
 * (mola.session.started / mola.agent.message / mola.turn.completed /
 * mola.task.done / mola.session.ended, plus mola.error.raised on failure) on
 * the bus and through req.onEvent, so phase 2 can persist events.jsonl.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  EventBus,
  ExecService,
  FsService,
  HookEvent,
  RunRequest,
  RunResult,
} from "@mola/plugin-sdk";
import { MolaEvents } from "@mola/plugin-sdk";
import {
  detectQuotaFailure,
  firstString,
  parseNdjson,
  UnsupportedCapability,
} from "@mola/plugin-sdk";
import { dshExecArgv, dshMachine, DSH_ENV_SH, onWindows, shellQuote, winToWslPath } from "./platform.js";

export const DSH_PROFILE = "mola-cli";
/** mirrors `timeout 3600` in tasks/dispatch.sh */
export const DSH_RUN_TIMEOUT_MS = 3_600_000;
/** the only permission preset captured in dsh-cli-help.md */
export const DSH_PERMISSION_PRESET = "workspace-write";

export interface DshRunDeps {
  exec: ExecService;
  events: EventBus;
  fs: FsService;
}

export interface DshRunPlan {
  /** absolute POSIX cwd inside WSL (e.g. /mnt/e/mstack); undefined = unmappable */
  cwdPosix?: string;
  /** overlay reference relative to cwd, when a modelRoute was requested */
  overlayPath?: string;
  sessionId?: string;
  permissionMode?: string;
  /** extra dirs, already mapped into WSL paths (--add-dir, dsh-cli-help.md) */
  addDirs?: string[];
}

/**
 * The headless script. The prompt is NOT in the script — it goes to stdin
 * (`echo "run the tests" | dsh --profile headless`, dsh-cli-help.md line 129),
 * so no quoting can break the task text.
 */
export function dshRunScript(plan: DshRunPlan): string {
  const parts = [`[ -f ${DSH_ENV_SH} ] && source ${DSH_ENV_SH}`];
  if (plan.cwdPosix) parts.push(`cd ${shellQuote(plan.cwdPosix)}`);
  let dsh = `dsh --profile ${DSH_PROFILE}`;
  if (plan.overlayPath) dsh += ` --patch ${shellQuote(plan.overlayPath)}`;
  dsh += " --json";
  if (plan.sessionId) dsh += ` --session-id ${shellQuote(plan.sessionId)}`;
  if (plan.permissionMode) dsh += ` --permission-mode ${shellQuote(plan.permissionMode)}`;
  for (const dir of plan.addDirs ?? []) dsh += ` --add-dir ${shellQuote(dir)}`;
  parts.push(dsh);
  return parts.join("; ");
}

export function dshRunArgv(script: string, windows = onWindows()): string[] {
  return dshExecArgv(script, windows);
}

/** The per-run model overlay (same shape as cmd-dispatch's overlayYaml). */
export function dshOverlayYaml(route: string): string {
  return `- id: agent-default-model\n  config:\n    provider: magpie\n    model: ${route}\n`;
}

interface StreamParse {
  sessionId?: string;
  finalText: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  messages: string[];
  /** the harness's own error message (turn_end reason.kind === "error"), when any */
  errorDetail?: string;
}

/**
 * Parse `dsh --json` NDJSON run events. Verified against the real
 * `dsh --profile mola-cli --json` stream ({"type":"session","sessionId":…},
 * {"type":"status","phase":"turn_start|turn_end","turn":n},
 * {"type":"final","text":…}) with lenient fallbacks for drift. Plain
 * (non-NDJSON) stdout falls through as the answer itself.
 */
export function parseDshStream(stdout: string): StreamParse {
  const events = parseNdjson(stdout);
  const messages: string[] = [];
  let finalText = "";
  let usage: StreamParse["usage"];
  let sessionId: string | undefined;
  let errorDetail: string | undefined;
  for (const ev of events) {
    sessionId = firstString(ev, ["sessionId", "session_id", "id"]) ?? sessionId;
    // {"type":"final","text":…} is the real final-answer event; the other keys
    // are the lenient fallback for older/other profiles
    const text =
      (ev.type === "final" && typeof ev.text === "string" ? ev.text : undefined) ??
      firstString(ev, ["result", "text", "message", "answer", "content"]);
    if (text) {
      finalText = text;
      messages.push(text);
    }
    // {"phase":"turn_end","reason":{"kind":"error","error":{"message":…}}}
    const reason = (typeof ev.reason === "object" && ev.reason !== null ? ev.reason : undefined) as
      | Record<string, unknown>
      | undefined;
    const nested = (typeof reason?.error === "object" && reason.error !== null ? reason.error : undefined) as
      | Record<string, unknown>
      | undefined;
    const detail = (nested ? firstString(nested, ["message"]) : undefined) ?? firstString(ev, ["error"]);
    if (detail) errorDetail = detail;
    const u = ev.usage;
    if (typeof u === "object" && u !== null) {
      const uu = u as Record<string, unknown>;
      usage = {
        inputTokens: typeof uu.input_tokens === "number" ? uu.input_tokens : usage?.inputTokens,
        outputTokens: typeof uu.output_tokens === "number" ? uu.output_tokens : usage?.outputTokens,
      };
    }
  }
  if (events.length === 0) finalText = stdout.trim();
  return { sessionId, finalText, usage, messages, ...(errorDetail ? { errorDetail } : {}) };
}

/** The ADR-0004 envelope the adapter emits (bus + onEvent get the same object). */
function envelope(
  kind: string,
  agent: string,
  machine: string,
  data: Record<string, unknown>,
  runId: string,
  sessionId?: string,
  raw?: unknown,
): HookEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    kind,
    source: { agent, machine, sessionId, runId },
    data,
    ...(raw !== undefined ? { raw } : {}),
  };
}

/** Run one headless dsh task (req.sessionId set ⇒ `--session-id` resume). */
export async function runDsh(deps: DshRunDeps, req: RunRequest): Promise<RunResult> {
  const machine = dshMachine();
  const runId = req.runId ?? `run-${randomUUID().slice(0, 8)}`;
  const windows = onWindows();
  const cwdPosix = windows ? winToWslPath(req.cwd) : req.cwd.replace(/\/+$/, "");
  if (!cwdPosix) {
    throw new UnsupportedCapability(
      "dsh",
      `cwd mapping (cannot map ${req.cwd} into WSL)`,
    );
  }

  let overlayPath: string | undefined;
  if (req.modelRoute) {
    overlayPath = path.join(".mstack", "runs", runId, "model-overlay.yml");
    deps.fs.writeFile(path.join(req.cwd, overlayPath), dshOverlayYaml(req.modelRoute));
  }

  const plan: DshRunPlan = {
    cwdPosix,
    ...(overlayPath ? { overlayPath } : {}),
    ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    // read-only/plan/full-auto have no captured preset — never invented
    ...(req.permissionProfile === "workspace-write" ? { permissionMode: DSH_PERMISSION_PRESET } : {}),
    // --add-dir wants a physical absolute directory — map Windows paths once
    ...(req.addDirs?.length
      ? { addDirs: req.addDirs.map((d) => (windows ? (winToWslPath(d) ?? d) : d)) }
      : {}),
  };
  const argv = dshRunArgv(dshRunScript(plan), windows);

  const events: HookEvent[] = [];
  const tap = (e: HookEvent) => {
    events.push(e);
    deps.events.emit(e.kind, e.data, e.source);
    req.onEvent?.(e);
  };

  tap(
    envelope(
      MolaEvents.SessionStarted,
      "dsh",
      machine,
      {
        ...(req.sessionId ? { sessionId: req.sessionId, resumed: true } : {}),
        cwd: req.cwd,
        machine,
        ...(req.modelRoute ? { modelRoute: req.modelRoute } : {}),
        // tell the router which permission mode is actually in effect
        permissionMode: plan.permissionMode ?? null,
        argv,
      },
      runId,
      req.sessionId,
    ),
  );

  const t0 = Date.now();
  let res;
  try {
    res = await deps.exec.exec(argv, {
      cwd: req.cwd,
      input: req.prompt,
      timeoutMs: req.timeoutMs ?? DSH_RUN_TIMEOUT_MS,
      env: { ...(windows ? { MSYS_NO_PATHCONV: "1" } : {}), ...(req.env ?? {}) },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    tap(envelope(MolaEvents.ErrorRaised, "dsh", machine, { kind: "crash", detail }, runId, req.sessionId));
    tap(envelope(MolaEvents.SessionEnded, "dsh", machine, { sessionId: req.sessionId, exitCode: 124, reason: "aborted" }, runId, req.sessionId));
    throw err;
  }

  const parsed = parseDshStream(res.stdout);
  const sessionId = parsed.sessionId ?? req.sessionId;
  const quota = detectQuotaFailure(`${res.stderr}\n${res.stdout}`, req.modelRoute);

  let lastMessage = "";
  for (const text of parsed.messages) {
    if (text === lastMessage) continue; // the same text often arrives as an agent/* event AND the result
    lastMessage = text;
    tap(
      envelope(MolaEvents.AgentMessage, "dsh", machine, { sessionId, role: "assistant", textExcerpt: text.slice(0, 400) }, runId, sessionId),
    );
  }
  tap(
    envelope(
      MolaEvents.TurnCompleted,
      "dsh",
      machine,
      { sessionId, turnId: runId, durationMs: Date.now() - t0, exitCode: res.code, ...(parsed.usage ? { usage: parsed.usage } : {}) },
      runId,
      sessionId,
    ),
  );
  if (res.code === 0) {
    tap(envelope(MolaEvents.TaskDone, "dsh", machine, { runId, sessionId }, runId, sessionId));
  } else {
    tap(
      envelope(
        MolaEvents.ErrorRaised,
        "dsh",
        machine,
        {
          kind: quota ? "quota" : "crash",
          sessionId,
          detail: parsed.errorDetail ?? `dsh exited ${res.code}`,
        },
        runId,
        sessionId,
      ),
    );
  }
  tap(
    envelope(MolaEvents.SessionEnded, "dsh", machine, { sessionId, exitCode: res.code }, runId, sessionId),
  );

  return {
    ...(sessionId ? { sessionId } : {}),
    exitCode: res.code,
    finalText: parsed.finalText,
    ...(parsed.usage
      ? { usage: { source: "agent" as const, ...parsed.usage } } // token counts from the agent's own stream; cost stays with magpie
      : {}),
    ...(quota ? { quotaFailure: quota } : {}),
    events,
  };
}
