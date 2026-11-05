/**
 * agent-claude platform facts. On Windows npm CLIs are `.cmd` shims, which
 * Node's `spawn` without a shell cannot execute — route probes through
 * `cmd /d /c` (the agent-dsh B1 pattern). Platform checks go through
 * MOLA_PLATFORM ?? process.platform so tests can force either side.
 */

export function onWindows(): boolean {
  return (process.env.MOLA_PLATFORM ?? process.platform) === "win32";
}

export function winSafeArgv(argv: string[], windows = onWindows()): string[] {
  return windows ? ["cmd", "/d", "/c", ...argv] : [...argv];
}
