/**
 * Test doubles for cmd-go. No agent process is ever spawned: the agents are
 * scripted fakes, the bus records emits, the fs is in memory (policy files only;
 * run state goes to a real temp dir because the progress contract uses node:fs).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentCapabilities,
  Command,
  EventBus,
  HeadlessAgentAdapter,
  Io,
  Logger,
  PluginContext,
  RunRequest,
  RunResult,
} from "@mola/plugin-sdk";
import type { GoEnv } from "../src/engine.js";

const nullLog: Logger = {
  level: "error",
  child: () => nullLog,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CAPS: AgentCapabilities = {
  headless: true,
  headlessJsonStream: true,
  resume: true,
  continueLatest: false,
  forkSession: false,
  listSessions: false,
  acp: false,
  nativeHooks: false,
  backgroundSessions: false,
  worktree: false,
  budgetCap: false,
  costReadout: "magpie",
};

/** A small routing table: two families so "review differs from implement" is decidable. */
export const ROUTING = {
  version: 1,
  tasks: {
    plan: { picks: ["auto/claude-opus-5-5", "auto/gemini-3.8-flash"] },
    implement: { picks: ["auto/claude-opus-5-5", "auto/claude-sonnet-5-5"] },
    test: { picks: ["auto/claude-sonnet-5-5", "auto/gemini-3.8-flash"] },
    review: { picks: ["auto/claude-opus-5-5", "auto/claude-sonnet-5-5", "auto/gemini-3.8-flash"] },
  },
  families: {
    claude: { match: ["claude", "opus", "sonnet"], style: "xml" },
    gemini: { match: ["gemini"], style: "markdown" },
  },
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mola-go-test-"));
fs.writeFileSync(path.join(scratch, "model-routing.json"), JSON.stringify(ROUTING));
process.env.MOLA_ROUTING_FILE = path.join(scratch, "model-routing.json");
process.env.MOLA_HOME = path.join(scratch, "home");

export function tempCwd(): string {
  return fs.mkdtempSync(path.join(scratch, "ws-"));
}

export type Responder = (stage: string, n: number, req: RunRequest) => RunResult | Promise<RunResult>;

export interface FakeAgent {
  id: string;
  calls: RunRequest[];
  /** the stage each call was for, in order */
  stages: string[];
  respond: Responder;
  /** agent.message texts emitted through onEvent before the result */
  messages?: string[];
}

export const ok = (stage: string, extra: Partial<RunResult> = {}): RunResult => ({
  exitCode: 0,
  finalText: `${stage} output\nSTATUS: done ${stage} ok`,
  ...extra,
});

export function fakeAgent(id = "claude", respond: Responder = (s) => ok(s)): FakeAgent {
  return { id, calls: [], stages: [], respond };
}

function adapterOf(agent: FakeAgent): HeadlessAgentAdapter {
  const counts: Record<string, number> = {};
  return {
    id: agent.id,
    capabilities: CAPS,
    async detect() {
      return { available: true, health: "ok" };
    },
    async run(req: RunRequest): Promise<RunResult> {
      const stage = /Stage: (\w+)/.exec(req.prompt)?.[1] ?? "?";
      counts[stage] = (counts[stage] ?? 0) + 1;
      agent.calls.push(req);
      agent.stages.push(stage);
      for (const text of agent.messages ?? []) {
        req.onEvent?.({
          id: "e",
          ts: new Date().toISOString(),
          kind: "mola.agent.message",
          source: { agent: agent.id, runId: req.runId },
          data: { textExcerpt: text },
        });
      }
      return agent.respond(stage, counts[stage], req);
    },
    async resume(): Promise<RunResult> {
      throw new Error("not used");
    },
  } as HeadlessAgentAdapter;
}

export interface Fake {
  ctx: PluginContext;
  commands: Command[];
  emitted: Array<{ event: string; data: any }>;
  notified: Array<{ text: string; title: string }>;
}

export function makeCtx(agents: FakeAgent[], config: Record<string, unknown> = {}): Fake {
  const commands: Command[] = [];
  const emitted: Fake["emitted"] = [];
  const adapters = agents.map(adapterOf);
  const events: EventBus = {
    emit(event: string, data: unknown) {
      emitted.push({ event, data });
    },
    on: () => () => {},
    hook: () => () => {},
    async runWaterfall(_e: string, value: unknown) {
      return value;
    },
    onSerial: () => () => {},
    async runSerial() {},
  } as unknown as EventBus;
  const ctx = {
    id: "test",
    manifest: {},
    log: nullLog,
    events,
    commands: { register: (c: Command) => (commands.push(c), () => {}) },
    config: {
      get: (k: string, fb?: unknown) => (config[k] !== undefined ? config[k] : fb),
      has: (k: string) => config[k] !== undefined,
      all: () => ({ ...config }),
      onChange: () => () => {},
    },
    state: { get: () => undefined, set: () => {}, delete: () => {}, keys: () => [] },
    permissions: {},
    process: { exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
    fs: {
      readFile: (p: string) => {
        throw new Error(`ENOENT: ${p}`);
      },
      writeFile: () => {},
    },
    sidecars: {},
    plugins: { list: () => [], plan: () => ({ ok: true, errors: [], order: [], quarantined: [] }) },
    doctor: { registerCheck: () => () => {}, list: () => [] },
    agents: { register: () => () => {}, list: () => adapters, get: (id: string) => adapters.find((a) => a.id === id) },
    tools: { register: () => () => {}, list: () => [], get: () => undefined },
    dispose: () => {},
  } as unknown as PluginContext;
  return { ctx, commands, emitted, notified: [] };
}

export function makeIo(cwd: string, over: Partial<Io> = {}): Io & { lines: string[]; notes: string[]; dataValue: unknown } {
  const lines: string[] = [];
  const notes: string[] = [];
  const state = { dataValue: undefined as unknown };
  return {
    json: false,
    quiet: false,
    yes: false,
    traceId: "t",
    cwd,
    data: (v: unknown) => void (state.dataValue = v),
    out: (l: string) => void lines.push(l),
    note: (m: string) => void notes.push(m),
    error: () => {},
    lines,
    notes,
    get dataValue() {
      return state.dataValue;
    },
    ...over,
  } as Io & { lines: string[]; notes: string[]; dataValue: unknown };
}

/** An engine env with fast polling and a recording notifier. */
export function makeEnv(fake: Fake, cwd: string, over: Partial<GoEnv> = {}): GoEnv {
  return {
    ctx: fake.ctx,
    io: makeIo(cwd),
    pollMs: 10,
    stopPollMs: 10,
    detect: true,
    notify: async (text, title) => void fake.notified.push({ text, title }),
    ...over,
  };
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}
