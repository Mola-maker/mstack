/**
 * The routing engine (ADR-0003 §3 — filter then score).
 *
 * Candidates come from the registered `HeadlessAgentAdapter`s (the B2 run
 * surface in @mola/plugin-sdk). Filtering:
 *
 *   - the adapter must be runnable (`isRunnableAgent`) and detected healthy
 *     (a broken binary never receives work — adapters-routing §2.9);
 *   - the required capabilities must be present;
 *   - the machine must be reachable (the adapter's own machine; B2 has no
 *     remote environments — those arrive in B3);
 *   - a pinned agent (`--agent`) / machine (`--on`) narrows the set.
 *
 * Scoring (the ADR's formula, weighted and documented):
 *
 *   score = w.kind * kindAffinity
 *         + w.cost  * cheapness
 *         + w.model * routeFit
 *         + w.machine * machineRank
 *         - w.fail  * recentFailures
 *
 * The route itself is picked from the policy (task-kind row first, then the
 * default row, then the whitelist-checked default) and must survive the
 * whitelist check (group/* or auto/* — never `deepseek/*`).
 */

import type { AgentCapabilities, HeadlessAgentAdapter } from "@mola/plugin-sdk";
import { isRunnableAgent } from "@mola/plugin-sdk";
import type { Policy, TaskKind } from "./policy.js";

export interface RouteWeights {
  kind: number;
  cost: number;
  model: number;
  machine: number;
  fail: number;
}

export const DEFAULT_WEIGHTS: RouteWeights = {
  kind: 3,
  cost: 1,
  model: 2,
  machine: 1,
  fail: 2,
};

export interface RouteRequest {
  taskKind: TaskKind;
  prompt: string;
  /** the user pinned the agent (`--agent <id>`) */
  prefersAgent?: string;
  /** the user pinned the machine (`--on <machine>`) */
  prefersMachine?: string;
  budgetUsd?: number;
  requiresCapability?: Partial<AgentCapabilities>;
  approval: "interactive" | "batch-approved";
}

export interface RouteCandidate {
  adapter: HeadlessAgentAdapter;
  id: string;
  machine: string;
  /** the adapter is healthy enough to receive work */
  available: boolean;
  health: "ok" | "degraded" | "broken" | "unknown";
  /** how many recent failures this agent had (decayed failure memory) */
  recentFailures: number;
}

export interface ScoredCandidate extends RouteCandidate {
  score: number;
  breakdown: {
    kind: number;
    cost: number;
    model: number;
    machine: number;
    fail: number;
  };
}

export interface RouteDecision {
  agent: string;
  machine: string;
  workspaceDir: string;
  modelRoute: string;
  fallbacks: Array<{ agent: string; modelRoute: string }>;
  reason: string;
  /** the full ranking, for `mola run --json` */
  ranked: Array<{ agent: string; machine: string; score: number; reason: string }>;
}

/**
 * Task-kind affinity: how well an agent fits a task kind, independent of the
 * policy's own agent list. Grounded in adapters-routing §5 (the mola
 * command → adapter map) and the machine rules: dsh is the fleet worker,
 * claude/codex are the strong single-shot agents.
 */
export const KIND_AFFINITY: Record<TaskKind, Record<string, number>> = {
  implement: { dsh: 1.0, claude: 0.9, codex: 0.85 },
  review: { codex: 1.0, claude: 0.9, dsh: 0.5 },
  research: { dsh: 0.9, claude: 0.9, codex: 0.85 },
  debug: { claude: 1.0, dsh: 0.85, codex: 0.8 },
  plan: { claude: 1.0, codex: 0.85, dsh: 0.6 },
  qa: { codex: 0.95, dsh: 0.9, claude: 0.85 },
  ship: { claude: 1.0, codex: 0.9, dsh: 0.6 },
  chat: { claude: 0.95, codex: 0.9, dsh: 0.8 },
};

/** The policy's own agent list overrides the built-in affinity (it is the user's call). */
export function kindAffinity(taskKind: TaskKind, agentId: string, policy: Policy): number {
  const row = policy.routes.byTaskKind[taskKind];
  const preferred = row?.agents ?? policy.routes.default?.agents;
  if (preferred && preferred.length) {
    const idx = preferred.indexOf(agentId);
    if (idx >= 0) return 1 - idx / (preferred.length + 1);
    // an agent the policy does not list is still a candidate, but ranked lower
    const base = KIND_AFFINITY[taskKind]?.[agentId] ?? 0.3;
    return base * 0.5;
  }
  return KIND_AFFINITY[taskKind]?.[agentId] ?? 0.5;
}

/** Machine rank: lower is better; machines outside the preference list rank last. */
export function machineRank(machine: string, policy: Policy): number {
  const pref = policy.machinePreference;
  if (pref.length === 0) return 0.5;
  const idx = pref.indexOf(machine);
  if (idx >= 0) return 1 - idx / pref.length;
  return 0.1;
}

/** Cost fit: a route the agent can actually use and a cheap task kind score high. */
export function costFit(budgetUsd: number | undefined): number {
  if (budgetUsd === undefined) return 0.5;
  // no cost model per agent is available offline; the budget only scales the
  // weight of the fit, it never invents a price
  return Math.max(0, Math.min(1, budgetUsd / 2));
}

/**
 * Route fit: the route must be visible to the agent (magpie's visible set).
 *
 * `undefined` means the visible set is UNKNOWN (magpie could not be read) —
 * the fit stays neutral. An empty array means the agent is known to see no
 * route: the fit is poor, because the route cannot be picked.
 */
export function routeFit(visibleRoutes: string[] | undefined, route: string): number {
  if (visibleRoutes === undefined) return 0.5; // unknown → neutral
  return visibleRoutes.includes(route) ? 1 : 0.1;
}

/** The candidate set: the registered runnable adapters, with their detection. */
export async function collectCandidates(
  adapters: HeadlessAgentAdapter[],
  opts: { detect?: boolean } = {},
): Promise<RouteCandidate[]> {
  const out: RouteCandidate[] = [];
  for (const adapter of adapters) {
    let health: RouteCandidate["health"] = "unknown";
    let available = true;
    if (opts.detect !== false) {
      try {
        const d = await adapter.detect();
        available = d.available !== false;
        health = d.health === "broken" ? "broken" : d.available ? "ok" : "unknown";
      } catch {
        available = false;
        health = "unknown";
      }
    }
    out.push({
      adapter,
      id: adapter.id,
      machine: machineOfAdapter(adapter),
      available,
      health,
      recentFailures: 0,
    });
  }
  return out;
}

/**
 * The machine label of an adapter. Adapters do not expose it in the SDK, so it
 * is derived from the id the same way the adapters themselves report it
 * (claude/codex → "local", dsh → "wsl:<distro>" on Windows, "local" inside
 * Linux/WSL). A mismatch is not fatal: `--on` pins by prefix match.
 */
export function machineOfAdapter(adapter: HeadlessAgentAdapter): string {
  if (adapter.id === "dsh") {
    const windows = (process.env.MOLA_PLATFORM ?? process.platform) === "win32";
    if (windows) return "wsl:Ubuntu";
    const distro = process.env.WSL_DISTRO_NAME;
    return distro ? `wsl:${distro}` : "local";
  }
  return "local";
}

/** Does the candidate satisfy the requested capabilities? */
export function hasCapabilities(
  caps: AgentCapabilities,
  required: Partial<AgentCapabilities> | undefined,
): boolean {
  if (!required) return true;
  for (const [key, want] of Object.entries(required)) {
    if (want === undefined) continue;
    const have = (caps as unknown as Record<string, unknown>)[key];
    if (have !== want) return false;
  }
  return true;
}

/** The filter step (ADR-0003 §3): health, capability, machine, pinned agent. */
export function filterCandidates(
  candidates: RouteCandidate[],
  req: RouteRequest,
): { kept: RouteCandidate[]; rejected: Array<{ id: string; why: string }> } {
  const kept: RouteCandidate[] = [];
  const rejected: Array<{ id: string; why: string }> = [];
  for (const c of candidates) {
    if (c.health === "broken") {
      rejected.push({ id: c.id, why: "broken binary" });
      continue;
    }
    if (!c.available) {
      rejected.push({ id: c.id, why: "not detected" });
      continue;
    }
    if (!hasCapabilities(c.adapter.capabilities, req.requiresCapability)) {
      rejected.push({ id: c.id, why: "missing capability" });
      continue;
    }
    if (req.prefersAgent && c.id !== req.prefersAgent) {
      rejected.push({ id: c.id, why: `agent pinned to ${req.prefersAgent}` });
      continue;
    }
    if (req.prefersMachine && !machineMatches(c.machine, req.prefersMachine)) {
      rejected.push({ id: c.id, why: `machine pinned to ${req.prefersMachine}` });
      continue;
    }
    kept.push(c);
  }
  return { kept, rejected };
}

/** Machine pinning is a prefix match ("wsl" matches "wsl:Ubuntu", "local" exact). */
export function machineMatches(machine: string, wanted: string): boolean {
  if (machine === wanted) return true;
  if (!wanted.includes(":")) return machine.startsWith(`${wanted}:`) || machine === wanted;
  return false;
}

/** The score step (ADR-0003 §3) with the documented weights. */
export function scoreCandidates(
  candidates: RouteCandidate[],
  req: RouteRequest,
  policy: Policy,
  route: string,
  visibleRoutes: Map<string, string[]> = new Map(),
  weights: RouteWeights = DEFAULT_WEIGHTS,
): ScoredCandidate[] {
  const scored = candidates.map((c) => {
    const kind = kindAffinity(req.taskKind, c.id, policy);
    const cost = costFit(req.budgetUsd);
    const model = routeFit(visibleRoutes.get(c.id), route);
    const machine = machineRank(c.machine, policy);
    const fail = Math.min(1, c.recentFailures / 3);
    const breakdown = {
      kind: weights.kind * kind,
      cost: weights.cost * cost,
      model: weights.model * model,
      machine: weights.machine * machine,
      fail: weights.fail * fail,
    };
    const score =
      breakdown.kind + breakdown.cost + breakdown.model + breakdown.machine - breakdown.fail;
    return { ...c, score, breakdown };
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored;
}

/** The one-line reason recorded in decision.json. */
export function explain(decision: {
  taskKind: TaskKind;
  agent: string;
  machine: string;
  modelRoute: string;
  score?: number;
  pinned?: boolean;
}): string {
  const pin = decision.pinned ? " (pinned)" : "";
  return `${decision.taskKind} → ${decision.agent} on ${decision.machine} via ${decision.modelRoute}${pin}`;
}

/** The route to use for a task kind: the policy row first, then the default row. */
export function routeForTaskKind(taskKind: TaskKind, policy: Policy, fallback: string): string {
  const row = policy.routes.byTaskKind[taskKind];
  if (row?.route) return row.route;
  if (policy.routes.default?.route) return policy.routes.default.route;
  return fallback;
}

/** The permission profile for a task kind (policy row overrides the default). */
export function permissionProfileFor(taskKind: TaskKind, policy: Policy): string {
  const row = policy.routes.byTaskKind[taskKind];
  return row?.permissionProfile ?? policy.defaults.permissionProfile;
}

/** The approval mode for a task kind (policy row overrides the default). */
export function approvalFor(taskKind: TaskKind, policy: Policy): "interactive" | "batch-approved" {
  const row = policy.routes.byTaskKind[taskKind];
  return row?.approval ?? policy.defaults.approval;
}

/** Narrow an `AgentAdapter[]` to the runnable ones (isRunnableAgent). */
export function runnableAdapters(adapters: unknown[]): HeadlessAgentAdapter[] {
  return adapters.filter((a): a is HeadlessAgentAdapter => {
    return typeof a === "object" && a !== null && isRunnableAgent(a as never);
  });
}
