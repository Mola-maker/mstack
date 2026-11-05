/**
 * Test doubles for the cmd-plugin suite.
 *
 * No real process is spawned and no real home directory is touched: the
 * plugin's home is a tmp dir (MOLA_HOME), `exec` is a scripted fake, and the
 * IO records what the command printed. The fixture plugin is copied from
 * fixtures/fake-plugin — the same tree the acceptance command installs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Command,
  DoctorCheck,
  ExecResult,
  Io,
  PluginContext,
} from "@mola/plugin-sdk";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The fixture plugin directory. The compiled helper lives at
 * dist/test/cmd-plugin/test/helpers.js, so the package root is three levels
 * up; the source layout (src/… or test/…) is two. Walk up until the
 * fixtures/fake-plugin directory shows up — one rule, both layouts.
 */
export const FIXTURE_PLUGIN = findFixture();

function findFixture(): string {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "fixtures", "fake-plugin");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`fixture plugin not found above ${HERE}`);
}

export interface ExecCall {
  argv: string[];
  opts: Record<string, unknown>;
}

export interface FakeCtx {
  ctx: PluginContext;
  commands: Array<Command & { owner: string }>;
  checks: DoctorCheck[];
  calls: ExecCall[];
  emitted: Array<{ event: string; data: unknown }>;
  hooks: Map<string, Array<(value: unknown) => unknown>>;
  kv: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface FakeIo extends Io {
  outLines: string[];
  notes: string[];
  errors: unknown[];
  dataValue: unknown;
}

const nullLog = {
  level: "error" as const,
  child: () => nullLog,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function makeFakeCtx(opts: { config?: Record<string, unknown> } = {}): FakeCtx {
  const commands: FakeCtx["commands"] = [];
  const checks: DoctorCheck[] = [];
  const calls: ExecCall[] = [];
  const emitted: FakeCtx["emitted"] = [];
  const hooks = new Map<string, Array<(value: unknown) => unknown>>();
  const kv: Record<string, unknown> = {};
  const config = opts.config ?? {};

  const ctx = {
    id: "mola-cmd-plugin",
    manifest: { id: "mola-cmd-plugin", version: "0.1.0", permissions: {} },
    log: nullLog,
    events: {
      emit(event: string, data: unknown) {
        emitted.push({ event, data });
      },
      on: () => () => {},
      hook(event: string, fn: (value: unknown) => unknown) {
        const list = hooks.get(event) ?? [];
        list.push(fn);
        hooks.set(event, list);
        return () => {};
      },
      async runWaterfall(event: string, value: unknown) {
        let current = value;
        for (const fn of hooks.get(event) ?? []) current = await fn(current);
        return current;
      },
      onSerial: () => () => {},
      async runSerial() {},
    },
    commands: {
      register(command: Command) {
        commands.push({ ...command, owner: "mola-cmd-plugin" });
        return () => {};
      },
    },
    config: {
      get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback),
      has: (key: string) => key in config,
      all: () => ({ ...config }),
      onChange: () => () => {},
    },
    configWriter: undefined,
    state: {
      get: <T>(k: string) => kv[k] as T | undefined,
      set: (k: string, v: unknown) => {
        kv[k] = v;
      },
      delete: (k: string) => {
        delete kv[k];
      },
      keys: () => Object.keys(kv),
    },
    permissions: {},
    process: {
      exec: async (argv: string[], execOpts: Record<string, unknown> = {}) => {
        calls.push({ argv, opts: execOpts });
        return { code: 0, stdout: "", stderr: "" } as ExecResult;
      },
    },
    fs: {
      readFile: (p: string) => fs.readFileSync(p, "utf8"),
      writeFile: (p: string, data: string) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data);
      },
    },
    sidecars: { ensure: async () => ({}), call: async () => ({}), notify: () => {} },
    plugins: {
      list: () => [],
      plan: () => ({ ok: true, errors: [], order: [], quarantined: [] }),
    },
    doctor: {
      registerCheck(check: DoctorCheck) {
        checks.push(check);
        return () => {};
      },
      list: () => checks,
    },
    agents: { register: () => () => {}, list: () => [], get: () => undefined },
    tools: { register: () => () => {}, list: () => [], get: () => undefined },
    dispose: () => {},
  } as unknown as PluginContext;

  return { ctx, commands, checks, calls, emitted, hooks, kv, config };
}

export function makeIo(overrides: Partial<Io> = {}): FakeIo {
  const outLines: string[] = [];
  const notes: string[] = [];
  const errors: unknown[] = [];
  let dataValue: unknown;
  const io = {
    json: false,
    quiet: false,
    traceId: "trace-test-0000-0000",
    cwd: os.tmpdir(),
    yes: false,
    data(v: unknown) {
      dataValue = v;
    },
    out(line: string) {
      outLines.push(line);
    },
    note(message: string) {
      notes.push(message);
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
  } as unknown as FakeIo;
  return io;
}

/** A tmp mola home; the plugin reads MOLA_HOME through molaHome(). */
export function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mola-home-"));
}

/** Copy the fixture plugin into a tmp dir (an install source). */
export function copyFixture(target?: string): string {
  const dir = target ?? fs.mkdtempSync(path.join(os.tmpdir(), "mola-fixture-"));
  fs.cpSync(FIXTURE_PLUGIN, dir, { recursive: true });
  return dir;
}

/** Find a registered command by its path. */
export function commandOf(f: FakeCtx, path_: string): Command {
  const hit = f.commands.find((c) => c.path.join(" ") === path_);
  if (!hit) throw new Error(`command not registered: ${path_}`);
  return hit;
}

/** The error thrown by a handler, as {code, exitCode, message}. */
export function errOf(e: unknown): { code: string; exitCode: number; message: string } {
  const err = e as { code: string; exitCode: number; message: string };
  if (!err || typeof err.code !== "string") {
    throw new Error(`expected a MolaError, got ${String(e)}`);
  }
  return err;
}
