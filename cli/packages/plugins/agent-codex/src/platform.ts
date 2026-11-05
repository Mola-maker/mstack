/**
 * agent-codex platform facts — the same npm-`.cmd`-shim pattern as agent-claude
 * (spawn through `cmd /d /c` on Windows). MOLA_PLATFORM forces either side.
 */

export function onWindows(): boolean {
  return (process.env.MOLA_PLATFORM ?? process.platform) === "win32";
}

export function winSafeArgv(argv: string[], windows = onWindows()): string[] {
  return windows ? ["cmd", "/d", "/c", ...argv] : [...argv];
}
