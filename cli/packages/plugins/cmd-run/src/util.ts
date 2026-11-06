/**
 * Small local helpers for cmd-run. Plugins import only @mola/plugin-sdk
 * (cmd-model precedent), so the three pieces cmd-run needs from core's
 * toolbox — route globs, JSONC parsing, deep merge — are duplicated here in
 * their minimal form. The rules match the core originals: `*`/`?` stay within
 * one segment, `**` crosses; JSONC = // and block comments + trailing commas;
 * deep merge: overlay wins, `null` deletes.
 */

import { ExitCode, MolaError } from "@mola/plugin-sdk";

/** Route glob → RegExp (same rules as policy-approval's routeMatchesPattern). */
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

export function matchesAnyPattern(patterns: string[], route: string): boolean {
  return patterns.some((p) => routeMatchesPattern(p, route));
}

/** Strip // comments, block comments and trailing commas (strings preserved). */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        const s = text[i];
        out += s;
        if (s === "\\") {
          if (i + 1 < n) out += text[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (s === '"') break;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Parse a policy JSONC file; parse failures are CONFIG_INVALID (exit 65). */
export function parsePolicyJsonc(text: string, fileName: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonc(text));
  } catch (err) {
    throw new MolaError(
      "CONFIG_INVALID",
      `${fileName}: invalid JSONC — ${err instanceof Error ? err.message : String(err)}`,
      ExitCode.DataErr,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MolaError("CONFIG_INVALID", `${fileName}: top level must be an object`, ExitCode.DataErr);
  }
  return value as Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** deepMerge(base, overlay): overlay wins for scalars/arrays/objects; null deletes. */
export function deepMerge(base: unknown, overlay: unknown): unknown {
  if (overlay === null) return undefined;
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(overlay)) {
      const merged = deepMerge(out[k], v);
      if (merged === undefined) delete out[k];
      else out[k] = merged;
    }
    return out;
  }
  return overlay;
}

/** "Fix the login Bug!!" → "fix-the-login-bug" (mstack <slug> convention). */
export function slugify(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return slug || "task";
}
