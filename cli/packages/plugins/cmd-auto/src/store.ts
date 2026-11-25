/**
 * Durable trigger state under `$MOLA_HOME/auto/` (default ~/.mola/auto):
 * schedules.json, hooks.json, watches.json, seen.json (webhook dedupe keys),
 * pending.json (coalescing windows) and deliveries.jsonl (the delivery log).
 * Every write is atomic, so a killed `mola serve` never leaves half a file.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonAtomic } from "@mola/plugin-sdk";

export const autoHome = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.MOLA_HOME || path.join(os.homedir(), ".mola"), "auto");

export function readList<T>(name: string, env?: NodeJS.ProcessEnv): T[] {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(autoHome(env), name), "utf8")) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function writeList<T>(name: string, list: T[], env?: NodeJS.ProcessEnv): void {
  writeJsonAtomic(path.join(autoHome(env), name), list);
}

export function readMap<T>(name: string, env?: NodeJS.ProcessEnv): Record<string, T> {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(autoHome(env), name), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {};
  } catch {
    return {};
  }
}

export function writeMap<T>(name: string, map: Record<string, T>, env?: NodeJS.ProcessEnv): void {
  writeJsonAtomic(path.join(autoHome(env), name), map);
}

export function appendLog(name: string, row: unknown, env?: NodeJS.ProcessEnv, keep = 500): void {
  const file = path.join(autoHome(env), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > keep * 2) fs.writeFileSync(file, lines.slice(-keep).join("\n") + "\n", "utf8");
  } catch {
    // trimming is best effort
  }
}

export function readLog<T>(name: string, env?: NodeJS.ProcessEnv): T[] {
  try {
    return fs
      .readFileSync(path.join(autoHome(env), name), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** `s-1a2b3c`, `h-…`, `w-…` */
export const mintId = (prefix: string): string => `${prefix}-${crypto.randomBytes(3).toString("hex")}`;

/** Exact id, or the one id that starts with the given text. */
export function pick<T extends { id: string }>(list: T[], idOrPrefix: string | undefined, what: string): T {
  if (!idOrPrefix) throw new Error(`which ${what}? give its id`);
  const exact = list.find((x) => x.id === idOrPrefix);
  if (exact) return exact;
  const hits = list.filter((x) => x.id.startsWith(idOrPrefix));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `"${idOrPrefix}" matches ${hits.length} ${what}s` : `no ${what} "${idOrPrefix}"`);
}
