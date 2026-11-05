/**
 * A minimal semver-range check for the manifest's `mola` field (the core API
 * range, e.g. ">=0.1.0 <1.0.0"). ADR-0002 §1 calls for "a missing provider or
 * a stale `mola` API range" to be a load error; B2 has no semver dependency,
 * so the subset of the range grammar that manifests actually use is enough:
 * space-separated comparators (>=, >, <=, <, =) and bare versions (=).
 *
 * Pre-release versions are ignored in the comparison (a plugin built against
 * 0.2.0-rc.1 is treated as 0.2.0) — the same simplification npm's own range
 * parser makes for the common case.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(v: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const trimmed = range.trim();
  if (!trimmed || trimmed === "*") return true;
  for (const part of trimmed.split(/\s+/)) {
    if (!part) continue;
    const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(part);
    if (!m) continue;
    const op = m[1] ?? "=";
    const target = parseVersion(m[2]);
    if (!target) continue;
    const cmp = compareVersions(v, target);
    const ok =
      op === ">=" ? cmp >= 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : op === "<" ? cmp < 0 : cmp === 0;
    if (!ok) return false;
  }
  return true;
}
