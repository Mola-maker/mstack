/**
 * agent-claude detection (adapters-routing §2.1, grounded in claude-help.txt):
 * `claude --version` probe only — the .cmd shim nuance is handled by
 * winSafeArgv (npm CLIs on Windows spawn through cmd.exe). magpie manages the
 * model (`~\.claude\settings.json`, magpie-agents.txt), so the adapter never
 * edits it: setModel() shells out to `magpie claude <route>`.
 */

import type { AgentDetection, ExecService } from "@mola/plugin-sdk";
import { winSafeArgv } from "./platform.js";

const PROBE_TIMEOUT_MS = 10_000;

export function machineOf(): string {
  return "local"; // claude runs where mola runs (Windows main / WSL)
}

/**
 * Probe `claude --version`; a crash text (any SyntaxError shape) means broken
 * and the router never routes to it (adapters-routing §2.9 pattern).
 */
export async function probeClaude(
  exec: ExecService,
  bin = "claude",
): Promise<AgentDetection> {
  let res;
  try {
    res = await exec.exec(winSafeArgv([bin, "--version"]), { timeoutMs: PROBE_TIMEOUT_MS });
  } catch (err) {
    return { available: false, health: "broken", detail: err instanceof Error ? err.message : String(err) };
  }
  const out = (res.stdout || "").trim();
  if (res.code === 0 && out && !/SyntaxError|Internal\s+error/i.test(`${out} ${res.stderr}`)) {
    return { available: true, version: out.split(/\r?\n/, 1)[0].trim(), health: "ok", managedByMagpie: true };
  }
  const lines = (res.stderr || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return {
    available: false,
    health: "broken",
    detail:
      lines.find((l) => /SyntaxError|error/i.test(l)) ?? lines[0] ?? out.split(/\r?\n/, 1)[0] ?? `exit ${res.code}`,
  };
}
