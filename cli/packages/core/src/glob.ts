/**
 * Minimal glob matching for permission allow-lists (core §6): `**` crosses
 * separators, `*` and `?` stay within one segment. Paths are normalized to `/`
 * before matching so the same grants behave on Linux and Windows.
 */

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "/" && g.slice(i) === "/**") {
      re += "(?:/.*)?"; // "dir/**" also matches "dir" itself
      break;
    }
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (g[i] === "/") i++; // "**/" also matches zero directories
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else {
      re += escapeRe(c);
      i++;
    }
  }
  return new RegExp(`^${re}$`, "i"); // case-insensitive: Windows paths
}

export function matchesAnyGlob(path: string, globs: string[] | undefined): boolean {
  if (!globs) return false;
  const normalized = path.replace(/\\/g, "/");
  return globs.some((g) => globToRegExp(g).test(normalized));
}
