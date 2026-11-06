/**
 * agent-codex run surface (B2 — adapters-routing §2.2, ADR-0004). Grounded in
 * codex-help.txt ONLY:
 *
 *   codex exec [OPTIONS] [PROMPT]
 *     --sandbox <read-only|workspace-write|danger-full-access>   (top-level -s)
 *     -a never (headless) · -m <model> · --add-dir <d>...
 *     --json            (exec surface, confirmed by the detect-time probe)
 *     codex exec resume <id> | --last   (probe-gated; honesty list #3)
 *
 * Approval policy is always `never` in headless runs (failures return to the
 * model, not to a human). `full-auto` maps to `--sandbox danger-full-access`
 * and stays behind the router's approval gate (constraint 7). No budget-cap
 * flag exists for codex — budget enforcement is the router's job (declared
 * capability gap, never hidden). Stream bridge: the `--json` JSONL is parsed
 * leniently into the ADR-0004 events; without `--json` the plain stdout is
 * the final answer. `--dangerously-bypass-hook-trust` is NEVER passed (DESIGN
 * §11 conflict 4) — the codex bridge is the stream, not hook injection.
 *
 * Model: magpie owns it (`magpie codex <route>`); `modelRoute` rides codex's
 * own `-m` as the per-run escape hatch, same contract as agent-claude.
 */

import { randomUUID } from "node:crypto";
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
import { machineOf, probeCodexExec, NO_EXEC_SURFACE, type CodexExecSurface } from "./detect.js";
import type { AgentCapabilities } from "@mola/plugin-sdk";

export const CODEX_BIN = "codex";
export const MAGPIE_BIN = "magpie";

/**
 * What the captured help guarantees. `headlessJsonStream`/`resume`/`worktree`
 * are refined at detect() time from the `codex exec --help` probe —
 * capabilities are never claimed ahead of evidence.
 */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  headless: true, // codex exec
  headlessJsonStream: false, // probed (exec --json is not in the captured help)
  resume: false, // probed (codex resume is interactive; exec resume not captured)
  continueLatest: false, // probed (resume --last)
  forkSession: false, // codex fork is interactive
  listSessions: true, // codex agents (shared app-server daemon sessions)
  acp: false,
  nativeHooks: false, // hooks.json exists but trust gates make per-run injection unsafe — stream bridge only
  backgroundSessions: false,
  worktree: false, // probed (--worktree)
  budgetCap: false, // no budget flag in the captured help — router enforces
  costReadout: "magpie",
};

export interface CodexRunDeps {
  exec: ExecService;
  events: EventBus;
  /** the exec surface confirmed at detect time (probed lazily when omitted) */
  surface?: CodexExecSurface;
  /** present when the adapter runs with a real context: reads the
   * --output-last-message file back as the finalText fallback */
  fs?: FsService;
}

export function sandboxOf(profile?: PermissionProfile): string {
  switch (profile) {
    case "plan":
    case "read-only":
      return "read-only";
    case "full-auto":
      return "danger-full-access";
    case "workspace-write":
    default:
      return "workspace-write";
  }
}

export interface CodexRunPlan {
  sandbox?: string;
  json: boolean;
  model?: string;
  addDirs?: string[];
  lastMessageFile?: string;
}

/**
 * The exec argv. `--sandbox` / `-a never` are pushed ONLY when the
 * `codex exec --help` probe confirmed them (captured top-level help alone is
 * not evidence for the exec subcommand). A probe that confirmed nothing means
 * the exec surface is unverified ⇒ fail closed (UnsupportedCapability) rather
 * than firing headless flags blindly.
 */
export function buildCodexArgv(prompt: string, plan: CodexRunPlan): string[] {
  const argv = [CODEX_BIN, "exec"];
  if (plan.json) argv.push("--json");
  if (plan.model) argv.push("-m", plan.model);
  if (plan.sandbox) argv.push("--sandbox", plan.sandbox, "-a", "never");
  for (const dir of plan.addDirs ?? []) argv.push("--add-dir", dir);
  if (plan.lastMessageFile) argv.push("--output-last-message", plan.lastMessageFile);
  argv.push(prompt);
  return argv;
}

/**
 * `codex exec resume <id> [PROMPT]` / `--last` — probe-gated (§2.2). The exec
 * options ride along when the probe confirmed them, so headless invariants
 * (`-a never`) and the modelRoute survive a resume.
 */
export function buildCodexResumeArgv(
  sessionId: string | "latest",
  prompt: string,
  surface: CodexExecSurface,
  plan?: CodexRunPlan,
): string[] {
  if (!surface.resume) {
    throw new UnsupportedCapability(
      CODEX_BIN,
      "resume",
      "`codex exec resume` was not confirmed by the `codex exec --help` probe; `codex resume` is interactive",
    );
  }
  const argv = [CODEX_BIN, "exec", "resume"];
  if (sessionId === "latest") {
    if (!surface.resumeLast) {
      throw new UnsupportedCapability(CODEX_BIN, 'resume("latest")', "`--last` was not confirmed by the exec probe");
    }
    argv.push("--last");
  } else {
    argv.push(sessionId);
  }
  if (plan?.json && surface.json) argv.push("--json");
  if (plan?.model && surface.model) argv.push("-m", plan.model);
  if (plan?.sandbox && surface.sandbox) argv.push("--sandbox", plan.sandbox, "-a", "never");
  argv.push(prompt);
  return argv;
}

export interface CodexStreamParse {
  sessionId?: string;
  finalText: string;
  messages: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Lenient `codex exec --json` parse: thread/thread_id/session ids, assistant
 * message items, turn usage. Unrecognized events are skipped — codex's JSONL
 * is marked experimental upstream, so nothing is assumed.
 */
export function parseCodexStream(stdout: string): CodexStreamParse {
  const events = parseNdjson(stdout);
  const messages: string[] = [];
  let finalText = "";
  let sessionId: string | undefined;
  let usage: CodexStreamParse["usage"];
  for (const ev of events) {
    sessionId =
      (typeof ev.thread_id === "string" && ev.thread_id) ||
      (typeof ev.session_id === "string" && ev.session_id) ||
      sessionId;
    const item = (typeof ev.item === "object" && ev.item !== null ? ev.item : undefined) as
      | Record<string, unknown>
      | undefined;
    const text =
      (item && typeof item.text === "string" && item.text) ||
      (typeof ev.text === "string" && ev.text) ||
      (typeof ev.message === "string" && ev.message) ||
      "";
    if (text) {
      // assistant-shaped items only; anything else is not a message
      const itemType = item ? String(item.item_type ?? item.type ?? "assistant_message") : "assistant_message";
      if (/assistant|message|agent/.test(itemType)) {
        messages.push(text);
        finalText = text;
      }
    }
    const u = (typeof ev.usage === "object" && ev.usage !== null ? ev.usage : undefined) as
      | Record<string, unknown>
      | undefined;
    if (u) {
      usage = {
        inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : usage?.inputTokens,
        outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : usage?.outputTokens,
      };
    }
  }
  if (events.length === 0) finalText = stdout.trim();
  return { sessionId, finalText, messages, ...(usage ? { usage } : {}) };
}

function envelope(kind: string, data: Record<string, unknown>, runId: string, sessionId?: string, raw?: unknown): HookEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    kind,
    source: { agent: CODEX_BIN, machine: machineOf(), sessionId, runId },
    data,
    ...(raw !== undefined ? { raw } : {}),
  };
}

export async function codexSurface(deps: CodexRunDeps): Promise<CodexExecSurface> {
  if (deps.surface) return deps.surface;
  return probeCodexExec(deps.exec);
}

/**
 * Fail closed when the exec probe confirmed nothing (probe never ran or its
 * help was unreadable): headless flags would be guesses then.
 */
export function requireVerifiedSurface(surface: CodexExecSurface): void {
  const confirmed =
    surface.json || surface.sandbox || surface.approval || surface.model || surface.addDir || surface.outputLastMessage;
  if (!confirmed) {
    throw new UnsupportedCapability(
      CODEX_BIN,
      "headless run",
      "`codex exec --help` could not be probed — the exec flag surface is unverified, refusing to run blind",
    );
  }
}

/** Plan the argv from a RunRequest (pure, unit-tested). */
export async function planCodexRun(req: RunRequest, deps: CodexRunDeps, runId: string): Promise<{ plan: CodexRunPlan; argv: string[] }> {
  const surface = await codexSurface(deps);
  requireVerifiedSurface(surface);
  const plan: CodexRunPlan = {
    ...(surface.sandbox ? { sandbox: sandboxOf(req.permissionProfile) } : {}),
    json: surface.json,
    ...(req.modelRoute && surface.model ? { model: req.modelRoute } : {}),
    ...(req.addDirs?.length && surface.addDir ? { addDirs: req.addDirs } : {}),
    ...(surface.outputLastMessage ? { lastMessageFile: `.mstack/runs/${runId}/last-message.txt` } : {}),
  };
  return { plan, argv: buildCodexArgv(req.prompt, plan) };
}

/** One headless codex run (req.sessionId set ⇒ probe-gated exec resume). */
export async function runCodex(deps: CodexRunDeps, req: RunRequest): Promise<RunResult> {
  const runId = req.runId ?? `run-${randomUUID().slice(0, 8)}`;
  const machine = machineOf();
  const surface = await codexSurface(deps);

  // the exec probe doubles as the resume probe; ride the same plan so the
  // headless invariants and the modelRoute survive a resume. The surface is
  // probed once here and pinned for planCodexRun (no second probe).
  const planned = await planCodexRun(req, { ...deps, surface }, runId);
  const plan = planned.plan;
  const argv = req.sessionId
    ? buildCodexResumeArgv(req.sessionId, req.prompt, surface, plan)
    : planned.argv;

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
        sandbox: sandboxOf(req.permissionProfile),
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
    tap(envelope(MolaEvents.SessionEnded, { sessionId: req.sessionId, exitCode: 124, reason: "aborted" }, runId, req.sessionId));
    throw err;
  }

  const parsed = parseCodexStream(res.stdout);
  const sessionId = parsed.sessionId ?? req.sessionId;
  const quota = res.code === 0 ? undefined : detectQuotaFailure(`${res.stderr}\n${res.stdout}`, req.modelRoute);
  // --output-last-message is the deterministic final answer; stdout stays the
  // primary source, the file only fills in when the stream carried no text
  if (!parsed.finalText && plan?.lastMessageFile && deps.fs) {
    try {
      const text = deps.fs.readFile(`${req.cwd}/${plan.lastMessageFile}`).trim();
      if (text) parsed.finalText = text;
    } catch {
      /* codex did not write it — keep the stream answer */
    }
  }
  let lastMessage = "";
  for (const text of parsed.messages) {
    if (text === lastMessage) continue;
    lastMessage = text;
    tap(envelope(MolaEvents.AgentMessage, { sessionId, role: "assistant", textExcerpt: text.slice(0, 400) }, runId, sessionId));
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
  if (res.code === 0) {
    tap(envelope(MolaEvents.TaskDone, { runId, sessionId }, runId, sessionId));
  } else {
    tap(
      envelope(
        MolaEvents.ErrorRaised,
        { kind: quota ? "quota" : "crash", sessionId, detail: `${CODEX_BIN} exited ${res.code}` },
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
 * `codex agents` — sessions on the shared app-server daemon (captured help).
 * The output format is not captured: JSON is parsed when the output is JSON,
 * otherwise table rows are split defensively. Nothing is invented for rows
 * that cannot be read.
 */
export async function codexListSessions(deps: { exec: ExecService }, filter?: { cwd?: string }): Promise<SessionRef[]> {
  let res;
  try {
    res = await deps.exec.exec(winSafeArgv([CODEX_BIN, "agents"]), { timeoutMs: 15_000 });
  } catch {
    return [];
  }
  if (res.code !== 0) return [];
  const out = res.stdout.trim();
  const sessions: SessionRef[] = [];
  if (out.startsWith("{") || out.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(out);
      const container: unknown =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? ((parsed as Record<string, unknown>)["agents"] ??
            (parsed as Record<string, unknown>)["sessions"] ??
            (parsed as Record<string, unknown>)["items"] ??
            (parsed as Record<string, unknown>)["data"])
          : parsed;
      const rows: unknown[] = Array.isArray(container) ? container : [];
      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const r = row as Record<string, unknown>;
        const id = [r.id, r.session_id, r.thread_id].find((v): v is string => typeof v === "string" && v.length > 0);
        if (!id) continue;
        sessions.push({
          id,
          ...(typeof r.title === "string" ? { title: r.title } : {}),
          ...(typeof r.cwd === "string" ? { cwd: r.cwd } : {}),
          ...(typeof r.updated_at === "string" ? { updatedAt: r.updated_at } : {}),
        });
      }
    } catch {
      /* fall through to the line parser */
    }
  } else {
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s{2,}|\s*\|\s*/).filter(Boolean);
      // the id-like column, preferring the longest match (titles can be id-shaped too)
      const id = cols.filter((c) => /^[A-Za-z0-9_-]{6,}$/.test(c)).sort((a, b) => b.length - a.length)[0];
      if (!id) continue;
      const date = cols.map((c) => /\d{4}-\d{2}-\d{2}/.exec(c)?.[0]).find((d): d is string => typeof d === "string");
      const title = cols[0] !== id ? cols[0] : undefined;
      sessions.push({ id, ...(title !== undefined ? { title } : {}), ...(date !== undefined ? { updatedAt: date } : {}) });
    }
  }
  const cwd = filter?.cwd;
  return cwd ? sessions.filter((s) => s.cwd === cwd) : sessions;
}

/** `magpie usage <window> --csv` — codex has no native cost readout. */
export async function codexUsage(deps: { exec: ExecService }, scope?: UsageScope): Promise<Usage[]> {
  let res;
  try {
    res = await deps.exec.exec(winSafeArgv([MAGPIE_BIN, "usage", scope?.window ?? "30d", "--csv"]), { timeoutMs: 15_000 });
  } catch {
    return [];
  }
  if (res.code !== 0) return [];
  return parseMagpieUsageCsv(res.stdout);
}

/** `magpie codex <route>` — magpie owns ~/.codex/config.toml, never mola. */
export async function codexSetModel(deps: { exec: ExecService }, route: string): Promise<void> {
  const res = await deps.exec.exec(winSafeArgv([MAGPIE_BIN, "codex", route]), { timeoutMs: 30_000 });
  if (res.code !== 0) {
    throw new UnsupportedCapability(CODEX_BIN, `setModel(${route})`, res.stderr || `magpie exited ${res.code}`);
  }
}

export { NO_EXEC_SURFACE };
