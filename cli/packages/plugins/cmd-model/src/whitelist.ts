/**
 * Route whitelist for `mola model set` (BRIEF #3 / ADR-0003 §2).
 *
 * The same whitelist the policy plugin enforces on dispatch, validated here
 * locally — cmd-model does not import policy-approval (plugins stay
 * independent; the shared rule lives in ADR-0003 and the config defaults
 * below). Headless workers ride only magpie `group/*` / `auto/*` routes;
 * `deepseek/*` direct is banned (a 402 there kills every worker at once).
 *
 * The lists are config, not code: `model.allowedRoutes` / `model.bannedRoutes`
 * override the defaults through the normal config layers.
 */

export const DEFAULT_ALLOWED_ROUTES = ["group/*", "auto/*"];
export const DEFAULT_BANNED_ROUTES = ["deepseek/*"];

export type RouteVerdict =
  | { ok: true }
  | { ok: false; reason: "banned" | "not-allowed"; message: string };

/**
 * Minimal glob → RegExp (same rules as core's permission globs): `**` crosses
 * separators, `*` and `?` stay within one segment. Duplicated locally because
 * plugins import only @mola/plugin-sdk.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(globList: string[], route: string): boolean {
  return globList.some((g) => globToRegExp(g).test(route));
}

/** Classify a requested route against the whitelist. */
export function classifyRoute(
  route: string,
  allowed: string[] = DEFAULT_ALLOWED_ROUTES,
  banned: string[] = DEFAULT_BANNED_ROUTES,
): RouteVerdict {
  if (matchesAny(banned, route)) {
    return {
      ok: false,
      reason: "banned",
      message: `route "${route}" is banned by policy (${banned.join(", ")}) — headless traffic rides magpie ${allowed.join(", ")} routes; a direct deepseek/* 402 kills every worker at once`,
    };
  }
  if (!matchesAny(allowed, route)) {
    return {
      ok: false,
      reason: "not-allowed",
      message: `route "${route}" is not in the whitelist (${allowed.join(", ")}) — magpie owns model choice; use a group/* or auto/* route`,
    };
  }
  return { ok: true };
}

/**
 * magpie prints routes as "magpie/group/smart-split" when the route rides the
 * magpie gateway; mola's canonical form is the bare route id.
 */
export function stripMagpiePrefix(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.startsWith("magpie/") ? model.slice("magpie/".length) : model;
}
