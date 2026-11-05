/**
 * agent-codex detection (adapters-routing §2.2, grounded in codex-help.txt).
 * The captured help documents the top level (`codex exec`, `codex resume`,
 * `codex agents`, `--sandbox`, `-a`, `-m`, `-C`, `--add-dir`, `--worktree`)
 * but NOT the `codex exec` subcommand flags — honesty list #3 says probe
 * `codex exec --help` at detect time and use only what it confirms. So:
 *   - `codex --version` → version/health;
 *   - `codex exec --help` → the confirmed exec flag surface (below).
 */

import type { ExecService } from "@mola/plugin-sdk";
import { winSafeArgv } from "./platform.js";

const PROBE_TIMEOUT_MS = 10_000;

export function machineOf(): string {
  return "local";
}

/** The `codex exec` surface a detect-time probe can confirm. */
export interface CodexExecSurface {
  /** `--json` (experimental JSONL output) */
  json: boolean;
  /** `--sandbox <read-only|workspace-write|danger-full-access>` */
  sandbox: boolean;
  /** `-m/--model` */
  model: boolean;
  /** `-a/--ask-for-approval` (headless runs want `never`) */
  approval: boolean;
  /** `--add-dir` */
  addDir: boolean;
  /** `--worktree` */
  worktree: boolean;
  /** `--output-last-message <file>` (deterministic final answer) */
  outputLastMessage: boolean;
  /** `exec resume` / `--last` — headless resume (not in the captured help) */
  resume: boolean;
  resumeLast: boolean;
  raw: string;
}

export const NO_EXEC_SURFACE: CodexExecSurface = {
  json: false,
  sandbox: false,
  model: false,
  approval: false,
  addDir: false,
  worktree: false,
  outputLastMessage: false,
  resume: false,
  resumeLast: false,
  raw: "",
};

export function parseExecSurface(helpText: string): CodexExecSurface {
  const h = helpText ?? "";
  return {
    json: /(^|\s)--json\b/.test(h),
    sandbox: /--sandbox/.test(h),
    model: /(^|\s)-m,?\s|--model/.test(h),
    approval: /--ask-for-approval/.test(h),
    addDir: /--add-dir/.test(h),
    worktree: /--worktree/.test(h),
    outputLastMessage: /--output-last-message/.test(h),
    resume: /^\s{2,}resume\b/m.test(h),
    resumeLast: /--last/.test(h),
    raw: h,
  };
}

export async function probeCodexExec(exec: ExecService, bin = "codex"): Promise<CodexExecSurface> {
  try {
    const res = await exec.exec(winSafeArgv([bin, "exec", "--help"]), { timeoutMs: PROBE_TIMEOUT_MS });
    if (res.code !== 0) return { ...NO_EXEC_SURFACE, raw: res.stderr || `exit ${res.code}` };
    return parseExecSurface(res.stdout);
  } catch {
    return NO_EXEC_SURFACE;
  }
}

export interface CodexDetect {
  available: boolean;
  version?: string;
  health: "ok" | "broken" | "unknown";
  detail?: string;
  managedByMagpie?: boolean;
  exec: CodexExecSurface;
}

/** Probe `codex --version` + the exec surface (honesty list #3). */
export async function probeCodex(exec: ExecService, bin = "codex"): Promise<CodexDetect> {
  let res;
  try {
    res = await exec.exec(winSafeArgv([bin, "--version"]), { timeoutMs: PROBE_TIMEOUT_MS });
  } catch (err) {
    return { available: false, health: "broken", detail: err instanceof Error ? err.message : String(err), exec: NO_EXEC_SURFACE };
  }
  const out = (res.stdout || "").trim();
  if (res.code === 0 && out && !/SyntaxError|Internal\s+error/i.test(`${out} ${res.stderr}`)) {
    return {
      available: true,
      version: out.split(/\r?\n/, 1)[0].trim(),
      health: "ok",
      managedByMagpie: true, // magpie ls manages Codex (~\.codex\config.toml, kimi-code-cn/k3)
      exec: await probeCodexExec(exec, bin),
    };
  }
  const lines = (res.stderr || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return {
    available: false,
    health: "broken",
    detail: lines.find((l) => /SyntaxError|error/i.test(l)) ?? lines[0] ?? out.split(/\r?\n/, 1)[0] ?? `exit ${res.code}`,
    exec: NO_EXEC_SURFACE,
  };
}
