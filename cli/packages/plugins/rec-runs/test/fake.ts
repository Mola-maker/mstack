/**
 * Test doubles for the rec-runs tests. No real processes, no real bus: the
 * fake bus builds the same envelopes core does (source.runId = invocation
 * traceId, ADR-0004 §2) and dispatches broadcast events to registered
 * listeners, so the recorder is driven exactly like the real thing.
 */

import type {
  Command,
  EventEnvelope,
  EventBus,
  Io,
  Logger,
  PluginContext,
  StateNamespace,
} from "@mola/plugin-sdk";

export const nullLog: Logger = {
  level: "error",
  child: () => nullLog,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface FakeBus extends EventBus {
  listeners: Map<string, Array<(env: EventEnvelope) => void | Promise<void>>>;
  envelopes: EventEnvelope[];
  /** emit like core: wraps the payload in an envelope stamped with traceId */
  dispatch(event: string, data: unknown, source?: Partial<EventEnvelope["source"]>): EventEnvelope;
}

export function makeFakeBus(traceId = "trace-fake-0001"): FakeBus {
  const listeners = new Map<string, Array<(env: EventEnvelope) => void | Promise<void>>>();
  const envelopes: EventEnvelope[] = [];
  let seq = 0;
  const bus: FakeBus = {
    listeners,
    envelopes,
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {};
    },
    emit(event, data, source) {
      bus.dispatch(event, data, source);
    },
    dispatch(event, data, source) {
      const env: EventEnvelope = {
        id: `evt-${++seq}`,
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
        kind: event,
        source: { runId: traceId, ...(source ?? {}) },
        data,
      };
      envelopes.push(env);
      for (const fn of listeners.get(event) ?? []) void fn(env);
      return env;
    },
    hook: () => () => {},
    async runWaterfall<T>(_event: string, value: T) {
      return value;
    },
    onSerial: () => () => {},
    async runSerial() {},
  };
  return bus;
}

export interface FakeRec {
  ctx: PluginContext;
  bus: FakeBus;
  commands: Array<Command & { owner: string }>;
  files: Map<string, string>;
  kv: Record<string, unknown>;
  logWarnings: Array<{ msg: string; fields?: Record<string, unknown> }>;
}

export function makeRecCtx(opts: { traceId?: string; fsWriteFails?: boolean } = {}): FakeRec {
  const bus = makeFakeBus(opts.traceId);
  const commands: FakeRec["commands"] = [];
  const files = new Map<string, string>();
  const kv: Record<string, unknown> = {};
  const logWarnings: FakeRec["logWarnings"] = [];

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

  const fs = {
    readFile: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p: string, data: string) => {
      if (opts.fsWriteFails) throw new Error("EACCES: fake write failure");
      files.set(p, data);
    },
  };

  const log: Logger = {
    ...nullLog,
    warn(msg: string, fields?: Record<string, unknown>) {
      logWarnings.push({ msg, fields });
    },
  };

  const ctx = {
    id: "mola-rec-runs",
    manifest: {},
    log,
    events: bus,
    commands: {
      register: (command: Command) => {
        commands.push({ ...command, owner: "mola-rec-runs" });
        return () => {};
      },
    },
    config: {
      get: (_k: string, fallback?: unknown) => fallback,
      has: () => false,
      all: () => ({}),
      onChange: () => () => {},
    },
    state,
    permissions: {},
    process: { exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
    fs,
    sidecars: {},
    plugins: { list: () => [], plan: () => ({ ok: true, errors: [], order: [], quarantined: [] }) },
    doctor: { registerCheck: () => () => {}, list: () => [] },
    agents: { register: () => () => {}, list: () => [], get: () => undefined },
    tools: { register: () => () => {}, list: () => [], get: () => undefined },
    dispose: () => {},
  } as unknown as PluginContext;

  return { ctx, bus, commands, files, kv, logWarnings };
}

export function makeIo(overrides: Partial<Io> = {}): Io & {
  outLines: string[];
  dataValue: unknown;
} {
  const outLines: string[] = [];
  let dataValue: unknown;
  return {
    json: false,
    quiet: false,
    traceId: "trace-fake-0001",
    cwd: "/fake/ws",
    yes: false,
    data(v: unknown) {
      dataValue = v;
    },
    out(line: string) {
      outLines.push(line);
    },
    note() {},
    error() {},
    outLines,
    get dataValue() {
      return dataValue;
    },
    ...overrides,
  } as Io & { outLines: string[]; dataValue: unknown };
}

export function errOf(e: unknown): { code: string; exitCode: number; message: string } {
  const err = e as { code: string; exitCode: number; message: string };
  if (!err || typeof err.code !== "string") throw new Error(`expected a MolaError, got ${String(e)}`);
  return err;
}
