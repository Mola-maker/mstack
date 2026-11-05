export * from "./errors.js";
export { boot, type BootOptions, type GlobalFlags } from "./boot.js";
export { parseJsonc, stripJsonc } from "./jsonc.js";
export { deepMerge, deepFreeze, getPath, setPath } from "./merge.js";
export { loadConfig, writeGlobalConfig, makeConfigWriter, CoreConfig, BUILTIN_DEFAULTS } from "./config.js";
export {
  openJsonStateStore,
  openSqliteStateStore,
  openStateStore,
  type StateStore,
  type RunRecord,
  type StateSnapshot,
  type StateLog,
} from "./state.js";
export { createFileLogger, createNullLogger } from "./logging.js";
export {
  CoreEventBus,
  describeActiveBus,
  type BusOptions,
  type ListenerInfo,
  type ListenerKind,
} from "./bus.js";
export { CommandRouter, IoImpl, type RegisteredCommand } from "./router.js";
export {
  resolvePlugin,
  resolvePlugins,
  planLoad,
  activateAll,
  scanUserPlugins,
  diffPermissions,
  formatPermissionDiff,
  readPluginRegistry,
  writePluginRegistry,
  pluginsRegistryFile,
  pluginsInstallDir,
  hashPluginTree,
  hashPluginFile,
  listPluginFiles,
  PERMISSION_KEYS,
  type PluginSource,
  type ResolvedPlugin,
  type LoadPlan,
  type PermissionDiff,
  type PermissionDiffEntry,
  type PermissionKey,
  type PluginRegistryFile,
  type PluginRegistryRecord,
} from "./loader.js";
export {
  makePluginContext,
  PluginRegistryImpl,
  DoctorRegistryImpl,
  AgentRegistryImpl,
  ToolRegistryImpl,
} from "./context.js";
export { globToRegExp, matchesAnyGlob } from "./glob.js";
