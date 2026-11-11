/**
 * Test doubles for the PluginContext contract, trimmed to what ultramode
 * needs: command registration, the state KV, config reads, and a minimal
 * waterfall bus with the same rejection-as-denial semantics as core.
 * No real process is ever spawned.
 */

import type {
  Command,
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

export interface FakeCtx {
  ctx: PluginContext;
  commands: Array<Command & { owner: string }>;
  hooks: Map<string, Array<(value: any) => any>>;
  kv: Record<string, unknown>;
  emitted: Array<{ event: string; data: unknown; source?: unknown }>;
}

export function makeFakeCtx(opts: { config?: Record<string, unknown> } = {}): FakeCtx {
  const commands: FakeCtx["commands"] = [];
  const hooks = new Map<string, Array<(value: any) => any>>();
  const kv: Record<string, unknown> = {};
  const emitted: FakeCtx["emitted"] = [];

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

  const configGet = <T>(key: string, fallback?: T): T =>
    ((opts.config ?? {})[key] !== undefined ? (opts.config ?? {})[key] : fallback) as T;

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
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    fs: {
      readFile: (_p: string): string => {
        throw new Error("ENOENT");
      },
      writeFile: (_p: string, _data: string) => {},
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
      register: () => () => {},
      list: () => [],
      get: () => undefined,
    },
    tools: {
      register: () => () => {},
      list: () => [],
      get: () => undefined,
    },
    dispose: () => {},
  } as unknown as PluginContext;

  return { ctx, commands, hooks, kv, emitted };
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
  if (!err || typeof err.code !== "string") throw new Error(`expected a MolaError, got ${String(e)}`);
  return err;
}
