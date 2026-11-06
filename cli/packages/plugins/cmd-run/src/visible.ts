/**
 * The agent's visible route set (ADR-0003 §3 — "routeFit": the route must be
 * in the agent's visible set; adapters-routing §3.4: "the router must not
 * emit a route outside an agent's visible set").
 *
 * The source is `magpie models <agent>` (magpie-help.txt line 46). magpie has
 * no `--json` for it, so the stable table output is parsed — the same
 * approach tool-magpie takes, with the same rules:
 *
 *   "  Routing groups"     → group/<id> rows
 *   "  DeepSeek"           → deepseek/<model> rows
 *   "  dsh is shown …"     → the agent's visible set (a lossy display form)
 *
 * The display form is lossy: `group/smart-split` is shown as the bare group
 * id ("smart-split"), `auto/kimi-k3` keeps its family prefix ("auto-kimi-k3"),
 * and dots become dashes ("auto-minimax-m3-1-flash" is
 * `auto/minimax-m3.1-flash`). The tokens are therefore matched against the
 * authoritative route ids, keyed both whole and without the family prefix.
 *
 * magpie is optional: when it cannot be reached the visible set is unknown,
 * the route fit stays neutral and the router says so — it never guesses.
 */

import type { ExecService } from "@mola/plugin-sdk";

/** The route ids `magpie models [<agent>]` knows. */
export function parseMagpieRoutes(stdout: string): string[] {
  const routes: string[] = [];
  for (const raw of (stdout ?? "").split(/\r?\n/)) {
    const m = /^\s{2,}(group\/[A-Za-z0-9._-]+|auto\/[A-Za-z0-9._-]+|deepseek\/[A-Za-z0-9._\-[\]]+)\s/.exec(raw);
    if (!m) continue;
    if (!routes.includes(m[1])) routes.push(m[1]);
  }
  return routes;
}

/** The raw visible tokens of the "… is shown …" summary line. */
export function visibleRouteNames(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of (stdout ?? "").split(/\r?\n/)) {
    const m = /^\s{2,}(\S+) is shown (.+)$/.exec(raw);
    if (!m) continue;
    for (const token of m[2].split(",")) {
      const t = token.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Match the visible tokens against the real route ids. */
export function matchVisibleRoutes(names: string[], routeIds: string[]): string[] {
  const normalize = (s: string): string => s.replace(/[./]/g, "-").toLowerCase();
  const byNorm = new Map<string, string>();
  for (const route of routeIds) {
    const norm = normalize(route);
    byNorm.set(norm, route);
    const stripped = norm.replace(/^(group|auto)-/, "");
    if (!byNorm.has(stripped)) byNorm.set(stripped, route);
  }
  const out: string[] = [];
  for (const name of names) {
    const hit = byNorm.get(normalize(name));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** The magpie executable (same resolution as cmd-model / tool-magpie). */
export function resolveMagpieBinary(): string {
  return process.platform === "win32" ? "magpie.exe" : "magpie";
}

export interface VisibleProbe {
  /** the agent's visible route ids (empty when magpie could not be read) */
  routes: string[];
  /** why the set is unknown (magpie unreachable / failed) */
  unavailable?: string;
}

/**
 * Read the visible route set of one agent. Never throws: an unknown set is
 * reported as `unavailable` and the router stays neutral about the route fit.
 */
export async function probeVisibleRoutes(
  exec: ExecService,
  agentId: string,
  opts: { timeoutMs?: number; binary?: string } = {},
): Promise<VisibleProbe> {
  const binary = opts.binary ?? resolveMagpieBinary();
  try {
    const res = await exec.exec([binary, "models", agentId], {
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
    if (res.code !== 0) {
      return {
        routes: [],
        unavailable: res.stderr.trim() || `magpie models ${agentId} exited ${res.code}`,
      };
    }
    const routes = parseMagpieRoutes(res.stdout);
    // "<agent> is shown every provider's models …" → every route magpie knows is visible
    if (/ is shown every provider/.test(res.stdout)) return { routes };
    // no "… is shown …" line: magpie does not route this agent's models (e.g. Claude
    // Code on an official login) → no magpie route is visible to it
    return { routes: matchVisibleRoutes(visibleRouteNames(res.stdout), routes) };
  } catch (err) {
    return { routes: [], unavailable: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Probe the visible route set of every candidate agent. The probe is skipped
 * for an agent whose id magpie does not know (magpie's own ids are the
 * display names — "dsh" is the DeepSeek Harness).
 */
export async function probeVisibleRoutesFor(
  exec: ExecService,
  agentIds: string[],
  opts: { timeoutMs?: number; binary?: string } = {},
): Promise<{ map: Map<string, string[]>; unavailable: Map<string, string> }> {
  const map = new Map<string, string[]>();
  const unavailable = new Map<string, string>();
  for (const id of agentIds) {
    const probe = await probeVisibleRoutes(exec, id, opts);
    if (probe.unavailable) unavailable.set(id, probe.unavailable);
    else map.set(id, probe.routes);
  }
  return { map, unavailable };
}
