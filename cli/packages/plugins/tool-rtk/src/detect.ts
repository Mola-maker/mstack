/**
 * tool-rtk — rtk discovery (B1).
 *
 * rtk is the machine's output compactor (adapters-routing §3.3). mola only ever
 * *wraps* it: `rtk rewrite`, `rtk bypass`, `rtk gain` (cmd-rtk owns the
 * passthrough command; this plugin owns detection + the `tool.rtk` doctor check).
 *
 * Where rtk lives (grounded in the machine, not invented):
 * - Windows: installed by WinGet into
 *   `%LOCALAPPDATA%\Microsoft\WinGet\Packages\rtk-ai.rtk_*\rtk.exe` and exposed
 *   on the user PATH (the WinGet Links dir). The package dir name carries a
 *   publisher/version suffix, so the last path segment is matched by glob.
 * - WSL: rtk may be absent entirely (`~/.local/bin/rtk` here is a separate
 *   Linux install). Absence is reported, never fatal — rtk is an optimisation,
 *   not a dependency of the CLI.
 *
 * Everything in this file is pure/synchronous filesystem work so the unit tests
 * can drive it with fixture directories and never touch the real machine.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface RtkLocation {
  /** absolute path of the rtk executable, or null when it was not found */
  path: string | null;
  /** how it was found — useful in doctor output */
  source: "path" | "winget" | "none";
}

export interface RtkInfo extends RtkLocation {
  /** e.g. "rtk 1.1.0"; null when the version could not be read */
  version: string | null;
  /** platform the detection ran on */
  platform: NodeJS.Platform;
}

const EXE_SUFFIX = ".exe";

/** PATHEXT on Windows; POSIX shells use an empty extension list. */
function exeExtensions(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [""];
  const pathext = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const list = pathext
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  return list.length > 0 ? [...list, ""] : [""];
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan PATH for `rtk` (or `rtk.exe`). Pure PATH scan — no `where`/`which`
 * shell-out, so it behaves identically on Windows and in WSL.
 */
export function findOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  name = "rtk",
): string | null {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  const dirs = raw.split(path.delimiter).filter((d) => d.length > 0);
  const exts = exeExtensions(env, platform);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Windows-only: `%LOCALAPPDATA%\Microsoft\WinGet\Packages\rtk-ai.rtk_*\rtk.exe`.
 * The WinGet package dir carries a version suffix, so it is matched by prefix
 * and the newest-looking directory wins (lexicographic max is stable and does
 * not depend on mtime resolution across filesystems).
 */
export function findInWinget(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== "win32") return null;
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return null;
  const packagesDir = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("rtk-ai.rtk"))
    .map((e) => path.join(packagesDir, e.name, "rtk.exe"))
    .filter((p) => isExecutableFile(p))
    .sort();
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/** Locate rtk: PATH first, then the WinGet package dir (Windows only). */
export function locateRtk(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): RtkLocation {
  const onPath = findOnPath(env, platform, "rtk");
  if (onPath) return { path: onPath, source: "path" };
  const winget = findInWinget(env, platform);
  if (winget) return { path: winget, source: "winget" };
  return { path: null, source: "none" };
}

/**
 * Parse `rtk --version` output ("rtk 1.1.0") into a bare version string.
 * Returns the raw first line when it does not match, so an unexpected format
 * is still visible in doctor output instead of being swallowed.
 */
export function parseVersion(raw: string): string | null {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const m = line.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : line;
}
