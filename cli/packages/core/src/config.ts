/**
 * Config layering (core §2.4, DESIGN §11 conflict 5: JSONC everywhere).
 *
 * Five layers, deep-merged, later wins:
 *   builtin defaults < ~/.mola/config.jsonc < .mola/config.jsonc (project)
 *     < MOLA_* env < flags (--config extra file)
 *
 * ConfigView is read-only + onChange (fs watch, debounced, emits
 * mola.config.changed via boot wiring). Writes go through `mola config set`
 * (cmd-config), which persists to the global file via writeGlobalConfig.
 * Secrets are never config — cmd-config refuses secret-shaped keys.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ConfigView, ConfigWriter, Disposer } from "@mola/plugin-sdk";
import { MolaError, ExitCode } from "@mola/plugin-sdk";
import { parseJsonc } from "./jsonc.js";
import { deepMerge, deepFreeze, getPath, setPath } from "./merge.js";

export interface LoadConfigOptions {
  /** resolved ~/.mola directory */
  homeDir: string;
  /** project dir for the .mola/config.jsonc layer */
  projectDir: string;
  env: Record<string, string | undefined>;
  /** --config <path>: whole extra file merged at the flags layer */
  extraFile?: string;
}

export const BUILTIN_DEFAULTS: Record<string, unknown> = {
  log: { level: "info" },
  color: true,
  aliases: {},
  plugins: [],
};

function readJsoncFile(file: string, layer: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const value = parseJsonc(fs.readFileSync(file, "utf8"), `${layer} (${file})`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MolaError("CONFIG_INVALID", `${layer} (${file}): top level must be an object`, ExitCode.DataErr);
  }
  return value as Record<string, unknown>;
}

/** MOLA_* env layer (core §2.4 lists the mapped keys). */
function envLayer(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (env.MOLA_LOG_LEVEL) setPath(out, "log.level", env.MOLA_LOG_LEVEL);
  if (env.MOLA_NO_COLOR) setPath(out, "color", false);
  if (env.MOLA_YES) setPath(out, "yes", true);
  return out;
}

export class CoreConfig implements ConfigView {
  private readonly merged: Record<string, unknown>;
  private readonly watchers: Array<{ layer: string; file: string }> = [];
  private readonly listeners: Array<(layer: string, keys: string[]) => void> = [];
  private watcherHandles: any[] = [];

  constructor(
    layers: Record<string, unknown>[],
    watchFiles: Array<{ layer: string; file: string }>,
  ) {
    let merged: unknown = {};
    for (const layer of layers) merged = deepMerge(merged, layer);
    this.merged = deepFreeze((merged ?? {}) as Record<string, unknown>);
    this.watchers = watchFiles;
  }

  get<T = unknown>(key: string, fallback?: T): T {
    const r = getPath(this.merged, key);
    return (r.found ? r.value : fallback) as T;
  }

  has(key: string): boolean {
    return getPath(this.merged, key).found;
  }

  all(): Record<string, unknown> {
    return this.merged;
  }

  onChange(fn: (layer: string, keys: string[]) => void): Disposer {
    this.listeners.push(fn);
    this.ensureWatching();
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private ensureWatching(): void {
    if (this.watcherHandles.length > 0) return;
    for (const { layer, file } of this.watchers) {
      if (!fs.existsSync(file)) continue;
      let timer: any = null;
      try {
        const handle = fs.watch(file, () => {
          // debounce: editors often write config in two passes
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            for (const fn of this.listeners) {
              try {
                fn(layer, []);
              } catch {
                /* listener errors never break config */
              }
            }
          }, 100);
        });
        if (handle && typeof handle.unref === "function") handle.unref();
        this.watcherHandles.push(handle);
      } catch {
        /* fs.watch unsupported (some mounts) — config change events are best-effort */
      }
    }
  }

  close(): void {
    for (const h of this.watcherHandles) {
      try {
        h.close();
      } catch {
        /* ignore */
      }
    }
    this.watcherHandles = [];
  }
}

export function loadConfig(opts: LoadConfigOptions): CoreConfig {
  const globalFile = path.join(opts.homeDir, "config.jsonc");
  const projectFile = path.join(opts.projectDir, ".mola", "config.jsonc");
  const layers: Record<string, unknown>[] = [
    BUILTIN_DEFAULTS,
    readJsoncFile(globalFile, "global config"),
    readJsoncFile(projectFile, "project config"),
    envLayer(opts.env),
  ];
  if (opts.extraFile) {
    layers.push(readJsoncFile(path.resolve(opts.projectDir, opts.extraFile), "--config file"));
  }
  return new CoreConfig(layers, [
    { layer: "global", file: globalFile },
    { layer: "project", file: projectFile },
  ]);
}

/**
 * Persist one dotted key to the global layer. Comments are not preserved on
 * rewrite (JSONC is accepted on read; writes emit plain JSON).
 */
export function writeGlobalConfig(homeDir: string, key: string, value: unknown): void {
  const file = path.join(homeDir, "config.jsonc");
  let obj: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = parseJsonc(fs.readFileSync(file, "utf8"), `global config (${file})`);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new MolaError("CONFIG_INVALID", `${file}: top level must be an object`, ExitCode.DataErr);
    }
    obj = parsed as Record<string, unknown>;
  }
  setPath(obj, key, value);
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/** ConfigWriter granted to plugins whose permissions.mola includes config.write. */
export function makeConfigWriter(homeDir: string): ConfigWriter {
  return {
    set(key, value) {
      writeGlobalConfig(homeDir, key, value);
    },
  };
}
