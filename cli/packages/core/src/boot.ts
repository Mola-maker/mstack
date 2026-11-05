/**
 * Boot sequence (core §2.1):
 *
 *   a. load config layers          → ConfigView        } fatal on failure
 *   b. open state store            → StateStore        } (steps a–c → exit 70,
 *   c. init logging with traceId   → Logger            }  bad config → 65)
 *   d. resolve+validate+plan plugins → LoadPlan
 *   e. activate in topo order; failures quarantine, boot continues degraded
 *   3. router.dispatch(argv)
 *   4. shutdown: mola.core.shutdown (serial), deactivate in reverse, flush
 */

import * as path from "node:path";
import * as os from "node:os";
import type { LogLevel } from "@mola/plugin-sdk";
import { MolaEvents, toMolaError, ExitCode } from "@mola/plugin-sdk";
import { loadConfig, makeConfigWriter } from "./config.js";
import { openJsonStateStore } from "./state.js";
import { createFileLogger } from "./logging.js";
import { CoreEventBus } from "./bus.js";
import { CommandRouter, IoImpl } from "./router.js";
import {
  resolvePlugins,
  planLoad,
  activateAll,
  scanUserPlugins,
  type PluginSource,
} from "./loader.js";
import {
  makePluginContext,
  PluginRegistryImpl,
  DoctorRegistryImpl,
  AgentRegistryImpl,
  ToolRegistryImpl,
  type ContextServices,
} from "./context.js";

export interface GlobalFlags {
  json: boolean;
  verbose: number;
  quiet: boolean;
  yes: boolean;
  noColor: boolean;
  configFile?: string;
  cwd: string;
}

export interface BootOptions {
  /** command argv with global flags already stripped by the bin */
  argv: string[];
  flags: GlobalFlags;
  traceId: string;
  /** directories containing mola-plugin.json for each bundled plugin */
  builtinPluginDirs: string[];
}

/** Print an error before the logger exists (fatal steps a–c). */
function earlyError(flags: GlobalFlags, traceId: string, err: unknown): void {
  const e = toMolaError(err, ExitCode.Software);
  if (flags.json) {
    process.stderr.write(
      JSON.stringify({
        schemaVersion: 1,
        traceId,
        error: { code: e.code, message: e.message },
      }) + "\n",
    );
  } else {
    process.stderr.write(`mola: ${e.code}: ${e.message}\n`);
  }
}

export async function boot(opts: BootOptions): Promise<number> {
  const { flags, traceId } = opts;
  const t0 = Date.now();
  const homeDir = process.env.MOLA_HOME || path.join(os.homedir(), ".mola");
  process.env.MOLA_TRACE_ID = traceId;

  // step a — config (fatal: bad config → 65)
  let config;
  try {
    config = loadConfig({
      homeDir,
      projectDir: flags.cwd,
      env: process.env,
      extraFile: flags.configFile,
    });
  } catch (err) {
    earlyError(flags, traceId, err);
    return toMolaError(err, ExitCode.DataErr).exitCode;
  }

  // step b — state (fatal → 70)
  let state;
  try {
    state = openJsonStateStore(path.join(homeDir, "state.json"));
  } catch (err) {
    earlyError(flags, traceId, err);
    return ExitCode.Software;
  }

  // step c — logging (fatal → 70)
  let log;
  try {
    const level: LogLevel = flags.quiet
      ? "error"
      : flags.verbose >= 2
        ? "trace"
        : flags.verbose === 1
          ? "debug"
          : ((config.get<string>("log.level", "info") as LogLevel) ?? "info");
    log = createFileLogger(path.join(homeDir, "logs"), level, traceId);
  } catch (err) {
    earlyError(flags, traceId, err);
    return ExitCode.Software;
  }

  const registry = new PluginRegistryImpl();
  const doctor = new DoctorRegistryImpl();
  const agents = new AgentRegistryImpl();
  const tools = new ToolRegistryImpl();
  const contexts = new Map<string, { runDisposers(): Promise<void> }>();

  const bus = new CoreEventBus({
    log,
    traceId,
    onQuarantine: (id, event, error) => {
      registry.markQuarantined(id, error);
      bus.emit(MolaEvents.PluginQuarantined, { id, event, error: String(error) });
      void contexts.get(id)?.runDisposers();
    },
  });

  const router = new CommandRouter({ bus, traceId });

  // config watcher → mola.config.changed (core §2.4)
  config.onChange((layer, keys) => bus.emit(MolaEvents.ConfigChanged, { layer, keys }));

  const services: ContextServices = {
    bus,
    router,
    config,
    configWriter: makeConfigWriter(homeDir),
    stateNamespace: (id) => state.namespace(id),
    rootLog: log,
    plugins: registry,
    doctor,
    agents,
    tools,
  };

  // step d — resolve + plan
  const sources: PluginSource[] = opts.builtinPluginDirs.map((dir) => ({ dir, tier: "builtin" as const }));
  sources.push(...scanUserPlugins(homeDir, log));
  for (const rel of config.get<string[]>("plugins", [])) {
    sources.push({ dir: path.resolve(flags.cwd, rel), tier: "untrusted" });
  }
  const { resolved, errors: resolveErrors } = resolvePlugins(sources);
  const plan = planLoad(resolved);
  registry.setPlan(plan, resolveErrors);
  for (const p of resolved) registry.addResolved(p);
  for (const err of [...resolveErrors, ...plan.errors]) {
    log.error("plugin plan error", { error: err });
  }

  // step e — activate in topo order; failures quarantine, boot continues
  await activateAll(plan, {
    makeContext: (p) => {
      const ctx = makePluginContext(p, services);
      contexts.set(p.manifest.id, ctx);
      return ctx;
    },
    onActivated: (p) => {
      log.info("plugin activated", { plugin: p.manifest.id, version: p.manifest.version });
      bus.emit(MolaEvents.PluginActivated, { id: p.manifest.id, version: p.manifest.version });
    },
    onQuarantined: (p, error) => {
      registry.markQuarantined(p.manifest.id, error);
      log.error("plugin quarantined", { plugin: p.manifest.id, error: String(error) });
      bus.emit(MolaEvents.PluginQuarantined, {
        id: p.manifest.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    log,
  });

  const planReport = registry.plan();
  await bus.runSerial(MolaEvents.CoreBoot, {
    plugins: planReport.order,
    degraded: planReport.quarantined,
  });

  // step 3 — dispatch
  const io = new IoImpl(flags.json, flags.quiet, traceId, flags.cwd, flags.yes);
  const code = await router.dispatch(opts.argv, io, config.get<Record<string, string>>("aliases", {}));

  // run history (core §2.5), keyed by traceId
  state.recordRun({
    traceId,
    argv: opts.argv,
    command: io.commandPath,
    exitCode: code,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
  });

  // step 4 — shutdown: serial event, deactivate in reverse order, flush
  await bus.runSerial(MolaEvents.CoreShutdown, {});
  for (const ctx of [...contexts.values()].reverse()) {
    await ctx.runDisposers();
  }
  config.close();
  state.flush();
  log.info("shutdown", { exitCode: code, durationMs: Date.now() - t0 });
  return code;
}
