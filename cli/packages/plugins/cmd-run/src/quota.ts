/**
 * The quota-failure recovery ladder (ADR-0003 §4).
 *
 * Quota failures are first-class: a DeepSeek 402 on a direct route kills every
 * worker in a fleet at once, so the ladder is a fixed, ordered sequence and
 * every step is logged:
 *
 *   1. retry-same-route-once   — re-run on the same route (transient)
 *   2. magpie-quota-wait       — `magpie quota wait <provider> --timeout <d>`
 *   3. switch-route            — the same agent, the next alternateRoutes entry
 *   4. switch-agent            — the next entry of the decision's fallbacks
 *   5. report                  — the ladder is exhausted; stop and report
 *
 * The ladder never invents a route: every route it tries goes through the
 * policy whitelist (`checkRoute`), so a fallback can never land on
 * `deepseek/*` (the 402 blast radius).
 */

import type { ExecService, QuotaFailure } from "@mola/plugin-sdk";
import { checkRoute, type Policy } from "./policy.js";

export type LadderStep =
  | "retry-same-route-once"
  | "magpie-quota-wait"
  | "switch-route"
  | "switch-agent"
  | "report";

export interface LadderAttempt {
  step: LadderStep;
  agent: string;
  modelRoute: string;
  /** why the previous attempt failed (the quota signal) */
  cause?: string;
  ok: boolean;
  detail?: string;
}

export interface LadderPlan {
  /** the ordered steps to try */
  steps: LadderStep[];
  /** the routes to try after the primary one */
  alternateRoutes: string[];
  /** the agents to try after the primary one */
  fallbackAgents: string[];
}

export interface QuotaWaitRunner {
  /** wait for the provider's quota window to reset; true when it succeeded */
  wait(provider: string, timeoutSec: number): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Build the ladder plan from the policy: the step list comes from
 * `fallback.onQuotaFailure` (unknown steps are ignored, not invented), the
 * alternate routes from `fallback.alternateRoutes`, the fallback agents from
 * the decision's fallbacks.
 */
export function planLadder(
  policy: Policy,
  fallbackAgents: string[],
  primaryRoute: string,
): LadderPlan {
  const known: LadderStep[] = [
    "retry-same-route-once",
    "magpie-quota-wait",
    "switch-route",
    "switch-agent",
    "report",
  ];
  const steps = policy.fallback.onQuotaFailure.filter((s): s is LadderStep =>
    (known as string[]).includes(s),
  );
  if (!steps.includes("report")) steps.push("report");
  const alternateRoutes = policy.fallback.alternateRoutes.filter((r) => r !== primaryRoute);
  return { steps, alternateRoutes, fallbackAgents };
}

/**
 * The routes the ladder may use, in order, filtered by the whitelist.
 * A banned route is skipped, never used.
 */
export function allowedAlternates(policy: Policy, routes: string[]): string[] {
  return routes.filter((r) => checkRoute(r, policy.modelRoutes).ok);
}

/**
 * The magpie executable to run. On Windows magpie ships as `magpie.exe`
 * (the same resolution cmd-model/tool-magpie use — the permission allow-list
 * normalizes argv0, so "magpie" in the manifest covers "magpie.exe").
 */
export function resolveMagpieBinary(): string {
  return process.platform === "win32" ? "magpie.exe" : "magpie";
}

/**
 * `magpie quota wait <provider|account> --timeout <d>` (magpie-help.txt line
 * 110). The provider is the magpie provider/route prefix of the failed route
 * ("group/smart-split" → "group"). The command is a best-effort wait: when
 * magpie is unreachable the ladder moves on instead of hanging.
 */
export function quotaWaitArgv(provider: string, timeoutSec: number, binary = resolveMagpieBinary()): string[] {
  return [binary, "quota", "wait", provider, "--timeout", String(timeoutSec)];
}

/** The provider/account name of a route id ("group/smart-split" → "group"). */
export function providerOfRoute(route: string | undefined): string {
  if (!route) return "magpie";
  const slash = route.indexOf("/");
  return slash > 0 ? route.slice(0, slash) : route;
}

/** Build a quota-wait runner over the plugin's exec service. */
export function makeQuotaWaitRunner(exec: ExecService, timeoutMs = 120_000): QuotaWaitRunner {
  return {
    async wait(provider, timeoutSec) {
      try {
        const res = await exec.exec(quotaWaitArgv(provider, timeoutSec), { timeoutMs });
        if (res.code === 0) return { ok: true, detail: res.stdout.trim() || "quota window reset" };
        return { ok: false, detail: res.stderr.trim() || `magpie quota wait exited ${res.code}` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** The summary of a ladder walk — the attempts, in order. */
export interface LadderOutcome {
  attempts: LadderAttempt[];
  exhausted: boolean;
  /** the agent+route the ladder finally used, when it succeeded */
  final?: { agent: string; modelRoute: string };
}

export function summarize(attempts: LadderAttempt[]): LadderOutcome {
  const last = attempts[attempts.length - 1];
  return { attempts, exhausted: !last || !last.ok };
}
