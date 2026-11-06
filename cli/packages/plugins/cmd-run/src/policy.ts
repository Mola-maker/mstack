/**
 * Routing policy (ADR-0003 §2, DESIGN §11 conflict 5).
 *
 * The policy lives in JSONC — `~/.mola/policy.jsonc` (user layer) merged with
 * `.mola/policy.jsonc` (repo layer, merged UNDER the user layer). The repo
 * layer can tighten, never loosen: the merge order is user ⊕ repo with the
 * repo winning for scalars, but the route whitelist is the INTERSECTION of the
 * two layers (a repo may ban more, it may never re-allow `deepseek/*`).
 *
 * Shape (all keys optional; unknown keys are kept but ignored):
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "defaults": {
 *     "budgetUsdPerRun": 2.0,
 *     "permissionProfile": "workspace-write",
 *     "approval": "interactive"
 *   },
 *   "routes": {
 *     "byTaskKind": {
 *       "implement": { "agents": ["dsh", "claude"], "route": "group/smart-split" },
 *       "review":    { "agents": ["codex"], "route": "auto/claude-sonnet-5-5" }
 *     },
 *     "default": { "agents": ["dsh"], "route": "group/smart-split" }
 *   },
 *   "machinePreference": ["local", "wsl:Ubuntu"],
 *   "modelRoutes": {
 *     "allowedHeadless": ["group/*", "auto/*"],
 *     "bannedHeadless": ["deepseek/*"]
 *   },
 *   "fallback": {
 *     "onQuotaFailure": ["retry-same-route-once", "switch-route", "switch-agent", "report"],
 *     "alternateRoutes": ["auto/kimi-k3", "group/claude-cheap"]
 *   },
 *   "isolation": { "codeChange": "worktree" }
 * }
 * ```
 *
 * The route whitelist defaults to the same rule policy-approval enforces
 * (`group/*`, `auto/*` allowed; `deepseek/*` banned — the 402 blast radius,
 * FRAMEWORK §6). mola never names a raw provider model for a headless worker.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { FsService } from "@mola/plugin-sdk";
import { deepMerge, matchesAnyPattern, parsePolicyJsonc } from "./util.js";

export type TaskKind =
  | "implement"
  | "review"
  | "research"
  | "debug"
  | "plan"
  | "qa"
  | "ship"
  | "chat";

export const TASK_KINDS: readonly TaskKind[] = [
  "implement",
  "review",
  "research",
  "debug",
  "plan",
  "qa",
  "ship",
  "chat",
];

export type PermissionProfile = "read-only" | "workspace-write" | "full-auto" | "plan";
export type ApprovalMode = "interactive" | "batch-approved";

export interface TaskKindRoute {
  /** the agents this task kind prefers, most preferred first */
  agents?: string[];
  /** the magpie route id to use */
  route?: string;
  permissionProfile?: PermissionProfile;
  approval?: ApprovalMode;
  /** the reviewer must differ from the writer (ADR-0003 §2 example) */
  differentFromWriter?: boolean;
}

export interface PolicyModelRoutes {
  allowedHeadless: string[];
  bannedHeadless: string[];
}

export interface PolicyFallback {
  /** the ladder steps, in order (ADR-0003 §4) */
  onQuotaFailure: string[];
  /** routes to try when the primary route is drained */
  alternateRoutes: string[];
}

export interface PolicyDefaults {
  budgetUsdPerRun?: number;
  permissionProfile: PermissionProfile;
  approval: ApprovalMode;
}

export interface Policy {
  version: number;
  defaults: PolicyDefaults;
  routes: {
    byTaskKind: Record<string, TaskKindRoute>;
    default?: TaskKindRoute;
  };
  machinePreference: string[];
  modelRoutes: PolicyModelRoutes;
  fallback: PolicyFallback;
  isolation: { codeChange: string };
  /** the files the policy was read from (user layer first) */
  sources: string[];
  /** non-fatal problems (unknown task kind, malformed row) */
  warnings: string[];
}

export const DEFAULT_ALLOWED_HEADLESS = ["group/*", "auto/*"];
export const DEFAULT_BANNED_HEADLESS = ["deepseek/*"];
export const DEFAULT_ROUTE = "group/smart-split";

/** The ladder of ADR-0003 §4, trimmed to the steps this implementation runs. */
export const DEFAULT_QUOTA_LADDER = [
  "retry-same-route-once",
  "switch-route",
  "switch-agent",
  "report",
];

export const DEFAULT_ALTERNATE_ROUTES = ["auto/kimi-k3", "group/claude-cheap"];

export const DEFAULT_POLICY: Policy = {
  version: 1,
  defaults: {
    permissionProfile: "workspace-write",
    approval: "interactive",
  },
  routes: { byTaskKind: {} },
  machinePreference: [],
  modelRoutes: {
    allowedHeadless: [...DEFAULT_ALLOWED_HEADLESS],
    bannedHeadless: [...DEFAULT_BANNED_HEADLESS],
  },
  fallback: {
    onQuotaFailure: [...DEFAULT_QUOTA_LADDER],
    alternateRoutes: [...DEFAULT_ALTERNATE_ROUTES],
  },
  isolation: { codeChange: "worktree" },
  sources: [],
  warnings: [],
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => str(x)).filter((x): x is string => Boolean(x));
  return out.length ? out : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function permissionProfile(v: unknown): PermissionProfile | undefined {
  const s = str(v);
  if (s === "read-only" || s === "workspace-write" || s === "full-auto" || s === "plan") return s;
  return undefined;
}

function approvalMode(v: unknown): ApprovalMode | undefined {
  const s = str(v);
  if (s === "interactive" || s === "batch-approved") return s;
  return undefined;
}

/** Normalize one policy document (already parsed) into the Policy shape. */
export function normalizePolicy(raw: Record<string, unknown>, warnings: string[] = []): Policy {
  const policy: Policy = {
    ...DEFAULT_POLICY,
    defaults: { ...DEFAULT_POLICY.defaults },
    routes: { byTaskKind: {} },
    machinePreference: [],
    modelRoutes: { ...DEFAULT_POLICY.modelRoutes },
    fallback: { ...DEFAULT_POLICY.fallback },
    isolation: { ...DEFAULT_POLICY.isolation },
    sources: [],
    warnings,
  };

  const version = num(raw.version);
  if (version !== undefined) policy.version = version;

  const defaults = raw.defaults;
  if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
    const d = defaults as Record<string, unknown>;
    const budget = num(d.budgetUsdPerRun);
    if (budget !== undefined) policy.defaults.budgetUsdPerRun = budget;
    const pp = permissionProfile(d.permissionProfile);
    if (pp) policy.defaults.permissionProfile = pp;
    const ap = approvalMode(d.approval);
    if (ap) policy.defaults.approval = ap;
  }

  const routes = raw.routes;
  if (routes && typeof routes === "object" && !Array.isArray(routes)) {
    const r = routes as Record<string, unknown>;
    const byKind = r.byTaskKind;
    if (byKind && typeof byKind === "object" && !Array.isArray(byKind)) {
      for (const [kind, value] of Object.entries(byKind as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          warnings.push(`policy: routes.byTaskKind.${kind} is not an object — ignored`);
          continue;
        }
        const row = value as Record<string, unknown>;
        const entry: TaskKindRoute = {};
        const agents = strList(row.agents);
        if (agents) entry.agents = agents;
        const route = str(row.route);
        if (route) entry.route = route;
        const pp = permissionProfile(row.permissionProfile);
        if (pp) entry.permissionProfile = pp;
        const ap = approvalMode(row.approval);
        if (ap) entry.approval = ap;
        if (typeof row.differentFromWriter === "boolean") entry.differentFromWriter = row.differentFromWriter;
        policy.routes.byTaskKind[kind] = entry;
      }
    }
    const fallbackRow = r.default;
    if (fallbackRow && typeof fallbackRow === "object" && !Array.isArray(fallbackRow)) {
      const row = fallbackRow as Record<string, unknown>;
      const entry: TaskKindRoute = {};
      const agents = strList(row.agents);
      if (agents) entry.agents = agents;
      const route = str(row.route);
      if (route) entry.route = route;
      policy.routes.default = entry;
    }
  }

  const machinePref = strList(raw.machinePreference);
  if (machinePref) policy.machinePreference = machinePref;

  const modelRoutes = raw.modelRoutes;
  if (modelRoutes && typeof modelRoutes === "object" && !Array.isArray(modelRoutes)) {
    const mr = modelRoutes as Record<string, unknown>;
    const allowed = strList(mr.allowedHeadless);
    if (allowed) policy.modelRoutes.allowedHeadless = allowed;
    const banned = strList(mr.bannedHeadless);
    if (banned) policy.modelRoutes.bannedHeadless = banned;
  }

  const fallback = raw.fallback;
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) {
    const f = fallback as Record<string, unknown>;
    const ladder = strList(f.onQuotaFailure);
    if (ladder) policy.fallback.onQuotaFailure = ladder;
    const alternates = strList(f.alternateRoutes);
    if (alternates) policy.fallback.alternateRoutes = alternates;
  }

  const isolation = raw.isolation;
  if (isolation && typeof isolation === "object" && !Array.isArray(isolation)) {
    const codeChange = str((isolation as Record<string, unknown>).codeChange);
    if (codeChange) policy.isolation.codeChange = codeChange;
  }

  return policy;
}

/** The user policy path: `~/.mola/policy.jsonc` (MOLA_HOME overrides the home). */
export function userPolicyPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.MOLA_HOME ? path.resolve(env.MOLA_HOME) : path.join(os.homedir(), ".mola");
  return path.join(home, "policy.jsonc");
}

/** The repo policy path: `<cwd>/.mola/policy.jsonc`. */
export function projectPolicyPath(cwd: string): string {
  return path.join(cwd, ".mola", "policy.jsonc");
}

/**
 * Read the policy: user layer first, repo layer merged UNDER it.
 *
 * The merge is a deep merge (repo wins for scalars/arrays). The route
 * whitelist is special-cased afterwards: the EFFECTIVE whitelist is the
 * intersection of the two layers' "allowed" lists (a repo may not re-allow a
 * route the user banned) and the union of the "banned" lists.
 */
export function loadPolicy(
  fs: FsService,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Policy {
  const warnings: string[] = [];
  const sources: string[] = [];
  const layers: Array<Record<string, unknown>> = [];

  const read = (file: string): Record<string, unknown> | undefined => {
    let text: string;
    try {
      text = fs.readFile(file);
    } catch {
      return undefined; // a missing layer is not an error
    }
    sources.push(file);
    return parsePolicyJsonc(text, file);
  };

  const user = read(userPolicyPath(env));
  if (user) layers.push(user);
  const project = read(projectPolicyPath(cwd));
  if (project) layers.push(project);

  if (layers.length === 0) {
    const policy = normalizePolicy({}, warnings);
    policy.sources = sources;
    policy.warnings = warnings;
    return policy;
  }

  let merged: unknown = {};
  for (const layer of layers) merged = deepMerge(merged, layer);
  const policy = normalizePolicy((merged ?? {}) as Record<string, unknown>, warnings);

  // The repo layer may tighten the whitelist, never loosen it.
  if (layers.length > 1) {
    const userRoutes = user?.modelRoutes as Record<string, unknown> | undefined;
    const projectRoutes = project?.modelRoutes as Record<string, unknown> | undefined;
    const userAllowed = strList(userRoutes?.allowedHeadless) ?? DEFAULT_ALLOWED_HEADLESS;
    const projectAllowed = strList(projectRoutes?.allowedHeadless);
    if (projectAllowed) {
      const narrowed = userAllowed.filter((pattern) =>
        projectAllowed.some((p) => patternsOverlap(pattern, p)),
      );
      policy.modelRoutes.allowedHeadless = narrowed.length ? narrowed : userAllowed;
      if (!narrowed.length) {
        warnings.push(
          "policy: the repo layer's allowedHeadless does not overlap the user layer — the user layer wins",
        );
      }
    }
    const userBanned = strList(userRoutes?.bannedHeadless) ?? DEFAULT_BANNED_HEADLESS;
    const projectBanned = strList(projectRoutes?.bannedHeadless) ?? [];
    policy.modelRoutes.bannedHeadless = [...new Set([...userBanned, ...projectBanned])];
  }

  policy.sources = sources;
  policy.warnings = warnings;
  return policy;
}

/** Do two route globs overlap? (used for the whitelist intersection) */
function patternsOverlap(a: string, b: string): boolean {
  // conservative: identical patterns, or one is a prefix-glob of the other
  if (a === b) return true;
  const norm = (p: string) => p.replace(/\*\*?/g, "*");
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (na.endsWith("*") && nb.startsWith(na.slice(0, -1))) return true;
  if (nb.endsWith("*") && na.startsWith(nb.slice(0, -1))) return true;
  return false;
}

/**
 * The route whitelist verdict (same rule as policy-approval's checkModelRoute):
 * allowed ⇒ ok; banned ⇒ ROUTE_BANNED; neither allowed nor banned ⇒ denied
 * (a route outside the whitelist must never ride a headless fleet).
 */
export function checkRoute(
  route: string,
  modelRoutes: PolicyModelRoutes,
): { ok: boolean; code?: "ROUTE_BANNED" | "POLICY_DENIED"; message?: string } {
  if (matchesAnyPattern(modelRoutes.bannedHeadless, route)) {
    return {
      ok: false,
      code: "ROUTE_BANNED",
      message: `route "${route}" is banned for headless runs (${modelRoutes.bannedHeadless.join(", ")})`,
    };
  }
  if (!matchesAnyPattern(modelRoutes.allowedHeadless, route)) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      message: `route "${route}" is not in the headless whitelist (${modelRoutes.allowedHeadless.join(", ")})`,
    };
  }
  return { ok: true };
}
