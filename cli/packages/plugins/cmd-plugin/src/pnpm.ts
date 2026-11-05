/**
 * Forwarding an npm/git spec to pnpm (core §5 install step 2: "Resolve and
 * fetch with **pnpm, forwarded verbatim** into ~/.mola/plugins/ — the exact
 * model `dsh plugin` uses").
 *
 * The forwarding is *printed* by default and only executed when the user asks
 * for it (`--run`): mola must not start a package manager behind the user's
 * back, and the install-time permission gate only covers mola's own
 * processes. The command line is built exactly as `pnpm add` expects it:
 *
 *   pnpm --dir <~/.mola/plugins> add <spec> [--save-dev] [--save-exact]
 *
 * `pnpm --dir <dir>` is documented in pnpm's own help (`-C, --dir <DIR>`:
 * "Set working directory"), so the forward is verbatim.
 *
 * Windows note: an npm-installed pnpm is a `.cmd` shim; Node's spawn cannot
 * execute it directly. The forward therefore goes through `cmd /d /c` on
 * win32 — the same hop agent-dsh uses for npm-style CLIs.
 */

import * as path from "node:path";
import type { ExecService } from "@mola/plugin-sdk";
import { MolaError, ExitCode } from "@mola/plugin-sdk";

export interface PnpmForward {
  /** the argv mola would run */
  argv: string[];
  /** the printable command line */
  command: string;
}

/** True on a Windows host (MOLA_PLATFORM wins, like every other plugin). */
export function onWindows(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MOLA_PLATFORM ?? process.platform) === "win32";
}

/** The pnpm argv for one spec, targeting the install directory. */
export function pnpmArgv(opts: {
  installDir: string;
  spec: string;
  dev?: boolean;
  exact?: boolean;
  windows?: boolean;
}): string[] {
  const argv = ["pnpm", "--dir", opts.installDir, "add", opts.spec];
  if (opts.dev) argv.push("--save-dev");
  if (opts.exact) argv.push("--save-exact");
  if (opts.windows) return ["cmd", "/d", "/c", ...argv];
  return argv;
}

/** The command line as a human would type it (the printed forward). */
export function pnpmCommandLine(argv: string[]): string {
  return argv
    .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
    .join(" ");
}

/**
 * Run the forwarded pnpm command through the permission-checked exec service
 * (argv[0] must be in the plugin's process.exec allow-list).
 */
export async function runPnpm(exec: ExecService, argv: string[], cwd: string): Promise<number> {
  try {
    const res = await exec.exec(argv, { cwd, timeoutMs: 10 * 60_000 });
    if (res.code !== 0) {
      throw new MolaError(
        "UPSTREAM_UNAVAILABLE",
        `pnpm exited ${res.code}${res.stderr ? ` — ${res.stderr.trim().split(/\r?\n/)[0]}` : ""}`,
        ExitCode.Unavailable,
      );
    }
    return res.code;
  } catch (err) {
    if (err instanceof MolaError) throw err;
    throw new MolaError(
      "UPSTREAM_UNAVAILABLE",
      `pnpm failed: ${err instanceof Error ? err.message : String(err)}`,
      ExitCode.Unavailable,
    );
  }
}

/** The install directory pnpm writes into (core §5: ~/.mola/plugins). */
export function pnpmInstallDir(homeDir: string): string {
  return path.join(homeDir, "plugins");
}
