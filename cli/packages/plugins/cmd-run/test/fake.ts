/**
 * Test doubles for the PluginContext contract. No real process is ever
 * spawned: the agents are scripted fakes, the bus is a minimal waterfall with
 * the same rejection-as-denial semantics as core (ADR-0004 / core §3), and the
 * fs is an in-memory map.
 */

import assert from "node:assert/strict";
import type {
  AgentCapabilities,
  Command,
  EventBus,
  EventEnvelope,
  HeadlessAgentAdapter,
  Io,
  Logger,
  PluginContext,
  RunRequest,
  RunResult,
  StateNamespace,
} from "@mola/plugin-sdk";

// legacy behaviour unless a test points MOLA_ROUTING_FILE at a real table
process.env.MOLA_ROUTING_FILE ??= "/nonexistent/model-routing.json";

export const nullLog: Logger = {
  level: "error",
  child: () => nullLog,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const TEST_CAPS: AgentCapabilities = {
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

export interface FakeAgent {
  id: string;
  /** the scripted results, one per call; the last one repeats */
  results: RunResult[];
  calls: RunRequest[];
  /** health reported by detect() */
  available?: boolean;
  broken?: boolean;
  capabilities?: Partial<AgentCapabilities>;
  /**
   * the event envelopes the adapter emits through `req.onEvent` (the
   * stream-bridge tap every real adapter implements)
   */
  events?: Array<{ kind: string; data: Record<string, unknown> }>;
}

export interface FakeCtx {
  ctx: PluginContext;
  commands: Array<Command & { owner: string }>;
  agents: FakeAgent[];
  adapters: HeadlessAgentAdapter[];
  hooks: Map<string, Array<(value: any) => any>>;
  files: Map<string, string>;
  kv: Record<string, unknown>;
  emitted: Array<{ event: string; data: unknown; source?: unknown }>;
  execCalls: Array<{ argv: string[]; opts: Record<string, unknown> }>;
}

export function makeFakeAdapter(agent: FakeAgent): HeadlessAgentAdapter {
  let index = 0;
  return {
    id: agent.id,
    capabilities: { ...TEST_CAPS, ...(agent.capabilities ?? {}) },
    async detect() {
      return {
        available: agent.available !== false,
        health: agent.broken ? "broken" : agent.available === false ? "unknown" : "ok",
      };
    },
    async run(req: RunRequest): Promise<RunResult> {
      agent.calls.push(req);
      // the stream-bridge tap: the adapter emits its envelopes through
      // req.onEvent, exactly like agent-dsh does, and returns them in
      // RunResult.events
      const emitted: EventEnvelope[] = [];
      for (const e of agent.events ?? []) {
        const envelope: EventEnvelope = {
          id: `evt-${agent.id}-${index}-${e.kind}`,
          ts: new Date(0).toISOString(),
          kind: e.kind,
          source: { agent: agent.id, machine: "fake", runId: req.runId ?? "run-fake" },
          data: e.data,
        };
        emitted.push(envelope);
        req.onEvent?.(envelope);
      }
      const result = agent.results[Math.min(index, agent.results.length - 1)] ?? {
        exitCode: 0,
        finalText: "ok",
      };
      index++;
      return { ...result, events: emitted };
    },
    async resume(_id: string, req: RunRequest): Promise<RunResult> {
      agent.calls.push(req);
      return agent.results[0] ?? { exitCode: 0, finalText: "ok" };
    },
  } as HeadlessAgentAdapter;
}

export function makeFakeCtx(
  opts: {
    agents?: FakeAgent[];
    config?: Record<string, unknown>;
    exec?: (argv: string[], execOpts: Record<string, unknown>) => Promise<{ code: number; stdout: string; stderr: string }>;
  } = {},
): FakeCtx {
  const commands: FakeCtx["commands"] = [];
  const agents = opts.agents ?? [];
  const adapters = agents.map(makeFakeAdapter);
  const hooks = new Map<string, Array<(value: any) => any>>();
  const files = new Map<string, string>();
  const kv: Record<string, unknown> = {};
  const emitted: FakeCtx["emitted"] = [];
  const execCalls: FakeCtx["execCalls"] = [];

  const state: StateNamespace = {
    get: <T>(k: string): T | undefined => kv[k] as T | undefined,
    set: (k, v) => {
      kv[k] = v;
    },
    delete: (k) => {
      delete kv[k];
    },
    keys: () => Object.keys(kv),
  };

  const events: EventBus = {
    emit(event, data, source) {
      emitted.push({ event, data, source });
    },
    on: () => () => {},
    hook(event, fn) {
      const list = hooks.get(event) ?? [];
      list.push(fn);
      hooks.set(event, list);
      return () => {};
    },
    async runWaterfall(event, value) {
      let current = value;
      for (const fn of hooks.get(event) ?? []) current = await fn(current);
      return current;
    },
    onSerial: () => () => {},
    async runSerial() {},
  };

  const configGet = (key: string, fallback?: unknown) =>
    (opts.config ?? {})[key] !== undefined ? (opts.config ?? {})[key] : fallback;

  const ctx = {
    id: "test",
    manifest: {},
    log: nullLog,
    events,
    commands: {
      register: (command: Command) => {
        commands.push({ ...command, owner: "test" });
        return () => {};
      },
    },
    config: {
      get: configGet,
      has: (key: string) => (opts.config ?? {})[key] !== undefined,
      all: () => ({ ...(opts.config ?? {}) }),
      onChange: () => () => {},
    },
    configWriter: undefined,
    state,
    permissions: {},
    process: {
      exec: async (argv: string[], execOpts: Record<string, unknown> = {}) => {
        execCalls.push({ argv, opts: execOpts });
        if (!opts.exec) return { code: 0, stdout: "", stderr: "" };
        return opts.exec(argv, execOpts);
      },
    },
    fs: {
      readFile: (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeFile: (p: string, data: string) => {
        files.set(p, data);
      },
    },
    sidecars: {},
    plugins: {
      list: () => [],
      plan: () => ({ ok: true, errors: [], order: [], quarantined: [] }),
    },
    doctor: {
      registerCheck: () => () => {},
      list: () => [],
    },
    agents: {
      register: (a: HeadlessAgentAdapter) => {
        adapters.push(a);
        return () => {};
      },
      list: () => adapters,
      get: (id: string) => adapters.find((a) => a.id === id),
    },
    tools: {
      register: () => () => {},
      list: () => [],
      get: () => undefined,
    },
    dispose: () => {},
  } as unknown as PluginContext;

  return { ctx, commands, agents, adapters, hooks, files, kv, emitted, execCalls };
}

export function makeIo(overrides: Partial<Io> = {}): Io & {
  outLines: string[];
  notes: string[];
  errors: unknown[];
  dataValue: unknown;
} {
  const outLines: string[] = [];
  const notes: string[] = [];
  const errors: unknown[] = [];
  let dataValue: unknown;
  return {
    json: false,
    quiet: false,
    yes: false,
    traceId: "trace-test-0000-0000",
    cwd: "/fake/ws",
    data(v: unknown) {
      dataValue = v;
    },
    out(line: string) {
      outLines.push(line);
    },
    note(m: string) {
      notes.push(m);
    },
    error(err: unknown) {
      errors.push(err);
    },
    outLines,
    notes,
    errors,
    get dataValue() {
      return dataValue;
    },
    ...overrides,
  } as Io & { outLines: string[]; notes: string[]; errors: unknown[]; dataValue: unknown };
}

export function errOf(e: unknown): { code: string; exitCode: number; message: string } {
  const err = e as { code: string; exitCode: number; message: string };
  assert.ok(err && typeof err.code === "string", `expected a MolaError, got ${String(e)}`);
  return err;
}

/** A recorder that captures the envelopes the fake bus carries. */
export function eventLog(emitted: FakeCtx["emitted"]): EventEnvelope[] {
  return emitted.map(
    (e) =>
      ({
        id: "e",
        ts: new Date(0).toISOString(),
        kind: e.event,
        source: (e.source ?? {}) as EventEnvelope["source"],
        data: e.data,
      }) as EventEnvelope,
  );
}
