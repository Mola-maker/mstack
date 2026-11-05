/**
 * Verbatim argv reconstruction for the `mola rtk` passthrough.
 *
 * The router hands handlers a *parsed* view (`ParsedArgs`), which is lossy:
 * `parseArgv` turns `--porcelain` into a boolean flag and drops `--`
 * separators and empty strings. A passthrough must not reshape its arguments,
 * so cmd-rtk reads the raw token stream instead (see `rawTokens`).
 */

/**
 * The raw argv tokens that follow the command name, taken from `process.argv`.
 *
 * The mola bin only *reads* `process.argv` (it never rewrites it), so the
 * original token stream is still there when the handler runs. Global flags are
 * stripped by the bin wherever they appear, which is why the raw stream can
 * still contain rtk's own `-v`/`--help`; those must reach rtk unchanged.
 *
 * Returns null when the command name is not present verbatim (an alias was
 * used, or the CLI was invoked programmatically) — the caller then falls back
 * to the parsed view.
 */
export function rawTokens(commandName: string, argv: string[] = process.argv.slice(2)): string[] | null {
  const idx = argv.indexOf(commandName);
  if (idx < 0) return null;
  return argv.slice(idx + 1);
}

/**
 * Rebuild an argv array from the router's parsed view. Used only as a fallback
 * when the raw token stream is unavailable (alias invocation).
 *
 * Flag order is not preserved by the parser, so this is a best-effort
 * reconstruction — good enough for `rtk bypass <cmd>` style calls, never used
 * when the raw stream exists.
 */
export function reconstruct(
  parsed: { positionals: string[]; flags: Record<string, string | boolean> },
): string[] {
  const out: string[] = [...parsed.positionals];
  for (const [key, value] of Object.entries(parsed.flags)) {
    if (value === true) out.push(`--${key}`);
    else out.push(`--${key}`, String(value));
  }
  return out;
}
