/**
 * The plugin contract (core §2.2). This package is the single definition point
 * for all interfaces (DESIGN §11 conflict 3); core implements them, plugins
 * consume them.
 */

import type { EventBus, Disposer } from "./events.js";
import type { ExitCode } from "./errors.js";
import type { PermissionSet, PluginManifest, PluginKind, TrustTier } from "./manifest.js";

export interface Plugin {
  activate(ctx: PluginContext): void | Promise<void>;
  /** optional; ctx.dispose covers most cases */
  deactivate?(): void | Promise<void>;
}

export function definePlugin(p: Plugin): Plugin {
  return p;
}

/** A plugin entry module may default-export the Plugin or a factory. */
export type PluginModule = { default?: Plugin | (() => Plugin) };

// ---------------------------------------------------------------- commands

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface Command {
  /** namespaced path, e.g. ['plugin', 'install'] */
  path: string[];
  /** one line, for `mola --help` */
  description: string;
  /** positional/flag schema — validation + help + --json errors (B2) */
  args?: Record<string, unknown>;
  handler(args: ParsedArgs, io: Io): Promise<ExitCode>;
}

export interface CommandRegistry {
  register(command: Command): Disposer;
}

/**
 * Handler IO (core §2.3/§8.2). `data()` feeds the --json envelope; `out()` is
 * human stdout (routed to stderr in --json mode); `note()` is always stderr.
 * Handlers never call process.exit; they return an ExitCode.
 */
export interface Io {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly traceId: string;
  readonly cwd: string;
  /** true when --yes / MOLA_YES=1 (policy gates may skip prompts when allowed) */
  readonly yes: boolean;
  data(value: unknown): void;
  out(line: string): void;
  note(message: string): void;
  error(err: unknown): void;
}

// ------------------------------------------------------------------ logging

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface Logger {
  readonly level: LogLevel;
  child(fields: Record<string, unknown>): Logger;
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

// ------------------------------------------------------------------- config

/** Read-only layered config view (core §2.4). Writes go through cmd-config. */
export interface ConfigView {
  get<T = unknown>(key: string, fallback?: T): T;
  has(key: string): boolean;
  /** deep-frozen merged view of all layers */
  all(): Record<string, unknown>;
  onChange(fn: (layer: string, keys: string[]) => void): Disposer;
}

/** Granted only to plugins whose permissions.mola includes "config.write". */
export interface ConfigWriter {
  /** persist a dotted key to the global layer (~/.mola/config.jsonc) */
  set(key: string, value: unknown): void;
}

// -------------------------------------------------------------------- state

/** Per-plugin KV namespace (core §2.5). */
export interface StateNamespace {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

// --------------------------------------------------------- services (gated)

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

/** Permission-checked spawn; argv[0] must match the process.exec allow-list. */
export interface ExecService {
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
}

/** Permission-checked fs; paths must match the fs.read/fs.write glob allow-list. */
export interface FsService {
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
}

/** Sidecar host service (ADR-0001). Stub in B1 — sidecars start in B3. */
export interface SidecarService {
  ensure(name: string): Promise<unknown>;
  call<T>(handle: unknown, method: string, params?: unknown): Promise<T>;
  notify(handle: unknown, method: string, params?: unknown): void;
}

// ---------------------------------------------------------- core registries

export interface PluginInfo {
  id: string;
  version: string;
  kind: PluginKind;
  tier: TrustTier;
  enabled: boolean;
  state: "active" | "quarantined";
  error?: string;
  provides: string[];
  permissions: PermissionSet;
}

/** Result of resolve→validate→plan without activation (`mola plugin doctor`). */
export interface PlanReport {
  ok: boolean;
  errors: string[];
  /** plugin ids in activation (topological) order */
  order: string[];
  quarantined: string[];
}

export interface PluginRegistry {
  list(): PluginInfo[];
  plan(): PlanReport;
}

export interface CheckResult {
  ok: boolean;
  /** passes, but the message names a gap someone should close (shown as a warning, never a failure) */
  warn?: boolean;
  message?: string;
  /** sysexits code this failing check maps to (default 69) */
  exitCode?: number;
}

export interface DoctorCheck {
  /** e.g. "node>=22", "plugins.plan-ok", "magpie.healthcheck" */
  id: string;
  description?: string;
  run(): CheckResult | Promise<CheckResult>;
}

/**
 * Extension point for step 2+ (core §2.2 note): cmd-doctor ships the doctor
 * framework and its own checks; other plugins register more checks here
 * (tool-magpie → magpie.healthcheck, agent-dsh → agent.dsh, tool-rtk, tool-git…).
 */
export interface DoctorRegistry {
  registerCheck(check: DoctorCheck): Disposer;
  list(): DoctorCheck[];
}

// ------------------------------------------------------ adapter interfaces
// Full shapes land with their batches (adapters-routing §2–3); these are the
// registration surfaces step 2 plugs into.

export interface AgentDetection {
  available: boolean;
  version?: string;
  managedByMagpie?: boolean;
  health?: "ok" | "broken" | "unknown";
  detail?: string;
}

export interface AgentAdapter {
  id: string;
  /** PATH probe + magpie merge (tool-magpie supplies the magpie side in step 2) */
  detect(): Promise<AgentDetection>;
  // The B2 run surface (run/resume/listSessions/usage/bridgeHooks) extends this
  // interface as HeadlessAgentAdapter — see ./agents.js and ./../AGENTS.md.
}

export interface ToolProbe {
  ok: boolean;
  detail?: string;
}

export interface ToolAdapter {
  id: string;
  probe(): Promise<ToolProbe>;
}

export interface AgentRegistry {
  register(adapter: AgentAdapter): Disposer;
  list(): AgentAdapter[];
  get(id: string): AgentAdapter | undefined;
}

export interface ToolRegistry {
  register(adapter: ToolAdapter): Disposer;
  list(): ToolAdapter[];
  get(id: string): ToolAdapter | undefined;
}

// ---------------------------------------------------------- plugin context

export interface PluginContext {
  readonly id: string;
  /** validated, frozen */
  readonly manifest: PluginManifest;
  /** child logger, {plugin: id, trace} */
  readonly log: Logger;
  readonly events: EventBus;
  readonly commands: CommandRegistry;
  readonly config: ConfigView;
  /** present only when permissions.mola includes "config.write" */
  readonly configWriter?: ConfigWriter;
  readonly state: StateNamespace;
  /** granted subset of manifest.permissions */
  readonly permissions: PermissionSet;
  readonly process: ExecService;
  readonly fs: FsService;
  readonly sidecars: SidecarService;
  readonly plugins: PluginRegistry;
  readonly doctor: DoctorRegistry;
  readonly agents: AgentRegistry;
  readonly tools: ToolRegistry;
  /** reversible effect, Cordis-style; unwound on deactivate/quarantine */
  dispose(fn: () => void | Promise<void>): void;
}
