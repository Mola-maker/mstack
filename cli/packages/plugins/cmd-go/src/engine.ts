/**
 * The `mola go` pipeline (FRAMEWORK §13.1): one sentence in, stages out. Each
 * stage is one agent run through the `mola run` engine (cmd-run's routing
 * ladder, prompt adapter and quota ladder); progress.json is written before and
 * after every stage so statusline / dash / web can show it live.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HeadlessAgentAdapter, HookEvent, Io, PluginContext, RunResult } from "@mola/plugin-sdk";
import {
  ExitCode,
  MolaError,
  MolaEvents,
  STAGES,
  readApproval,
  readProgress,
  runDir,
  writeApproval,
  writeProgress,
  type RunProgress,
  type StageName,
  type StageProgress,
  type WorkerProgress,
} from "@mola/plugin-sdk";
import {
  adaptPrompt,
  buildRunRequest,
  familyOf,
  gatePermissionProfile,
  loadPolicy,
  loadRoutingFile,
  looksQuotaShaped,
  makeQuotaWaitRunner,
  policyKindOf,
  prepareRun,
  runLadder,
  type Policy,
  type RoutingTable,
} from "@mola/plugin-cmd-run";
import { buildStagePrompt, parseStatus, stripStatus } from "./prompts.js";
import { STAGE_ARTIFACT, STAGE_KIND, selectStages } from "./stages.js";

type Prepared = Awaited<ReturnType<typeof prepareRun>>;

/** 3 strikes: the first verify plus 2 retries. */
export const MAX_VERIFY_STRIKES = 3;

export interface GoOptions {
  intent: string;
  until?: StageName;
  agent?: string;
  auto: boolean;
  dryRun: boolean;
  resume?: string;
}

export interface GoEnv {
  ctx: PluginContext;
  io: Pick<Io, "cwd" | "yes" | "note" | "out">;
  /** approval poll interval (spec: 2 s) */
  pollMs: number;
  /** how often a running stage checks for the STOP flag */
  stopPollMs: number;
  /** skip adapter detection (dry-run only) */
  detect: boolean;
  notify(text: string, title: string): Promise<void>;
}

/** `go-<yyyymmdd-hhmm>-<4 hex>` */
export function mintRunId(now = new Date(), rand: () => string = () => crypto.randomBytes(2).toString("hex")): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `go-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${rand()}`;
}

export const stopFile = (cwd: string, id: string): string => path.join(runDir(cwd, id), "STOP");
export const stopRequested = (cwd: string, id: string): boolean => fs.existsSync(stopFile(cwd, id));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const iso = (): string => new Date().toISOString();
const oneLine = (s: string, n = 140): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// ----------------------------------------------------------------- progress

export function initProgress(id: string, intent: string, cwd: string, selected: StageName[]): RunProgress {
  const now = iso();
  return {
    schemaVersion: 1,
    id,
    intent,
    cwd,
    status: "running",
    startedAt: now,
    updatedAt: now,
    stage: selected[0] ?? "plan",
    stages: STAGES.map((name) => ({ name, status: selected.includes(name) ? "pending" : "skipped" })),
    workers: [],
    costUsd: 0,
    origin: "cli",
  };
}

const stageOf = (p: RunProgress, name: StageName): StageProgress => p.stages.find((s) => s.name === name)!;
const activeOrder = (p: RunProgress): StageName[] => p.stages.filter((s) => s.status !== "skipped").map((s) => s.name);

function emit(env: GoEnv, kind: "started" | "stage" | "blocked" | "done", p: RunProgress, stage: StageName, status: string): void {
  env.ctx.events.emit(`mola.go.${kind}`, { runId: p.id, stage, status }, { runId: p.id });
}

/** One line: what happens next, or what the human should do. */
function setNext(p: RunProgress): void {
  const order = activeOrder(p);
  const nextStage = order.find((n) => {
    const s = stageOf(p, n).status;
    return s === "pending" || s === "failed" || s === "blocked";
  });
  if (p.status === "blocked" && p.blocked?.approvalId) {
    p.next = `approve: mola go approve ${p.id} · deny: mola go deny ${p.id}`;
  } else if (p.status === "blocked") {
    p.next = `fix the blocker, then: mola go --resume ${p.id}`;
  } else if (p.status === "running") {
    const cur = stageOf(p, p.stage);
    p.next = cur.status === "running" ? `${p.stage} running${cur.model ? ` on ${cur.model}` : ""}` : `next: ${nextStage ?? "finish"}`;
  } else if (p.status === "done") {
    p.next = "done — see review.md and the stage artifacts in the run dir";
  } else {
    p.next = `mola go --resume ${p.id}`;
  }
}

// ------------------------------------------------------------------ routing

export interface RunContext {
  policy: Policy;
  table: RoutingTable | null;
}

export function loadRunContext(env: GoEnv): RunContext {
  const policy = loadPolicy(env.ctx.fs, env.io.cwd);
  for (const w of policy.warnings) env.io.note(`mola: ${w}`);
  const loaded = loadRoutingFile();
  if (loaded.warning) env.io.note(`mola: routing file: ${loaded.warning} — routing by policy only`);
  return { policy, table: loaded.table };
}

/**
 * Route one stage through the run engine's filter + score + model ladder.
 * Review is steered to the first ladder entry whose model family differs from
 * the implement stage's (an author does not review itself).
 */
export async function prepareStage(
  env: GoEnv,
  rc: RunContext,
  stage: StageName,
  prompt: string,
  agent: string | undefined,
  implementModel: string | undefined,
): Promise<Prepared> {
  const kind = STAGE_KIND[stage];
  const run = (route?: string): Promise<Prepared> =>
    prepareRun(env.ctx, {
      taskKind: policyKindOf(kind),
      prompt,
      flags: { ...(agent ? { agent } : {}), ...(route ? { route } : {}) },
      cwd: env.io.cwd,
      policy: rc.policy,
      routing: rc.table,
      routingKind: kind,
      kindSource: "skill",
      detect: env.detect,
    });
  const base = await run();
  if (stage !== "review" || !rc.table || !implementModel) return base;
  const implFamily = familyOf(rc.table, implementModel);
  if (!implFamily || familyOf(rc.table, base.route) !== implFamily) return base;
  const candidates = [base.route, ...(base.routing?.ladder ?? [])];
  const other = candidates.find((r) => familyOf(rc.table!, r) !== implFamily);
  if (!other) {
    env.io.note(`mola: warning: no review route outside the "${implFamily}" family — the reviewer shares the implementer's family`);
    return base;
  }
  return run(other);
}

// ----------------------------------------------------------------- stop / gate

function stopWatcher(env: GoEnv, id: string): { promise: Promise<"stopped">; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<"stopped">((resolve) => {
    const tick = (): void => {
      if (stopRequested(env.io.cwd, id)) return resolve("stopped");
      timer = setTimeout(tick, env.stopPollMs);
    };
    tick();
  });
  return { promise, cancel: () => timer && clearTimeout(timer) };
}

/** A new approval id for `stage`: reuse a pending/approved one, mint `<stage>-<n+1>` after a denial. */
function approvalIdFor(cwd: string, runId: string, stage: StageName): { id: string; existing?: ReturnType<typeof readApproval> } {
  for (let n = 1; ; n++) {
    const id = `${stage}-${n}`;
    const a = readApproval(cwd, runId, id);
    if (!a) return { id };
    if (a.status !== "denied") return { id, existing: a };
  }
}

/** Wait for a human decision. Returns approved | denied | stopped. */
export async function waitForApproval(env: GoEnv, p: RunProgress, stage: StageName, action: string): Promise<"approved" | "denied" | "stopped"> {
  const cwd = env.io.cwd;
  const { id, existing } = approvalIdFor(cwd, p.id, stage);
  if (existing?.status === "approved") return "approved";
  if (!existing) {
    writeApproval(cwd, { id, runId: p.id, stage, action, status: "pending", createdAt: iso() });
  }
  const st = stageOf(p, stage);
  st.status = "blocked";
  p.stage = stage;
  p.status = "blocked";
  p.blocked = { reason: `approval needed: ${oneLine(action, 100)}`, approvalId: id };
  setNext(p);
  writeProgress(p);
  emit(env, "blocked", p, stage, "blocked");
  await env.notify(`${p.blocked.reason}\nmola go approve ${p.id}   |   mola go deny ${p.id}`, `mola go · ${stage} needs approval`);

  for (;;) {
    if (stopRequested(cwd, p.id)) return "stopped";
    const a = readApproval(cwd, p.id, id);
    if (a?.status === "approved") {
      st.status = "pending";
      p.status = "running";
      delete p.blocked;
      setNext(p);
      writeProgress(p);
      return "approved";
    }
    if (a?.status === "denied") {
      st.summary = `denied${a.decidedBy ? ` by ${a.decidedBy}` : ""}`;
      return "denied";
    }
    await sleep(env.pollMs);
  }
}

// -------------------------------------------------------------------- a stage

type StageOutcome = { status: "done" | "failed" | "blocked" | "stopped"; summary: string };

function eventText(e: HookEvent): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const t = typeof d.textExcerpt === "string" ? d.textExcerpt : typeof d.text === "string" ? d.text : "";
  return oneLine(t, 120);
}

function countLines(file: string, re: RegExp): number {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => re.test(l)).length;
  } catch {
    return 0;
  }
}

async function runStage(env: GoEnv, rc: RunContext, p: RunProgress, stage: StageName, opts: { agent?: string; retryFrom?: string }): Promise<StageOutcome> {
  const cwd = env.io.cwd;
  const st = stageOf(p, stage);
  const dir = runDir(cwd, p.id);
  const relDir = path.relative(cwd, dir).split(path.sep).join("/");
  const attempt = p.workers.filter((w) => w.stage === stage).length + 1;
  const worker: WorkerProgress = { id: `w-${stage}-${attempt}`, stage, status: "working", startedAt: iso(), updatedAt: iso() };
  const priorCost = st.costUsd ?? 0;

  st.status = "running";
  st.startedAt = iso();
  delete st.endedAt;
  delete st.summary;
  p.stage = stage;
  p.status = "running";
  delete p.blocked;
  p.workers.push(worker);
  setNext(p);
  writeProgress(p);
  emit(env, "stage", p, stage, "running");

  const watcher = stopWatcher(env, p.id);
  let outcome: StageOutcome;
  let cost = 0;
  let lastWrite = 0;
  try {
    const previous = activeOrder(p)
      .filter((n) => n !== stage && stageOf(p, n).status === "done")
      .map((n) => STAGE_ARTIFACT[n])
      .filter((a) => fs.existsSync(path.join(dir, a)));
    const prompt = buildStagePrompt({ stage, intent: p.intent, dir: relDir, previous, ...(opts.retryFrom ? { retryFrom: opts.retryFrom } : {}) });
    const implementModel = stageOf(p, "implement").model;
    const prepared = await prepareStage(env, rc, stage, prompt, opts.agent, implementModel);
    const { decision, policy, routing } = prepared;

    const approved = (await env.ctx.events.runWaterfall(MolaEvents.TaskPreDispatch, {
      agent: decision.agent,
      machine: decision.machine,
      modelRoute: decision.modelRoute,
      task: prompt,
      taskChars: prompt.length,
      runId: p.id,
      cwd,
      command: "go",
      yes: env.io.yes,
    })) as { modelRoute?: string };
    const route = approved.modelRoute ?? decision.modelRoute;
    const gated = gatePermissionProfile(prepared.permissionProfile, { approval: prepared.approval, yes: env.io.yes });
    if (gated.downgraded) env.io.note("mola: full-auto needs an approval (policy approval: batch-approved, or --yes) — running with workspace-write");

    let usedAgent = decision.agent;
    let usedRoute = route;
    st.model = route;
    st.agent = usedAgent;
    worker.model = route;
    worker.agent = usedAgent;
    writeProgress(p);

    const onEvent = (e: HookEvent): void => {
      try {
        fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(e) + "\n");
      } catch {
        // the run record is best effort
      }
      if (e.kind !== MolaEvents.AgentMessage) return;
      const now = Date.now();
      if (now - lastWrite < 1000) return;
      const text = eventText(e);
      if (!text) return;
      lastWrite = now;
      worker.lastLine = text;
      worker.updatedAt = iso();
      writeProgress(p);
    };

    const runOnce = async (agentId: string, modelRoute: string): Promise<RunResult> => {
      const target = agentId === decision.agent ? prepared.adapter : env.ctx.agents.get(agentId);
      if (!target || typeof (target as HeadlessAgentAdapter).run !== "function") {
        throw new MolaError("AGENT_NOT_FOUND", `agent "${agentId}" is not runnable`, ExitCode.NoInput);
      }
      usedAgent = agentId;
      usedRoute = modelRoute;
      const adapted = adaptPrompt(rc.table, modelRoute, prompt);
      const result = await (target as HeadlessAgentAdapter).run(
        buildRunRequest({
          prompt: adapted.prompt,
          cwd,
          modelRoute,
          permissionProfile: gated.profile,
          ...(prepared.budgetUsd !== undefined ? { budgetUsd: prepared.budgetUsd } : {}),
          runId: p.id,
          onEvent,
        }),
      );
      cost += result.usage?.costUsd ?? 0;
      return result;
    };

    const work = (async (): Promise<RunResult> => {
      let result = await runOnce(decision.agent, route);
      if (result.exitCode !== 0 && (result.quotaFailure || looksQuotaShaped(result))) {
        env.io.note(`mola: quota failure on ${decision.agent}/${route} — walking the quota ladder`);
        const walk = await runLadder({
          attempt: runOnce,
          primary: { agent: decision.agent, route },
          fallbacks: decision.fallbacks,
          policy,
          wait: makeQuotaWaitRunner(env.ctx.process).wait,
          ...(routing ? { alternates: routing.ladder } : {}),
        });
        if (walk.result) result = walk.result;
      }
      return result;
    })();
    work.catch(() => {}); // a stopped run's late rejection must not surface

    const raced = await Promise.race([work, watcher.promise]);
    if (raced === "stopped") {
      outcome = { status: "stopped", summary: "stopped by the user" };
    } else {
      st.model = usedRoute;
      st.agent = usedAgent;
      worker.model = usedRoute;
      worker.agent = usedAgent;
      outcome = interpret(raced, stage, dir);
    }
  } catch (err) {
    outcome = { status: "failed", summary: oneLine(err instanceof Error ? err.message : String(err)) };
  } finally {
    watcher.cancel();
  }

  st.status = outcome.status === "stopped" ? "failed" : outcome.status;
  st.endedAt = iso();
  st.summary = outcome.summary;
  st.costUsd = Math.round((priorCost + cost) * 10000) / 10000;
  if (fs.existsSync(path.join(dir, STAGE_ARTIFACT[stage]))) st.artifact = STAGE_ARTIFACT[stage];
  worker.status = outcome.status === "done" ? "done" : outcome.status === "blocked" ? "blocked" : "failed";
  worker.costUsd = Math.round(cost * 10000) / 10000;
  worker.updatedAt = iso();
  setNext(p);
  writeProgress(p);
  emit(env, "stage", p, stage, st.status);
  return outcome;
}

/** Turn an agent result into a stage outcome; writes the artifact when the agent could not. */
function interpret(result: RunResult, stage: StageName, dir: string): StageOutcome {
  const parsed = parseStatus(result.finalText);
  const file = path.join(dir, STAGE_ARTIFACT[stage]);
  if (!fs.existsSync(file)) {
    const body = stripStatus(result.finalText);
    if (body) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, body + "\n", "utf8");
      } catch {
        // artifact is best effort
      }
    }
  }
  let summary = parsed.summary || (parsed.found ? "" : oneLine(result.finalText, 100));
  if (stage === "review") {
    const findings = countLines(file, /^\W*FINDING\b/i);
    const cleared = countLines(file, /^\W*CLEARED\b/i);
    summary = `${findings} finding${findings === 1 ? "" : "s"}, ${cleared} cleared${summary ? ` · ${summary}` : ""}`;
  }
  if (result.exitCode !== 0) {
    return { status: "failed", summary: oneLine(`agent exit ${result.exitCode}${summary ? `: ${summary}` : ""}`) };
  }
  return { status: parsed.status, summary: oneLine(summary || (parsed.found ? parsed.status : "no STATUS line")) };
}

// --------------------------------------------------------------------- driver

function finish(env: GoEnv, p: RunProgress, status: RunProgress["status"], reason?: string): ExitCode {
  p.status = status;
  if (status === "blocked") p.blocked = { reason: reason ?? "blocked", ...(p.blocked?.approvalId ? { approvalId: p.blocked.approvalId } : {}) };
  else delete p.blocked;
  setNext(p);
  writeProgress(p);
  if (status === "blocked") emit(env, "blocked", p, p.stage, "blocked");
  emit(env, "done", p, p.stage, status);
  return status === "done" ? ExitCode.Ok : ExitCode.Error;
}

function describeEnd(p: RunProgress): string {
  const lines = p.stages
    .filter((s) => s.status !== "skipped")
    .map((s) => `  ${s.status === "done" ? "✔" : s.status === "pending" ? "·" : "✘"} ${s.name}${s.model ? ` (${s.model})` : ""}${s.summary ? ` — ${s.summary}` : ""}`);
  return [`mola go ${p.id}: ${p.status}${p.blocked ? ` — ${p.blocked.reason}` : ""} · $${p.costUsd.toFixed(2)}`, ...lines].join("\n");
}

/** Drive the run from its first unfinished stage to the end (or the first gate / failure / stop). */
export async function drive(env: GoEnv, rc: RunContext, p: RunProgress, opts: { auto: boolean; agent?: string }): Promise<ExitCode> {
  const cwd = env.io.cwd;
  const order = activeOrder(p);
  let idx = order.findIndex((n) => {
    const s = stageOf(p, n).status;
    return s !== "done";
  });
  if (idx < 0) {
    env.io.note(`mola: ${p.id} has nothing left to run`);
    return finish(env, p, "done");
  }
  let strikes = 0;
  let retryFrom: string | undefined;

  const stopNow = async (): Promise<ExitCode> => {
    for (const w of p.workers) if (w.status === "working") w.status = "failed";
    const code = finish(env, p, "stopped");
    await env.notify(`stopped at ${p.stage}`, `mola go · ${p.id}`);
    return code;
  };

  while (idx < order.length) {
    const stage = order[idx];
    if (stopRequested(cwd, p.id)) return stopNow();

    if (!retryFrom) {
      let action: string | undefined;
      if (stage === "ship") action = `push the branch and open a PR for: ${oneLine(p.intent, 80)}`;
      else if (stage === "implement" && !opts.auto) action = `start implementing — plan: ${oneLine(stageOf(p, "plan").summary ?? p.intent, 90)}`;
      if (action) {
        const decision = await waitForApproval(env, p, stage, action);
        if (decision === "stopped") return stopNow();
        if (decision === "denied") {
          const code = finish(env, p, "stopped");
          await env.notify(`${stage} denied — run stopped`, `mola go · ${p.id}`);
          return code;
        }
      }
    }

    const outcome = await runStage(env, rc, p, stage, { ...(opts.agent ? { agent: opts.agent } : {}), ...(retryFrom ? { retryFrom } : {}) });
    retryFrom = undefined;
    if (outcome.status === "stopped") return stopNow();

    if (outcome.status === "blocked") {
      const code = finish(env, p, "blocked", `${stage} blocked: ${outcome.summary}`);
      await env.notify(p.blocked?.reason ?? "blocked", `mola go · ${p.id}`);
      return code;
    }
    if (outcome.status === "failed") {
      if (stage === "verify") {
        strikes++;
        if (strikes >= MAX_VERIFY_STRIKES) {
          const code = finish(env, p, "blocked", `verify failed ${MAX_VERIFY_STRIKES} times`);
          await env.notify(p.blocked?.reason ?? "blocked", `mola go · ${p.id}`);
          return code;
        }
        const back = order.indexOf("implement");
        if (back >= 0) {
          stageOf(p, "implement").status = "pending";
          retryFrom = STAGE_ARTIFACT.verify;
          idx = back;
          continue;
        }
      }
      const code = finish(env, p, "failed");
      await env.notify(`${stage} failed: ${outcome.summary}`, `mola go · ${p.id}`);
      return code;
    }
    idx++;
  }

  const code = finish(env, p, "done");
  await env.notify(`done · $${p.costUsd.toFixed(2)}`, `mola go · ${p.id}`);
  return code;
}

export interface StartResult {
  code: ExitCode;
  progress: RunProgress;
}

/** `mola go "<intent>"` — mint the run, write intent.md + progress.json, drive. */
export async function startRun(env: GoEnv, opts: GoOptions): Promise<StartResult> {
  const cwd = env.io.cwd;
  const rc = loadRunContext(env);
  const id = mintRunId();
  const p = initProgress(id, opts.intent, cwd, selectStages(opts.intent, opts.until));
  fs.mkdirSync(runDir(cwd, id), { recursive: true });
  fs.writeFileSync(path.join(runDir(cwd, id), "intent.md"), `# Intent\n\n${opts.intent}\n`, "utf8");
  setNext(p);
  writeProgress(p);
  emit(env, "started", p, p.stage, "running");
  env.io.note(`mola go: ${id} · ${activeOrder(p).join(" → ")}`);
  const code = await drive(env, rc, p, { auto: opts.auto, ...(opts.agent ? { agent: opts.agent } : {}) });
  return { code, progress: p };
}

/** `mola go --resume <id>` — continue from the first stage that is not done/skipped. */
export async function resumeRun(env: GoEnv, id: string, opts: { auto: boolean; agent?: string }): Promise<StartResult> {
  const cwd = env.io.cwd;
  const p = readProgress(cwd, id);
  if (!p) throw new MolaError("NO_INPUT", `no such run: ${id}`, ExitCode.NoInput);
  if (p.status === "done") throw new MolaError("USAGE_ERROR", `run ${id} is already done`, ExitCode.Usage);
  const rc = loadRunContext(env);
  try {
    fs.rmSync(stopFile(cwd, id), { force: true });
  } catch {
    // no flag
  }
  for (const w of p.workers) if (w.status === "working") w.status = "failed";
  p.status = "running";
  delete p.blocked;
  setNext(p);
  writeProgress(p);
  emit(env, "started", p, p.stage, "running");
  env.io.note(`mola go: resuming ${id} · ${activeOrder(p).filter((n) => stageOf(p, n).status !== "done").join(" → ")}`);
  const code = await drive(env, rc, p, opts);
  return { code, progress: p };
}

export { describeEnd };
