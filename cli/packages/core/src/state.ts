/**
 * State store (core §2.5, DESIGN §11 conflict 14): B1 is a JSON store at
 * ~/.mola/state.json behind the StateStore interface; B2 swaps in SQLite via
 * node:sqlite without touching callers.
 *
 * Contents: run history (traceId, argv, exit, duration) and per-plugin KV
 * namespaces. Rebuildable cache belongs in ~/.mola/cache/*.json, never here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { StateNamespace } from "@mola/plugin-sdk";

export interface RunRecord {
  traceId: string;
  argv: string[];
  command: string;
  exitCode: number;
  startedAt: string;
  durationMs: number;
}

export interface StateStore {
  recordRun(run: RunRecord): void;
  runs(limit?: number): RunRecord[];
  namespace(pluginId: string): StateNamespace;
  flush(): void;
}

interface StateFile {
  schemaVersion: 1;
  runs: RunRecord[];
  kv: Record<string, Record<string, unknown>>;
}

const MAX_RUNS = 500;

export function openJsonStateStore(file: string): StateStore {
  let data: StateFile = { schemaVersion: 1, runs: [], kv: {} };
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StateFile>;
      data = {
        schemaVersion: 1,
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        kv: parsed.kv && typeof parsed.kv === "object" ? parsed.kv : {},
      };
    } catch {
      // corrupt state is not fatal: keep in-memory defaults, rewrite on flush
    }
  }

  const store: StateStore = {
    recordRun(run) {
      data.runs.push(run);
      if (data.runs.length > MAX_RUNS) data.runs.splice(0, data.runs.length - MAX_RUNS);
    },
    runs(limit = 50) {
      return data.runs.slice(-limit);
    },
    namespace(pluginId) {
      if (!data.kv[pluginId]) data.kv[pluginId] = {};
      const bucket = data.kv[pluginId];
      return {
        get<T = unknown>(key: string): T | undefined {
          return bucket[key] as T | undefined;
        },
        set(key, value) {
          bucket[key] = value;
        },
        delete(key) {
          delete bucket[key];
        },
        keys() {
          return Object.keys(bucket);
        },
      };
    },
    flush() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // atomic write: tmp + rename (same volume)
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, file);
    },
  };
  return store;
}
