/**
 * Where mola keeps its state, and where the mstack skills live.
 *
 * The home directory rule is the one core/boot.ts uses: MOLA_HOME overrides
 * ~/.mola (the test suites redirect it into a tmp dir). The skills source is
 * the mstack repo — the directory that carries both `skills/` and
 * `.claude-plugin/plugin.json` (the Claude Code plugin manifest whose version
 * `mola version` reports).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The mola home: $MOLA_HOME, else ~/.mola (same rule as core's boot). */
export function molaHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOLA_HOME || path.join(os.homedir(), ".mola");
}

/** True when `dir` looks like the mstack repo root. */
export function isMstackRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json")) &&
    fs.existsSync(path.join(dir, "skills"))
  );
}

/**
 * Find the mstack repo root, in this order:
 *   1. $MOLA_MSTACK_DIR
 *   2. the `skills.source` config value (a path to the repo root)
 *   3. an upward walk from the working directory
 *   4. an upward walk from this package (the workspace layout: cli/packages/
 *      plugins/cmd-plugin/dist → … → the repo root)
 *
 * Returns null when the skills are not reachable from this machine — the
 * caller then reports the human-readable install line instead of guessing.
 */
export function findMstackRoot(opts: {
  cwd: string;
  configSource?: string;
  env?: NodeJS.ProcessEnv;
  startDir?: string;
}): string | null {
  const env = opts.env ?? process.env;
  const candidates: string[] = [];
  if (env.MOLA_MSTACK_DIR) candidates.push(path.resolve(env.MOLA_MSTACK_DIR));
  if (opts.configSource) candidates.push(path.resolve(opts.configSource));
  for (const dir of candidates) {
    if (isMstackRoot(dir)) return dir;
  }
  // upward walks
  for (const start of [opts.cwd, opts.startDir ?? path.dirname(import.meta.url ?? ".")]) {
    if (!start) continue;
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i++) {
      if (isMstackRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** The skills version, read from .claude-plugin/plugin.json (core §1 item 3). */
export function readSkillsVersion(root: string): string | null {
  const file = path.join(root, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}
