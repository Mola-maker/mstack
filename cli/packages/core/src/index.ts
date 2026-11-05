export * from "./errors.js";
export { boot, type BootOptions, type GlobalFlags } from "./boot.js";
export { parseJsonc, stripJsonc } from "./jsonc.js";
export { deepMerge, deepFreeze, getPath, setPath } from "./merge.js";
export { loadConfig, writeGlobalConfig, makeConfigWriter, CoreConfig, BUILTIN_DEFAULTS } from "./config.js";
export { openJsonStateStore, type StateStore, type RunRecord } from "./state.js";
export { createFileLogger, createNullLogger } from "./logging.js";
export { CoreEventBus, type BusOptions } from "./bus.js";
export { CommandRouter, IoImpl, type RegisteredCommand } from "./router.js";
export {
  resolvePlugin,
  resolvePlugins,
  planLoad,
  activateAll,
  scanUserPlugins,
  type PluginSource,
  type ResolvedPlugin,
  type LoadPlan,
} from "./loader.js";
export {
  makePluginContext,
  PluginRegistryImpl,
  DoctorRegistryImpl,
  AgentRegistryImpl,
  ToolRegistryImpl,
} from "./context.js";
export { globToRegExp, matchesAnyGlob } from "./glob.js";
