/**
 * DSH detection + health (adapters-routing §2.10): probe the WSL dsh binary,
 * report version, machine and health. `detect()` uses ONLY the probe shape
 * from tasks/dispatch.sh / harness-commands.md — no invented flags.
 */

import type { AgentDetection, ExecService } from "@mola/plugin-sdk";
import { ExitCode, MolaError } from "@mola/plugin-sdk";
import { dshExecArgv, dshMachine, dshProbeScript, onWindows } from "./platform.js";

const PROBE_TIMEOUT_MS = 15_000;

export interface DshDetect extends AgentDetection {
  /** "wsl:Ubuntu" style label (see dshMachine) */
  machine: string;
  profile: string;
}

/**
 * Probe dsh where it lives: `wsl -e bash -lc 'command -v dsh && dsh --version'`
 * on Windows; a login shell that sources the stack env script inside Linux/WSL.
 */
export async function probeDsh(exec: ExecService): Promise<DshDetect> {
  const machine = dshMachine();
  let res;
  try {
    res = await exec.exec(dshExecArgv(dshProbeScript()), { timeoutMs: PROBE_TIMEOUT_MS });
  } catch (err) {
    return {
      available: false,
      machine,
      profile: "mola-cli",
      health: "broken",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const version = res.stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (res.code === 0 && version) {
    return { available: true, version, machine, profile: "mola-cli", health: "ok" };
  }
  const detail = (res.stderr || res.stdout || "dsh not found in WSL").trim().split(/\r?\n/, 1)[0];
  return { available: false, machine, profile: "mola-cli", health: "broken", detail };
}

/** Best-effort `--version` probe of one agent bin; a crash means broken (§2.9). */
export async function probeBinHealth(
  exec: ExecService,
  bin: string,
  timeoutMs = 10_000,
): Promise<{ health: "ok" | "broken"; version?: string; detail?: string }> {
  try {
    const res = await exec.exec(winSafeArgv([bin, "--version"]), { timeoutMs });
    const out = (res.stdout || "").trim();
    if (res.code === 0 && out && !/SyntaxError|Internal\s+error/i.test(out + " " + res.stderr)) {
      return { health: "ok", version: out.split(/\r?\n/, 1)[0].trim() };
    }
    const lines = (res.stderr || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const detail =
      lines.find((l) => /SyntaxError|error/i.test(l)) ?? lines[0] ?? out.split(/\r?\n/, 1)[0] ?? `exit ${res.code}`;
    return { health: "broken", detail };
  } catch (err) {
    return { health: "broken", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Windows nuance: npm-style agents install as `.cmd` shims, which Node's
 * `spawn` without a shell cannot execute. On win32 route CLI probes through
 * `cmd /d /c` (a real .exe). wsl.exe needs no such hop. On Linux spawn directly.
 */
export function winSafeArgv(argv: string[], windows = onWindows()): string[] {
  return windows ? ["cmd", "/d", "/c", ...argv] : [...argv];
}

export function agentNotFound(id: string): MolaError {
  return new MolaError(
    "AGENT_NOT_FOUND",
    `no agent adapter or magpie-managed agent named "${id}"`,
    ExitCode.NoInput,
  );
}
