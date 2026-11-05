/**
 * Platform + path facts for the dispatch flow (adapters-routing §2.10,
 * tasks/dispatch.sh). DSH runs in WSL: on Windows mola reaches it with
 * `wsl -e bash -lc …` — spawned directly from Node (never through Git Bash, so
 * no MSYS path rewriting can touch the argv; MSYS_NO_PATHCONV=1 is still set
 * defensively). Inside Linux/WSL it runs dsh in a login shell after sourcing
 * the stack env script. Windows paths map to /mnt/e/... once, for the cd;
 * everything else is passed as cwd-relative paths, which map 1:1 across the
 * E:\ ↔ /mnt/e/ boundary.
 */

export const DSH_ENV_SH = "~/src/mola-dsh-stack/scripts/env.sh";
export const DSH_PROFILE = "mola-cli";
/** the tested default worker route (magpie group, harness-commands.md) */
export const DEFAULT_ROUTE = "group/smart-split";
/** mirrors `timeout 3600` in tasks/dispatch.sh */
export const DISPATCH_TIMEOUT_MS = 3_600_000;

export function onWindows(): boolean {
  return (process.env.MOLA_PLATFORM ?? process.platform) === "win32";
}

export function dshMachine(env: NodeJS.ProcessEnv = process.env): string {
  if (onWindows()) return "wsl:Ubuntu";
  return env.WSL_DISTRO_NAME ? `wsl:${env.WSL_DISTRO_NAME}` : "local";
}

/** E:\mstack → /mnt/e/mstack; null when the path is not a drive-letter path. */
export function winToWslPath(p: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return null;
  const rest = m[2].replace(/\\/g, "/").replace(/\/+$/, "");
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/** Single-quote a value for safe interpolation into a bash -lc script. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * cwd-relative POSIX reference for a file that lives under the workspace
 * (relative paths survive the E:\ ↔ /mnt/e mapping untouched); absolute WSL
 * path as the fallback for files outside cwd.
 */
export function wslFileRef(cwd: string, absPath: string, windows: boolean): string | null {
  if (windows) {
    const wslCwd = winToWslPath(cwd);
    const wslAbs = winToWslPath(absPath);
    if (wslCwd && wslAbs && (wslAbs + "/").startsWith(wslCwd + "/")) {
      return wslAbs.slice(wslCwd.length + 1);
    }
    return wslAbs;
  }
  const rel = posixRel(cwd, absPath);
  if (rel !== null && !rel.startsWith("..")) return rel;
  return absPath;
}

function posixRel(fromDir: string, toFile: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(fromDir);
  const b = norm(toFile);
  if (!b.startsWith(a + "/")) return null;
  return b.slice(a.length + 1);
}
