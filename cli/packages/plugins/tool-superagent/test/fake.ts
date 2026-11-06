/**
 * Test doubles for the PluginContext contract (same shape as the other
 * plugins' fakes). No network and no WSL are touched: HTTP is mocked through
 * `injectFetch` + a recording fake fetch.
 */

import type {
  Command,
  EventBus,
  Io,
  Logger,
  PluginContext,
  StateNamespace,
} from "@mola/plugin-sdk";
import { injectFetch } from "../src/index.js";
import type { FetchLike } from "../src/api.js";

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
  checks: Array<{ id: string; run(): any }>;
  agents: any[];
  tools: any[];
  hooks: Map<string, Array<(value: any) => any>>;
  files: Map<string, string>;
  kv: Record<string, unknown>;
  emitted: Array<{ event: string; data: unknown }>;
}

export function makeFakeCtx(opts: { config?: Record<string, unknown> } = {}): FakeCtx {
  const commands: FakeCtx["commands"] = [];
  const checks: FakeCtx["checks"] = [];
  const agents: any[] = [];
  const tools: any[] = [];
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
      exec: async () => {
        throw new Error("no exec in superagent tests — HTTP is mocked");
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
      register: (a: any) => {
        tools.push(a);
        return () => {};
      },
      list: () => tools,
      get: (id: string) => tools.find((t) => t.id === id),
    },
    dispose: () => {},
  } as unknown as PluginContext;

  return { ctx, commands, checks, agents, tools, hooks, files, kv, emitted };
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string> | undefined;
  body: string | undefined;
}

export interface FakeFetchOpts {
  /** url → { status, body } (default 200 + body); a thrown value fakes a network failure */
  respond?: (url: string, init: RecordedRequest) => { status?: number; body?: string; throw?: Error };
}

export interface FakeHttp {
  fetch: FetchLike;
  requests: RecordedRequest[];
}

/** A recording fetch fake; inject it with `injectFetch(ctx, http.fetch)`. */
export function makeFakeFetch(opts: FakeFetchOpts = {}): FakeHttp {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const rec: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
    };
    requests.push(rec);
    const res = opts.respond?.(url, rec) ?? { status: 200, body: "{}" };
    if (res.throw) throw res.throw;
    const status = res.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => res.body ?? "" };
  };
  return { fetch, requests };
}

export function wireFetch(f: FakeCtx, http: FakeHttp): void {
  injectFetch(f.ctx, http.fetch);
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

export function errOf(e: unknown): { code: string; exitCode: number; message: string; details?: unknown } {
  const err = e as { code: string; exitCode: number; message: string; details?: unknown };
  if (!err || typeof err.code !== "string") {
    throw new Error(`expected a MolaError, got ${String(e)}`);
  }
  return err;
}

export function envelopeOf(io: ReturnType<typeof makeIo>): { instances: unknown[] } {
  const v = io.dataValue as { instances: unknown[] };
  if (!v || !Array.isArray(v.instances)) {
    throw new Error(`expected one envelope with data.instances, got ${JSON.stringify(io.dataValue)}`);
  }
  return v;
}
