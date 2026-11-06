/**
 * agent-claude run surface (B2 — adapters-routing §2.1, ADR-0004). Grounded in
 * claude-help.txt ONLY:
 *
 *   claude -p <prompt> --output-format stream-json --include-hook-events
 *     --permission-mode <acceptEdits|plan|bypassPermissions> [--model <route>]
 *     [--max-budget-usd <n>] [--add-dir <d>...] [--settings <json>]
 *     [--resume <id> | -c] [--fork-session]
 *
 * Stream bridge: the stream-json lines are parsed leniently (system/assistant/
 * result shapes) into the ADR-0004 events (mola.session.started /
 * mola.agent.message / mola.turn.completed / mola.task.done /
 * mola.session.ended). Native-hook bridge (ADR-0004 §3 bridge A): a per-run
 * `--settings` JSON carrying a hooks block whose commands are a generated
 * `hook-sink.cjs` under `.mstack/runs/<runId>/` (file sink — the localhost
 * `mola hook-ingest` endpoint arrives later and only changes `transport`),
 * plus `--include-hook-events` as corroboration. Nothing is persisted into
 * claude's own config (magpie rewrites drift within ~15 s).
 *
 * Model: magpie owns it. `modelRoute` is applied per-run through claude's own
 * `--model` (the escape hatch adapters-routing §1.1 allows) and `setModel()`
 * is ALWAYS `magpie claude <route>`.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  EventBus,
  ExecService,
  FsService,
  HookEvent,
  PermissionProfile,
  RunRequest,
  RunResult,
  SessionRef,
  Usage,
  UsageScope,
} from "@mola/plugin-sdk";
import { detectQuotaFailure, MolaEvents, parseMagpieUsageCsv, parseNdjson, UnsupportedCapability } from "@mola/plugin-sdk";
import { winSafeArgv } from "./platform.js";
import { machineOf } from "./detect.js";

export const CLAUDE_BIN = "claude";
export const MAGPIE_BIN = "magpie";

export const CLAUDE_CAPABILITIES = {
  headless: true, // -p / --print
  headlessJsonStream: true, // --output-format stream-json (print mode only)
  resume: true, // --resume <session-id>
  continueLatest: true, // -c / --continue
  forkSession: true, // --fork-session (with --resume/--continue)
  listSessions: false, // `claude agents` lists BACKGROUND sessions only; historical via magpie sessions
  acp: false,
  nativeHooks: true, // settings hooks + --settings + --include-hook-events
  backgroundSessions: true, // --bg + claude attach/logs/stop/rm
  worktree: true, // -w/--worktree
  budgetCap: true, // --max-budget-usd (print mode — exactly our case)
  costReadout: "magpie",
} as const;

/**
 * permissionProfile → `--permission-mode` (adapters-routing §2.1: read-only has
 * no captured flag; the smallest truthful mapping is plan = read-only-ish).
 * Default is acceptEdits (the workspace-write-ish mode the design sketches use).
 */
export function permissionModeOf(profile?: PermissionProfile): string {
  switch (profile) {
    case "plan":
    case "read-only":
      return "plan";
    case "full-auto":
      return "bypassPermissions";
    case "workspace-write":
    default:
      return "acceptEdits";
  }
}

/** The per-run hook sink the injected `--settings` points at (written by mola). */
export function hookSinkScript(): string {
  return [
    "// mola hook sink (generated per run by mola agent-claude — ADR-0004 §3).",
    "// One JSON line per native hook payload, into hooks.jsonl next to this file.",
    'let d = "";',
    'process.stdin.on("data", (c) => (d += c));',
    'process.stdin.on("end", () => {',
    "  let payload = {};",
    '  try { payload = JSON.parse(d || "{}"); } catch {}',
    '  const line = JSON.stringify({ ts: new Date().toISOString(), hook_event_name: payload.hook_event_name, session_id: payload.session_id, payload });',
    '  require("fs").appendFileSync(require("path").join(__dirname, "hooks.jsonl"), line + "\\n");',
    "});",
  ].join("\n");
}

/**
 * The per-run `--settings` payload (bridge A). Session-lifecycle hooks only —
 * per-tool hook events ride `--include-hook-events` in the stream instead of
 * spawning a process per tool call.
 *
 * Honesty note (honesty list #6): the hook event names come from Claude Code's
 * external docs, not the captured help, and cannot be verified at detect time
 * on a machine without the binary. The bridge is therefore fail-soft: a name
 * mismatch leaves the hook unfired while the stream channel
 * (`--include-hook-events`, a captured flag) still carries the events.
 */
export function buildHookSettings(runId: string): Record<string, unknown> {
  // the sink lives in the run dir this run generated; the command is relative
  // to claude's cwd (= req.cwd), so it must match the written path exactly
  const sink = { hooks: [{ type: "command", command: `node .mstack/runs/${runId}/hook-sink.cjs` }] };
  return { hooks: { SessionStart: [sink], Stop: [sink], SessionEnd: [sink] } };
}

export interface ClaudeRunDeps {
  exec: ExecService;
  events: EventBus;
  fs: FsService;
  /** inject the per-run native-hook bridge (default: true) */
  nativeHooks?: boolean;
  /**
   * Whether this Claude Code reaches its models through magpie. When false, a
   * magpie route (group/*, auto/*) is meaningless to it (`--model group/x` exits 1),
   * so the route is dropped and Claude uses its own model. Default: assume routed.
   */
  magpieRouted?: boolean;
}

/** Does Claude Code talk to magpie? (ANTHROPIC_BASE_URL in the process env or ~/.claude/settings.json) */
export function claudeUsesMagpie(processEnv: NodeJS.ProcessEnv, settingsText: string | undefined): boolean {
  const viaMagpie = (u: unknown): boolean => typeof u === "string" && /(127\.0\.0\.1|localhost):3425|magpie/i.test(u);
  if (viaMagpie(processEnv.ANTHROPIC_BASE_URL)) return true;
  try {
    const s = settingsText ? (JSON.parse(settingsText) as { env?: Record<string, unknown> }) : undefined;
    return viaMagpie(s?.env?.ANTHROPIC_BASE_URL);
  } catch {
    return false;
  }
}

export interface ClaudeRunPlan {
  permissionMode: string;
  model?: string;
  budgetUsd?: number;
  addDirs?: string[];
  resumeId?: string;
  continueLatest?: boolean;
  fork?: boolean;
  /** the --settings JSON string, when the native-hook bridge is injected */
  settingsJson?: string;
}

export function buildClaudeArgv(prompt: string, plan: ClaudeRunPlan): string[] {
  const argv = [
    CLAUDE_BIN,
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    // claude refuses `-p --output-format stream-json` without --verbose (exit 1)
    "--verbose",
    "--include-hook-events",
    "--permission-mode",
    plan.permissionMode,
  ];
  if (plan.model) argv.push("--model", plan.model);
  if (plan.budgetUsd !== undefined) argv.push("--max-budget-usd", String(plan.budgetUsd));
  for (const dir of plan.addDirs ?? []) argv.push("--add-dir", dir);
  if (plan.resumeId) argv.push("--resume", plan.resumeId);
  else if (plan.continueLatest) argv.push("-c");
  if (plan.fork && (plan.resumeId || plan.continueLatest)) argv.push("--fork-session");
  if (plan.settingsJson) argv.push("--settings", plan.settingsJson);
  return argv;
}

export interface ClaudeStreamParse {
  sessionId?: string;
  finalText: string;
  messages: string[];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  isError?: boolean;
}

/**
 * Lenient stream-json parse: `system/subtype:init` carries session_id;
 * `assistant` messages carry content text blocks; `result` carries the final
 * text, usage and total_cost_usd. Unrecognized lines (hook events, partial
 * chunks) are skipped — never invented into mola events.
 */
export function parseClaudeStream(stdout: string): ClaudeStreamParse {
  const events = parseNdjson(stdout);
  const messages: string[] = [];
  let finalText = "";
  let sessionId: string | undefined;
  let usage: ClaudeStreamParse["usage"];
  let isError: boolean | undefined;
  for (const ev of events) {
    const type = typeof ev.type === "string" ? ev.type : undefined;
    if (typeof ev.session_id === "string" && ev.session_id) sessionId = ev.session_id;
    if (type === "assistant" && typeof ev.message === "object" && ev.message !== null) {
      const content = (ev.message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
          .map((b) => String((b as Record<string, unknown>).text ?? ""))
          .join("")
          .trim();
        if (text) {
          messages.push(text);
          finalText = text;
        }
      }
    }
    if (type === "result") {
      if (typeof ev.result === "string") finalText = ev.result;
      if (typeof ev.is_error === "boolean") isError = ev.is_error;
      const u = ev.usage;
      if (typeof u === "object" && u !== null) {
        const uu = u as Record<string, unknown>;
        usage = {
          inputTokens: typeof uu.input_tokens === "number" ? uu.input_tokens : usage?.inputTokens,
          outputTokens: typeof uu.output_tokens === "number" ? uu.output_tokens : usage?.outputTokens,
          costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : usage?.costUsd,
        };
      }
    }
  }
  return { sessionId, finalText, messages, ...(usage ? { usage } : {}), ...(isError !== undefined ? { isError } : {}) };
}

function envelope(
  kind: string,
  data: Record<string, unknown>,
  runId: string,
  sessionId?: string,
  raw?: unknown,
): HookEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    kind,
    source: { agent: CLAUDE_BIN, machine: machineOf(), sessionId, runId },
    data,
    ...(raw !== undefined ? { raw } : {}),
  };
}

/** Plan the argv from a RunRequest (pure, unit-tested). */
export function planClaudeRun(req: RunRequest, deps: ClaudeRunDeps, runId: string): { plan: ClaudeRunPlan; argv: string[] } {
  const nativeHooks = deps.nativeHooks ?? true;
  let settingsJson: string | undefined;
  if (nativeHooks) {
    const sinkPath = path.join(req.cwd, ".mstack", "runs", runId, "hook-sink.cjs");
    deps.fs.writeFile(sinkPath, hookSinkScript());
    settingsJson = JSON.stringify(buildHookSettings(runId));
  }
  const resumeId = req.sessionId && req.sessionId !== "latest" ? req.sessionId : undefined;
  const plan: ClaudeRunPlan = {
    permissionMode: permissionModeOf(req.permissionProfile),
    ...(req.modelRoute && deps.magpieRouted !== false ? { model: req.modelRoute } : {}),
    ...(req.budgetUsd !== undefined ? { budgetUsd: req.budgetUsd } : {}),
    ...(req.addDirs?.length ? { addDirs: req.addDirs } : {}),
    ...(resumeId ? { resumeId } : {}),
    ...(req.sessionId === "latest" ? { continueLatest: true } : {}),
    ...(req.fork ? { fork: true } : {}),
    ...(settingsJson ? { settingsJson } : {}),
  };
  return { plan, argv: buildClaudeArgv(req.prompt, plan) };
}

/** One headless claude run (req.sessionId set ⇒ resume; `"latest"` ⇒ -c). */
export async function runClaude(deps: ClaudeRunDeps, req: RunRequest): Promise<RunResult> {
  const runId = req.runId ?? `run-${randomUUID().slice(0, 8)}`;
  const machine = machineOf();
  const { plan, argv } = planClaudeRun(req, deps, runId);

  const events: HookEvent[] = [];
  const tap = (e: HookEvent) => {
    events.push(e);
    deps.events.emit(e.kind, e.data, e.source);
    req.onEvent?.(e);
  };
  tap(
    envelope(
      MolaEvents.SessionStarted,
      {
        ...(req.sessionId ? { sessionId: req.sessionId, resumed: true } : {}),
        cwd: req.cwd,
        machine,
        permissionMode: plan.permissionMode,
        ...(req.modelRoute ? { modelRoute: req.modelRoute } : {}),
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
      timeoutMs: req.timeoutMs,
      env: { ...(req.env ?? {}) },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    tap(envelope(MolaEvents.ErrorRaised, { kind: "crash", detail }, runId, req.sessionId));
    tap(
      envelope(MolaEvents.SessionEnded, { sessionId: req.sessionId, exitCode: 124, reason: "aborted" }, runId, req.sessionId),
    );
    throw err;
  }

  const parsed = parseClaudeStream(res.stdout);
  const sessionId = parsed.sessionId ?? req.sessionId;
  const quota = res.code === 0 ? undefined : detectQuotaFailure(`${res.stderr}\n${res.stdout}`, req.modelRoute);
  let lastMessage = "";
  for (const text of parsed.messages) {
    if (text === lastMessage) continue;
    lastMessage = text;
    tap(
      envelope(MolaEvents.AgentMessage, { sessionId, role: "assistant", textExcerpt: text.slice(0, 400) }, runId, sessionId),
    );
  }
  tap(
    envelope(
      MolaEvents.TurnCompleted,
      {
        sessionId,
        turnId: runId,
        durationMs: Date.now() - t0,
        exitCode: res.code,
        ...(parsed.usage ? { usage: parsed.usage } : {}),
      },
      runId,
      sessionId,
    ),
  );
  if (res.code === 0 && !parsed.isError) {
    tap(envelope(MolaEvents.TaskDone, { runId, sessionId }, runId, sessionId));
  } else {
    tap(
      envelope(
        MolaEvents.ErrorRaised,
        { kind: quota ? "quota" : "crash", sessionId, detail: (res.stderr || "").trim().split(/\r?\n/).pop() || `${CLAUDE_BIN} exited ${res.code}` },
        runId,
        sessionId,
      ),
    );
  }
  tap(envelope(MolaEvents.SessionEnded, { sessionId, exitCode: res.code }, runId, sessionId));

  return {
    ...(sessionId ? { sessionId } : {}),
    exitCode: res.code,
    finalText: parsed.finalText,
    ...(parsed.usage ? { usage: { source: "agent" as const, ...parsed.usage } } : {}),
    ...(quota ? { quotaFailure: quota } : {}),
    events,
  };
}

/**
 * `magpie usage <window> --csv` (magpie-help.txt line 103) — claude reports
 * tokens/cost through magpie (CLAUDE_CAPABILITIES.costReadout), never through
 * its own surfaces. Unknown/absent magpie ⇒ [].
 */
export async function claudeUsage(deps: { exec: ExecService }, scope?: UsageScope): Promise<Usage[]> {
  const window = scope?.window ?? "30d";
  let res;
  try {
    res = await deps.exec.exec(winSafeArgv([MAGPIE_BIN, "usage", window, "--csv"]), { timeoutMs: 15_000 });
  } catch {
    return [];
  }
  if (res.code !== 0) return [];
  return parseMagpieUsageCsv(res.stdout);
}

/**
 * `magpie claude <route>` — magpie owns ~/.claude (BRIEF #3 / constraint 3);
 * mola never edits the agent config itself.
 */
export async function claudeSetModel(deps: { exec: ExecService }, route: string): Promise<void> {
  const res = await deps.exec.exec(winSafeArgv([MAGPIE_BIN, "claude", route]), { timeoutMs: 30_000 });
  if (res.code !== 0) {
    throw new UnsupportedCapability(CLAUDE_BIN, `setModel(${route})`, res.stderr || `magpie exited ${res.code}`);
  }
}

/**
 * No native "list all sessions" flag exists in claude-help.txt (`claude agents`
 * lists background sessions only); historical sessions come from
 * `magpie sessions [--json]` (tool-magpie). Exposed as UnsupportedCapability —
 * never faked.
 */
export function claudeListSessionsUnsupported(): Promise<SessionRef[]> {
  throw new UnsupportedCapability(
    CLAUDE_BIN,
    "listSessions",
    "`claude agents` lists background sessions only; use magpie sessions (tool-magpie)",
  );
}
