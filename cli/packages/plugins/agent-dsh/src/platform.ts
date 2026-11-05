/**
 * Platform facts for reaching DSH (adapters-routing §2.10): DSH lives in WSL.
 * On Windows mola reaches it through `wsl -e bash -lc …` (spawned directly from
 * Node — never through Git Bash, so no MSYS path rewriting can touch the argv;
 * MSYS_NO_PATHCONV=1 is still exported defensively). Inside Linux/WSL mola runs
 * dsh in a login shell after sourcing the stack env script (tasks/dispatch.sh
 * flow). The only flag surface is from cli/design/inputs/dsh-cli-help.md.
 */

export const DSH_ENV_SH = "~/src/mola-dsh-stack/scripts/env.sh";

export function onWindows(): boolean {
  return (process.env.MOLA_PLATFORM ?? process.platform) === "win32";
}

/**
 * The machine label reported for the DSH adapter: "wsl:<distro>" (DESIGN §5,
 * RouteDecision.machine). On Windows the main machine runs the Ubuntu distro;
 * inside WSL the distro name comes from WSL_DISTRO_NAME (set by WSL itself).
 */
export function dshMachine(env: NodeJS.ProcessEnv = process.env): string {
  if (onWindows()) return "wsl:Ubuntu";
  const distro = env.WSL_DISTRO_NAME;
  return distro ? `wsl:${distro}` : "local";
}

/**
 * Probe script for `command -v dsh && dsh --version`. Inside Linux/WSL the
 * stack env script is sourced first (it trims the Windows PATH entries so the
 * Linux dsh resolves; tasks/dispatch.sh does the same). Kept argument-free so
 * it is safe to interpolate into a single-quoted bash -lc string.
 */
export function dshProbeScript(): string {
  // the script always runs inside Linux/WSL (via `wsl -e bash -lc` on Windows), where env.sh puts dsh on PATH
  const source = `[ -f ${DSH_ENV_SH} ] && source ${DSH_ENV_SH}; `;
  return `${source}command -v dsh >/dev/null 2>&1 && dsh --version`;
}

/** Login-shell argv that runs `script` where DSH actually lives. */
export function dshExecArgv(script: string, windows = onWindows()): string[] {
  return windows ? ["wsl", "-e", "bash", "-lc", script] : ["bash", "-lc", script];
}
