/**
 * magpie CLI wrapper (adapters-routing §3.4).
 *
 * magpie is a Windows desktop/gateway app. On the main machine it lives at
 * `C:\Users\<u>\AppData\Local\Programs\magpie\magpie.exe`. This wrapper:
 *
 *   - resolves the binary: `magpie` / `magpie.exe` on PATH, then the Windows
 *     install location (so WSL finds it through interop);
 *   - runs it with a timeout and returns {code, stdout, stderr};
 *   - separates magpie's log noise from real output. magpie prints plugin/log
 *     lines on stderr that start with a date (`2026/11/04 12:00:00 ...`);
 *     those are dropped, so only magpie's own error messages survive.
 *
 * Everything here is a thin shell: mola never edits an agent config, magpie
 * owns every agent's model list (BRIEF #3 / ADR-0003 §1).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult, ExecService } from "@mola/plugin-sdk";

/** A magpie log/noise line starts with a date like `2026/11/04 12:00:00`. */
const LOG_NOISE_RE = /^\d{4}\/\d{2}\/\d{2}\b/;

export interface MagpieInvocation {
  argv: string[];
  code: number;
  stdout: string;
  /** stderr minus magpie's dated log noise */
  stderr: string;
  /** stderr lines that were dropped as log noise (kept for diagnostics) */
  noise: string[];
  /** true when magpie could not be found or executed at all */
  unavailable?: string;
}

/** Drop magpie's dated log lines; keep everything else (real errors). */
export function stripLogNoise(stderr: string): { stderr: string; noise: string[] } {
  const noise: string[] = [];
  const kept: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (LOG_NOISE_RE.test(line)) {
      noise.push(line);
      continue;
    }
    kept.push(line);
  }
  return { stderr: kept.join("\n"), noise };
}

/** Candidate magpie executables, most specific first. */
export function magpieCandidates(): string[] {
  const out: string[] = [];
  if (process.platform === "win32") {
    out.push("magpie.exe", "magpie");
    const local = process.env.LOCALAPPDATA;
    if (local) out.push(path.join(local, "Programs", "magpie", "magpie.exe"));
    const home = os.homedir();
    out.push(path.join(home, "AppData", "Local", "Programs", "magpie", "magpie.exe"));
  } else {
    // WSL / Linux: `magpie` may be on PATH; otherwise the Windows binary is
    // reachable through WSL interop as magpie.exe.
    out.push("magpie", "magpie.exe");
    const winLocal = "/mnt/c/Users";
    try {
      for (const user of fs.readdirSync(winLocal)) {
        const p = `/mnt/c/Users/${user}/AppData/Local/Programs/magpie/magpie.exe`;
        if (fs.existsSync(p)) out.push(p);
      }
    } catch {
      // no /mnt/c (not WSL, or C: not mounted) — PATH candidates still apply
    }
  }
  return out;
}

/** Directories on PATH, for checking bare-name candidates. */
function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

function existsOnPath(name: string): boolean {
  for (const dir of pathDirs()) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true;
    } catch {
      // unreadable PATH entry — skip it
    }
  }
  return false;
}

/**
 * Which magpie executable to run. A bare name is only returned when it
 * actually resolves on PATH (in WSL `magpie` usually is NOT on PATH — the
 * Windows binary reached through interop is); otherwise the first existing
 * absolute candidate wins. Returns undefined when none is found — callers then
 * skip magpie with a clear message instead of failing hard.
 */
export function resolveMagpieBinary(exists: (p: string) => boolean = fs.existsSync): string | undefined {
  let firstBare: string | undefined;
  for (const candidate of magpieCandidates()) {
    if (!candidate.includes("/") && !candidate.includes("\\")) {
      firstBare ??= candidate;
      if (existsOnPath(candidate)) return candidate;
      continue;
    }
    if (exists(candidate)) return candidate;
  }
  return firstBare;
}

export interface MagpieRunner {
  /** Run `magpie <args…>`; never throws — failures come back as a result. */
  run(args: string[], opts?: { timeoutMs?: number }): Promise<MagpieInvocation>;
  /** true when a magpie binary could be located */
  available(): boolean;
  /** the resolved binary path/name, for diagnostics */
  binary(): string | undefined;
}

export interface RunnerOptions {
  exec: ExecService;
  binary?: string | undefined;
  timeoutMs?: number;
  /** test seam: pretend the binary is missing */
  unavailableReason?: string;
}

/**
 * Build a runner over the SDK's permission-checked exec handle.
 *
 * The manifest grants `process.exec: ["magpie", "magpie.exe"]`; the exec
 * service normalizes argv[0] (basename, .exe stripped) before matching, so
 * both spellings pass the allow-list.
 */
export function createMagpieRunner(opts: RunnerOptions): MagpieRunner {
  const binary = opts.binary ?? resolveMagpieBinary();
  return {
    available(): boolean {
      return !opts.unavailableReason && !!binary;
    },
    binary(): string | undefined {
      return binary;
    },
    async run(args: string[], runOpts?: { timeoutMs?: number }): Promise<MagpieInvocation> {
      if (opts.unavailableReason) {
        return {
          argv: ["magpie", ...args],
          code: 127,
          stdout: "",
          stderr: "",
          noise: [],
          unavailable: opts.unavailableReason,
        };
      }
      if (!binary) {
        return {
          argv: ["magpie", ...args],
          code: 127,
          stdout: "",
          stderr: "",
          noise: [],
          unavailable: "magpie was not found on PATH",
        };
      }
      let res: ExecResult;
      try {
        res = await opts.exec.exec([binary, ...args], {
          timeoutMs: runOpts?.timeoutMs ?? opts.timeoutMs ?? 30_000,
        });
      } catch (err) {
        return {
          argv: [binary, ...args],
          code: 127,
          stdout: "",
          stderr: "",
          noise: [],
          unavailable: err instanceof Error ? err.message : String(err),
        };
      }
      const { stderr, noise } = stripLogNoise(res.stderr);
      return { argv: [binary, ...args], code: res.code, stdout: res.stdout, stderr, noise };
    },
  };
}
