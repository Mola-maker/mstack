/**
 * cmd-rtk (B1): `mola rtk <args...>` — a verbatim passthrough to the rtk
 * output compactor (adapters-routing §3.3, DESIGN §10 command tree).
 *
 * Contract (BATCHES.md B1 acceptance #6):
 *   - the argument vector reaches rtk unchanged (`bypass`, `rewrite`, `gain`,
 *     `pipe`, … — every rtk subcommand, no invented flags);
 *   - stdout/stderr/stdin are inherited, so rtk's bytes are the command's bytes
 *     (raw output when it matters: `mola rtk bypass git status --porcelain`);
 *   - rtk's exit code is mola's exit code.
 *
 * Why a direct spawn instead of `ctx.process.exec`: the exec service captures
 * stdout/stderr into strings and always pipes stdin, which would break both
 * the byte-for-byte stdio contract and rtk's interactive/stdin-driven verbs
 * (`rtk pipe`). The permission model is still honoured — the resolved binary
 * is checked against this plugin's granted `process.exec` allow-list before the
 * spawn, exactly the check core's exec service performs.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExitCode, PluginContext } from "@mola/plugin-sdk";
import { definePlugin, MolaError } from "@mola/plugin-sdk";
import { rawTokens, reconstruct } from "./argv.js";

// re-exported for consumers and the self-reference test import
export { rawTokens, reconstruct } from "./argv.js";

/** Where rtk lives on Windows when it is not on PATH (WinGet package dir). */
function wingetRtkPath(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== "win32") return null;
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return null;
  const packagesDir = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const found = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("rtk-ai.rtk"))
    .map((e) => path.join(packagesDir, e.name, "rtk.exe"))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  return found.length > 0 ? found[found.length - 1] : null;
}

/** PATH scan for `rtk` / `rtk.exe` — same rule core's exec service uses. */
function rtkOnPath(env: NodeJS.ProcessEnv): string | null {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  const dirs = raw.split(path.delimiter).filter((d) => d.length > 0);
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e.length > 0)
      : [""];
  for (const dir of dirs) {
    for (const ext of [...exts, ""]) {
      const candidate = path.join(dir, "rtk" + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/** Resolve the rtk binary: PATH first, then the WinGet package dir. */
export function resolveRtk(env: NodeJS.ProcessEnv = process.env): string | null {
  return rtkOnPath(env) ?? wingetRtkPath(env);
}

/** The allow-list check core's exec service performs, done locally. */
function isAllowed(ctx: PluginContext, exePath: string): boolean {
  const allow = ctx.permissions["process.exec"] ?? [];
  const name = path.basename(exePath).replace(/\.exe$/i, "").toLowerCase();
  return allow.includes("*") || allow.some((a) => path.basename(a).replace(/\.exe$/i, "").toLowerCase() === name);
}

/** Exit code for a child that died from a signal (128 + signo, shell convention). */
function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const signo = os.constants.signals[signal];
  return 128 + (signo ?? 0);
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["rtk"],
      description: "verbatim passthrough to rtk (bypass|rewrite|pipe|gain …)",
      async handler(args, io) {
        // 1. resolve the binary
        const exe = resolveRtk();
        if (!exe) {
          throw new MolaError(
            "UPSTREAM_UNAVAILABLE",
            "rtk not found on PATH or in %LOCALAPPDATA%\\Microsoft\\WinGet\\Packages — " +
              "install it (Windows: `winget install rtk-ai.rtk`) or use rtk directly",
            69,
          );
        }
        // 2. honour the manifest's process.exec allow-list
        if (!isAllowed(ctx, exe)) {
          throw new MolaError(
            "PERMISSION_DENIED",
            `cmd-rtk is not allowed to execute "${path.basename(exe)}"`,
            77,
          );
        }
        // 3. verbatim argv: raw token stream when available, parsed view otherwise
        const argv = rawTokens("rtk") ?? reconstruct(args);
        if (argv.length === 0) {
          throw new MolaError(
            "USAGE_ERROR",
            "usage: mola rtk <args...>  (e.g. mola rtk bypass git status --porcelain)",
            64,
          );
        }

        // 4. spawn with inherited stdio — rtk owns the bytes on the terminal
        const code = await new Promise<number>((resolvePromise, rejectPromise) => {
          const child = spawn(exe, argv, {
            cwd: io.cwd,
            env: process.env,
            stdio: "inherit",
            shell: false,
          });
          child.on("error", (err) => {
            // spawn failed (ENOENT/EACCES) — upstream unavailable
            rejectPromise(
              new MolaError(
                "UPSTREAM_UNAVAILABLE",
                `failed to start rtk (${exe}): ${err instanceof Error ? err.message : String(err)}`,
                69,
              ),
            );
          });
          child.on("close", (exitCode, signal) => {
            resolvePromise(exitCode === null ? signalExitCode(signal) : exitCode);
          });
        });

        // 5. report on stderr only — stdout stays byte-identical to rtk's output
        if (io.json) {
          io.out(
            JSON.stringify({
              schemaVersion: 1,
              command: "rtk",
              traceId: io.traceId,
              data: { argv, exitCode: code },
            }),
          );
        } else if (code !== 0) {
          io.note(`mola: rtk exited with code ${code}`);
        }
        return code as ExitCode;
      },
    });
  },
});
