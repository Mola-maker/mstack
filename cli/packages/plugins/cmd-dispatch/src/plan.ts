/**
 * The dispatch plan (pure functions, unit-tested): the magpie model overlay,
 * the exact bash script that runs the tested headless flow, the argv used to
 * run it, and the NDJSON → final-answer parse. Flags are ONLY from
 * cli/design/inputs/dsh-cli-help.md + the tested invocation in
 * tasks/dispatch.sh / harness-commands.md:
 *
 *   dsh --profile mola-cli --patch <overlay> --json - < <task>
 */

import { DSH_ENV_SH, DSH_PROFILE, shellQuote } from "./platform.js";

export interface OverlayPatch {
  id: "agent-default-model";
  config: { provider: "magpie"; model: string };
}

/** The per-run model overlay: `- id: agent-default-model / config: {provider: magpie, model: <route>}` */
export function overlayYaml(route: string): string {
  return `- id: agent-default-model\n  config:\n    provider: magpie\n    model: ${route}\n`;
}

export interface ScriptPlan {
  /** absolute POSIX cwd inside WSL (e.g. /mnt/e/mstack) */
  cwdPosix: string;
  /** overlay reference relative to cwd, or an absolute WSL path */
  overlayPath: string;
  /** task-file reference relative to cwd / absolute WSL path; undefined = read stdin */
  taskPath?: string;
}

export function buildBashScript(plan: ScriptPlan): string {
  const parts = [
    `[ -f ${DSH_ENV_SH} ] && source ${DSH_ENV_SH}`,
    `cd ${shellQuote(plan.cwdPosix)}`,
    `dsh --profile ${DSH_PROFILE} --patch ${shellQuote(plan.overlayPath)} --json -${
      plan.taskPath ? ` < ${shellQuote(plan.taskPath)}` : ""
    }`,
  ];
  return parts.join("; ");
}

/**
 * argv for the exec handle. On Windows: `wsl -e bash -lc '<script>'` (spawned
 * directly — no Git Bash, no MSYS path rewriting). Inside Linux/WSL: bash -lc.
 */
export function dispatchArgv(script: string, windows: boolean): string[] {
  return windows ? ["wsl", "-u", process.env.MOLA_WSL_USER || "root", "-e", "bash", "-lc", script] : ["bash", "-lc", script];
}

export interface NdjsonResult {
  finalText: string;
  events: Array<Record<string, unknown>>;
}

/**
 * Parse `dsh --json` output: newline-delimited run events; the final answer is
 * the last event that carries a string result/text/message/answer/content
 * field. Plain (non-NDJSON) stdout falls through as the answer itself — the
 * headless profile prints only the final message (harness-commands.md).
 */
export function extractFinalText(stdout: string): NdjsonResult {
  const events: Array<Record<string, unknown>> = [];
  let finalText = "";
  let sawJson = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    sawJson = true;
    events.push(obj as Record<string, unknown>);
    const o = obj as Record<string, unknown>;
    for (const key of ["result", "text", "message", "answer", "content"]) {
      if (typeof o[key] === "string" && (o[key] as string).trim()) finalText = o[key] as string;
    }
  }
  if (!sawJson) finalText = stdout.trim();
  return { finalText, events };
}
