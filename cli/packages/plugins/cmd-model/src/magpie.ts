/**
 * Minimal magpie CLI wrapper for cmd-model — a thin passthrough to
 * `magpie <agent> [route]` (adapters-routing §3.4). Mirrors tool-magpie's
 * wrapper (binary resolution + log-noise stripping); kept local because
 * plugins depend only on @mola/plugin-sdk and node_modules is already linked.
 *
 * Binary resolution: `magpie`/`magpie.exe` on PATH, else the Windows install
 * location — from WSL, magpie is reached as magpie.exe through interop.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult, ExecService } from "@mola/plugin-sdk";

/** magpie's dated log noise (`2026/11/04 12:00:00 …`) on stderr. */
const LOG_NOISE_RE = /^\d{4}\/\d{2}\/\d{2}\b/;

export interface MagpieInvocation {
  argv: string[];
  code: number;
  stdout: string;
  /** stderr minus the dated log noise */
  stderr: string;
  noise: string[];
  /** set when magpie could not be found/executed at all */
  unavailable?: string;
}

export function stripLogNoise(stderr: string): { stderr: string; noise: string[] } {
  const noise: string[] = [];
  const kept: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (LOG_NOISE_RE.test(line)) noise.push(line);
    else kept.push(line);
  }
  return { stderr: kept.join("\n"), noise };
}

/**
 * The magpie executable to run.
 *
 * On Windows: `magpie.exe`. On WSL/Linux the Windows binary is reached
 * through interop — it lives in `C:\Users\<u>\AppData\Local\Programs\magpie`,
 * i.e. `/mnt/c/Users/<u>/AppData/Local/Programs/magpie/magpie.exe` — so the
 * install path is searched when the bare name is not on PATH.
 */
export function resolveMagpieBinary(): string {
  if (process.platform === "win32") return "magpie.exe";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (existsOnPath(dir, "magpie")) return "magpie";
    if (existsOnPath(dir, "magpie.exe")) return "magpie.exe";
  }
  try {
    for (const user of fs.readdirSync("/mnt/c/Users")) {
      const p = `/mnt/c/Users/${user}/AppData/Local/Programs/magpie/magpie.exe`;
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // no /mnt/c — fall through
  }
  return "magpie";
}

function existsOnPath(dir: string, name: string): boolean {
  try {
    return fs.existsSync(path.join(dir, name));
  } catch {
    return false;
  }
}

export interface MagpieRunner {
  run(args: string[], opts?: { timeoutMs?: number }): Promise<MagpieInvocation>;
}

export function createMagpieRunner(opts: {
  exec: ExecService;
  timeoutMs?: number;
  /** test seam: force the binary path instead of resolving it */
  binary?: string;
}): MagpieRunner {
  const binary = opts.binary ?? resolveMagpieBinary();
  return {
    async run(args, runOpts): Promise<MagpieInvocation> {
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

// --------------------------------------------------------------- parsing
// (same stable-table parsers as tool-magpie; golden fixtures in the tests)

const DASHES = new Set(["—", "–", "-"]);
const MIDDLE_DOT = "·";

export interface MagpieAgentRow {
  name: string;
  /** magpie's id for this agent, e.g. "claude", "dsh@wsl:Ubuntu" */
  id: string;
  /** the model magpie currently pins, e.g. "magpie/group/smart-split" */
  model?: string;
  configPath?: string;
}

/** magpie's display name → id (the ids `magpie <agent>` accepts). */
const NAME_TO_ID: Record<string, string> = {
  "claude code": "claude",
  "claude desktop": "claude-desktop",
  codex: "codex",
  "antigravity cli": "agy",
  antigravity: "antigravity",
  opencode: "opencode",
  pi: "pi",
  omo: "omo",
  "vs code": "vscode",
  "deepseek harness": "dsh",
  omp: "omp",
  devin: "devin",
  "kimi code": "kimi",
  "qwen code": "qwen",
  "muse code": "muse",
  openclaw: "openclaw",
  cline: "cline",
  "grok build": "grok",
  zcode: "zcode",
  workbuddy: "workbuddy",
  codebuddy: "codebuddy",
  alma: "alma",
};

function agentIdFromName(name: string): string {
  const dot = name.indexOf(MIDDLE_DOT);
  const base = (dot < 0 ? name : name.slice(0, dot)).trim();
  const id = NAME_TO_ID[base.toLowerCase()] ?? base.toLowerCase().replace(/\s+/g, "-");
  if (dot < 0) return id;
  const raw = name.slice(dot + 1).trim();
  const wsl = /^wsl\s+(.+)$/i.exec(raw);
  return `${id}${wsl ? `@wsl:${wsl[1].trim()}` : `@${raw}`}`;
}

/** Parse `magpie ls` / `magpie <agent>` rows (name · model · fields · path). */
export function parseMagpieLs(stdout: string): MagpieAgentRow[] {
  const rows: MagpieAgentRow[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (!/^\s{2}\S/.test(raw)) continue; // table rows are indented two spaces
    const parts = raw.trim().split(/\s{2,}/);
    if (parts.length < 2) continue;
    const name = parts[0].trim();
    const configPath = parts[parts.length - 1].trim();
    const modelColumn = parts.slice(1, parts.length - 1).join("  ").trim();
    let head = (modelColumn.split(/\s{2,}/)[0] ?? "").split(MIDDLE_DOT)[0].trim();
    if (head) {
      // drop a trailing placeholder dash: "provider —" → "provider"
      const tokens = head.split(/\s+/);
      while (tokens.length > 1 && DASHES.has(tokens[tokens.length - 1])) tokens.pop();
      head = tokens.join(" ");
    }
    rows.push({
      name,
      id: agentIdFromName(name),
      model: !head || DASHES.has(head) ? undefined : head,
      configPath: DASHES.has(configPath) ? undefined : configPath,
    });
  }
  return rows;
}

/**
 * Route ids from `magpie models [<agent>]`: the group/ and auto/ rows (plus
 * provider rows like deepseek/*) — the route namespace cmd-model validates.
 */
export function parseMagpieRoutes(stdout: string): string[] {
  const routes: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^\s{2,}(group\/[A-Za-z0-9._-]+|auto\/[A-Za-z0-9._-]+|deepseek\/[A-Za-z0-9._\-[\]]+)\s/.exec(raw);
    if (m && !routes.includes(m[1])) routes.push(m[1]);
  }
  return routes;
}
