/**
 * Test doubles for the PluginContext contract. No real processes are spawned:
 * `exec` is a scripted fake, fs is an in-memory map, the bus is a minimal
 * waterfall implementation with the same rejection-as-denial semantics as
 * core (ADR-0004 / core §3).
 */

import assert from "node:assert/strict";
import type {
  Command,
  EventBus,
  EventEnvelope,
  Io,
  Logger,
  PluginContext,
  StateNamespace,
} from "@mola/plugin-sdk";

export interface ExecCall {
  argv: string[];
  opts: Record<string, unknown>;
}

export type FakeExec = (argv: string[], opts: Record<string, unknown>) => Promise<{ code: number; stdout: string; stderr: string }>;

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
  calls: ExecCall[];
  commands: Array<Command & { owner: string }>;
  checks: Array<{ id: string; run(): any }>;
  agents: any[];
  hooks: Map<string, Array<(value: any) => any>>;
  files: Map<string, string>;
  kv: Record<string, unknown>;
  emitted: Array<{ event: string; data: unknown }>;
}

export function makeFakeCtx(opts: { exec?: FakeExec; config?: Record<string, unknown> } = {}): FakeCtx {
  const calls: ExecCall[] = [];
  const commands: FakeCtx["commands"] = [];
  const checks: FakeCtx["checks"] = [];
  const agents: any[] = [];
  const hooks = new Map<string, Array<(value: any) => any>>();
  const files = new Map<string, string>();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const kv: Record<string, unknown> = {};

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
    emit(event, data) {
      emitted.push({ event, data });
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
        calls.push({ argv, opts: execOpts });
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
      registerCheck: (check: any) => {
        checks.push(check);
        return () => {};
      },
      list: () => checks,
    },
    agents: {
      register: (a: any) => {
        agents.push(a);
        return () => {};
      },
      list: () => agents,
      get: (id: string) => agents.find((a) => a.id === id),
    },
    tools: {
      register: () => () => {},
      list: () => [],
      get: () => undefined,
    },
    dispose: () => {},
  } as unknown as PluginContext;

  return { ctx, calls, commands, checks, agents, hooks, files, kv, emitted };
}

export function makeIo(overrides: Partial<Io> = {}): Io & { outLines: string[]; notes: string[]; errors: unknown[]; dataValue: unknown } {
  const outLines: string[] = [];
  const notes: string[] = [];
  const errors: unknown[] = [];
  let dataValue: unknown;
  return {
    json: false,
    quiet: false,
    traceId: "trace-test-0000-0000",
    cwd: "/fake/ws",
    yes: false,
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
