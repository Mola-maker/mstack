/**
 * Test harness: a fake PluginContext over a scripted ExecService, so tests
 * never run magpie or an agent CLI for real (B1 rule: tests mock magpie).
 */

import type {
  AgentAdapter,
  Command,
  Disposer,
  DoctorCheck,
  ExecOptions,
  ExecResult,
  ExecService,
  Io,
  PluginContext,
  ToolAdapter,
} from "@mola/plugin-sdk";

export type ExecScript = (argv: string[], opts?: ExecOptions) => ExecResult | Promise<ExecResult>;

export function fakeExec(script: ExecScript): ExecService & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async exec(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
      calls.push(argv);
      const r = await script(argv, opts);
      return r;
    },
  };
}

export interface CapturedCommand extends Command {
  handler: Command["handler"];
}

export interface FakeIo extends Io {
  datas: unknown[];
  outs: string[];
  notes: string[];
}

export function fakeIo(json = false): FakeIo {
  const io: FakeIo = {
    json,
    quiet: false,
    traceId: "test-trace",
    cwd: "/tmp",
    yes: false,
    datas: [],
    outs: [],
    notes: [],
    data(value: unknown) {
      io.datas.push(value);
    },
    out(line: string) {
      io.outs.push(line);
    },
    note(message: string) {
      io.notes.push(message);
    },
    error(err: unknown) {
      io.notes.push(`error: ${String(err)}`);
    },
  };
  return io;
}

export interface FakeCtxExtras {
  exec?: ExecService;
  config?: Record<string, unknown>;
}

export interface FakeCtx extends PluginContext {
  commands: { registered: CapturedCommand[]; register(c: Command): Disposer };
  tools: { registered: ToolAdapter[]; register(t: ToolAdapter): Disposer; list(): ToolAdapter[]; get(id: string): ToolAdapter | undefined };
  agents: { registered: AgentAdapter[]; register(a: AgentAdapter): Disposer; list(): AgentAdapter[]; get(id: string): AgentAdapter | undefined };
  doctor: {
    checks: DoctorCheck[];
    registerCheck(c: DoctorCheck): Disposer;
    list(): DoctorCheck[];
  };
}

/** A minimal PluginContext carrying only what these plugins touch. */
export function fakeCtx(extras: FakeCtxExtras = {}): FakeCtx {
  const commands: CapturedCommand[] = [];
  const tools: ToolAdapter[] = [];
  const agents: AgentAdapter[] = [];
  const checks: DoctorCheck[] = [];
  const log = {
    level: "error" as const,
    child: () => log,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const config = extras.config ?? {};
  return {
    id: "test-plugin",
    manifest: {} as PluginContext["manifest"],
    log,
    events: {} as PluginContext["events"],
    commands: {
      registered: commands,
      register(c: Command) {
        commands.push(c as CapturedCommand);
        return () => {};
      },
    },
    config: {
      get: (key: string, fallback?: unknown) =>
        key in config ? (config as Record<string, unknown>)[key] : fallback,
      has: (key: string) => key in config,
      all: () => config,
      onChange: () => () => {},
    },
    state: { get: () => undefined, set: () => {}, delete: () => {}, keys: () => [] },
    permissions: {},
    process: extras.exec ?? fakeExec(() => ({ code: 0, stdout: "", stderr: "" })),
    fs: { readFile: () => "", writeFile: () => {} },
    sidecars: { ensure: async () => ({}), call: async () => ({}), notify: () => {} },
    plugins: { list: () => [], plan: () => ({ ok: true, errors: [], order: [], quarantined: [] }) },
    doctor: {
      checks,
      registerCheck(c: DoctorCheck) {
        checks.push(c);
        return () => {};
      },
      list: () => checks,
    },
    agents: {
      registered: agents,
      register(a: AgentAdapter) {
        agents.push(a);
        return () => {};
      },
      list: () => agents,
      get: () => undefined,
    },
    tools: {
      registered: tools,
      register(t: ToolAdapter) {
        tools.push(t);
        return () => {};
      },
      list: () => tools,
      get: () => undefined,
    },
    dispose: () => {},
  } as unknown as FakeCtx;
}

/** Find a registered command by its path. */
export function commandOf(ctx: ReturnType<typeof fakeCtx>, path: string[]): CapturedCommand {
  const hit = ctx.commands.registered.find((c) => c.path.join(" ") === path.join(" "));
  if (!hit) throw new Error(`command not registered: ${path.join(" ")}`);
  return hit;
}
