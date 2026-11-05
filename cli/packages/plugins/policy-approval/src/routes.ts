/**
 * Route whitelist (ADR-0003 §2, BRIEF #3): headless workers ride magpie routes
 * only — `group/*` and `auto/*` are allowed; `deepseek/*` is banned outright
 * because a 402 on a direct route kills every worker in a fleet at once
 * (harness-commands.md, FRAMEWORK §6). `--yes` does NOT bypass this: the
 * whitelist is structural (magpie owns the models), not an approval.
 *
 * Patterns are simple magpie route globs: `*` stays within one segment, `**`
 * crosses segments. The defaults can be overridden through config
 * (`policy.modelRoutes.allowedHeadless` / `...bannedHeadless`); the full
 * policy.jsonc file layering arrives in B2.
 */

export const DEFAULT_ALLOWED_HEADLESS = ["group/*", "auto/*"];
export const DEFAULT_BANNED_HEADLESS = ["deepseek/*"];

export interface RoutePolicy {
  allowedHeadless?: string[];
  bannedHeadless?: string[];
}

export type RouteVerdict =
  | { ok: true; route: string }
  | { ok: false; code: "ROUTE_BANNED" | "POLICY_DENIED"; message: string };

export function routeMatchesPattern(pattern: string, route: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(route);
}

export function checkModelRoute(route: string, policy: RoutePolicy = {}): RouteVerdict {
  const banned = policy.bannedHeadless ?? DEFAULT_BANNED_HEADLESS;
  for (const p of banned) {
    if (routeMatchesPattern(p, route)) {
      return {
        ok: false,
        code: "ROUTE_BANNED",
        message: `route "${route}" is banned by policy (${p}) — headless workers ride magpie group/* / auto/* routes; a direct deepseek/* 402 kills the whole fleet`,
      };
    }
  }
  const allowed = policy.allowedHeadless ?? DEFAULT_ALLOWED_HEADLESS;
  if (allowed.some((p) => routeMatchesPattern(p, route))) {
    return { ok: true, route };
  }
  return {
    ok: false,
    code: "POLICY_DENIED",
    message: `route "${route}" is not in the headless whitelist (${allowed.join(", ")}) — magpie owns the model routes`,
  };
}
