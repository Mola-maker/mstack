/**
 * Agent discovery (B1 acceptance #3): `mola agents list|show <id>`.
 *
 * Two sources are merged:
 *   1. PATH probes for the agent CLIs captured in cli/design/inputs/:
 *      claude, codex, kimi, grok, agy, devin, pi, opencode, omp — plus dsh,
 *      which lives inside WSL (adapters-routing §2.10) and is probed through a
 *      login shell. Only stable flags (`--version`) — no invented flags.
 *   2. `magpie ls` — the agents magpie knows about (its id set is bigger:
 *      Antigravity CLI, VS Code, Qwen Code, Alma, …).
 *
 * `omp` is known-broken on this machine (a Bun SyntaxError in its own dist —
 * adapters-routing §2.9): the probe reports health "broken" and the router
 * never routes to it.
 */

import type { AgentDetection, ExecService } from "@mola/plugin-sdk";
import type { MagpieAgentRow } from "./parse.js";
import { machineOf } from "./parse.js";

/** The agent CLIs this machine has, with the CLI that runs them. */
export interface AgentProbeSpec {
  /** the id mola uses (matches the CLI name unless stated) */
  id: string;
  /** the executable to probe on PATH */
  bin: string;
  /** the CLI's product name (magpie's display name differs for some) */
  displayName: string;
  /** extra PATH names to try (`.exe` spellings reach Windows via interop) */
  altBins?: string[];
  /**
   * dsh lives inside WSL (adapters-routing §2.10): probe it through a login
   * shell — directly when mola already runs in WSL, via `wsl -e bash -lc`
   * when mola runs on Windows.
   */
  wsl?: boolean;
  /** the machine the agent runs on, when it is not mola's own */
  machine?: string;
  /**
   * true for agents mola cannot work without (dsh): a failing probe is a
   * doctor failure. Optional CLIs only report, they never fail the doctor.
   */
  required?: boolean;
}

export const AGENT_PROBES: AgentProbeSpec[] = [
  { id: "claude", bin: "claude", displayName: "Claude Code", altBins: ["claude.exe"] },
  { id: "codex", bin: "codex", displayName: "Codex", altBins: ["codex.exe"] },
  { id: "kimi", bin: "kimi", displayName: "Kimi Code", altBins: ["kimi.exe"] },
  { id: "grok", bin: "grok", displayName: "Grok Build", altBins: ["grok.exe"] },
  { id: "agy", bin: "agy", displayName: "Antigravity CLI", altBins: ["agy.exe"] },
  { id: "devin", bin: "devin", displayName: "Devin", altBins: ["devin.exe"] },
  { id: "pi", bin: "pi", displayName: "Pi", altBins: ["pi.exe"] },
  { id: "opencode", bin: "opencode", displayName: "OpenCode", altBins: ["opencode.exe"] },
  // omp is known-broken on this machine (Bun SyntaxError, §2.9): the probe
  // reports health "broken" and the router never routes to it.
  { id: "omp", bin: "omp", displayName: "omp", altBins: ["omp.exe"] },
  { id: "dsh", bin: "dsh", displayName: "DeepSeek Harness", machine: "wsl:Ubuntu", wsl: true, required: true },
];

/** One discovered agent — PATH probe and magpie merged. */
export interface AgentRecord extends AgentDetection {
  id: string;
  /** the CLI binary that was probed, when one was found */
  bin?: string;
  /** magpie's display name */
  displayName?: string;
  /** the model route magpie currently pins for this agent */
  model?: string;
  /** magpie's settings/config file for this agent */
  configPath?: string;
  /** where the record came from: PATH probe, magpie, or both */
  source: "path" | "magpie" | "both";
  /** the machine the agent lives on ("local", "wsl:Ubuntu", …) */
  machine: string;
  /** magpie's own id (may differ from mola's id for suffixed agents) */
  magpieId?: string;
}

/** The probe command for one bin: plain argv, or the WSL login-shell wrapper. */
export function probeArgv(spec: AgentProbeSpec, bin: string): string[] {
  if (!spec.wsl) {
    // npm-installed CLIs are `.cmd` shims on Windows, which cannot be spawned without cmd.exe
    return bin.toLowerCase().endsWith(".cmd") ? ["cmd", "/d", "/s", "/c", bin, "--version"] : [bin, "--version"];
  }
  // inside WSL, ~/src/mola-dsh-stack/scripts/env.sh is what puts dsh (npm-global) on PATH
  const inner = `[ -f ~/src/mola-dsh-stack/scripts/env.sh ] && source ~/src/mola-dsh-stack/scripts/env.sh; command -v ${bin} >/dev/null 2>&1 && ${bin} --version`;
  return process.platform === "win32"
    ? ["wsl", "-u", process.env.MOLA_WSL_USER || "root", "-e", "bash", "-lc", inner]
    : ["bash", "-lc", inner];
}

/**
 * Probe one agent CLI with `<bin> --version` (10 s timeout, per §2.9).
 * A non-zero exit whose output looks like a crash (omp's Bun SyntaxError)
 * reports health "broken"; a binary that is simply absent stays "unknown".
 */
export async function probeAgent(
  spec: AgentProbeSpec,
  exec: ExecService,
  timeoutMs = 10_000,
): Promise<AgentDetection & { bin?: string }> {
  const bins = [spec.bin, ...(spec.altBins ?? [])];
  if (process.platform === "win32" && !spec.wsl) bins.push(`${spec.bin}.cmd`);
  let lastDetail: string | undefined;
  for (const bin of bins) {
    let res;
    try {
      res = await exec.exec(probeArgv(spec, bin), { timeoutMs });
    } catch (err) {
      // denied by the permission allow-list, timed out, or spawn failed
      lastDetail ??= err instanceof Error ? err.message : String(err); // report the primary binary, not a fallback
      continue;
    }
    if (res.code === 0) {
      const version = (res.stdout || res.stderr).trim().split(/\r?\n/)[0]?.trim();
      return { available: true, version, health: "ok", bin: spec.bin };
    }
    const errText = (res.stderr || res.stdout).trim();
    lastDetail ??= errText ? errText.split(/\r?\n/)[0] : `exit ${res.code}`;
    // a crash on --version means the binary is broken (omp's Bun SyntaxError)
    if (/SyntaxError|Error:|error:|crash/i.test(errText)) {
      return { available: false, health: "broken", detail: errText.split(/\r?\n/)[0], bin: spec.bin };
    }
  }
  return { available: false, health: "unknown", detail: lastDetail ?? `${spec.bin} not found on PATH` };
}

/**
 * Merge PATH probes and `magpie ls` rows into one list of agents.
 *
 * A magpie row merges into a probed record when their machines agree — dsh
 * exists both as the Windows web profile ("DeepSeek Harness") and as the WSL
 * dispatch profile ("DeepSeek Harness · WSL Ubuntu", the one mola dispatches),
 * and each keeps its own record. A row that collides with a probe of a
 * different machine is kept under a machine-qualified key so nothing is lost.
 */
export function mergeAgents(
  probes: Array<{ spec: AgentProbeSpec; detection: AgentDetection & { bin?: string } }>,
  magpieRows: MagpieAgentRow[],
): AgentRecord[] {
  const records = new Map<string, AgentRecord>();

  for (const { spec, detection } of probes) {
    records.set(spec.id, {
      id: spec.id,
      available: detection.available,
      version: detection.version,
      health: detection.health ?? "unknown",
      detail: detection.detail,
      bin: detection.bin,
      displayName: spec.displayName,
      source: "path",
      machine: spec.machine ?? "local",
    });
  }

  for (const row of magpieRows) {
    const rowMachine = machineOf(row.id);
    const base = row.id.split("@")[0];

    // find a probe record this row belongs to (same agent, same machine)
    let targetKey: string | undefined;
    for (const record of records.values()) {
      const sameAgent = record.id === row.id || record.id.split("@")[0] === base;
      if (sameAgent && record.machine === rowMachine) {
        targetKey = record.id;
        break;
      }
    }

    if (targetKey) {
      const existing = records.get(targetKey)!;
      records.set(targetKey, {
        ...existing,
        managedByMagpie: true,
        model: row.model ?? existing.model,
        configPath: row.configPath ?? existing.configPath,
        displayName: existing.displayName ?? row.name,
        magpieId: existing.magpieId ?? row.id,
        source: "both",
        // magpie knowing the agent does not make a broken binary healthy
        health: existing.health === "broken" ? "broken" : existing.health ?? "unknown",
      });
      continue;
    }

    // magpie-only agent — or the other machine's profile of a probed agent
    let key = row.id;
    if (records.has(key)) key = `${row.id}@${rowMachine}`;
    records.set(key, {
      id: key,
      available: true,
      managedByMagpie: true,
      model: row.model,
      health: "unknown",
      configPath: row.configPath,
      displayName: row.name,
      source: "magpie",
      machine: rowMachine,
      magpieId: row.id,
    });
  }

  return [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
}
