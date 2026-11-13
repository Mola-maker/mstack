/** License classification and candidate scoring. */
import type { Candidate, LicenseClass } from "./types.js";

const OK = new Set(["mit", "apache-2.0", "0bsd", "isc", "unlicense", "bsd-2-clause", "bsd-3-clause", "bsd-3-clause-clear", "bsd-4-clause"]);

/** Classify a license id/name. Missing, unknown, GPL and AGPL are flagged. */
export function classifyLicense(raw: string | undefined | null): { id: string; cls: LicenseClass; note?: string } {
  const id = (raw ?? "").trim();
  if (!id || /^(noassertion|other|none|null|unknown)$/i.test(id)) {
    return { id: id || "none", cls: "flag", note: "license missing or unknown" };
  }
  const l = id.toLowerCase();
  if (/agpl/.test(l)) return { id, cls: "flag", note: "AGPL: network copyleft" };
  if (/gpl/.test(l) && !/lgpl/.test(l)) return { id, cls: "flag", note: "GPL: copyleft" };
  if (/lgpl/.test(l)) return { id, cls: "flag", note: "LGPL: copyleft, check linking" };
  if (/mpl|mozilla/.test(l)) return { id, cls: "note", note: "MPL: file-level copyleft, keep changed files open" };
  if (OK.has(l) || /^bsd/.test(l) || /^mit\b/.test(l) || /^apache/.test(l)) return { id, cls: "ok" };
  return { id, cls: "flag", note: "license not on the allow list" };
}

const DAY = 86_400_000;

/** Higher is better. Local hit > owner-starred > stars/recency/match. */
export function scoreCandidate(c: Candidate, now: Date, matchCount: number, vocabSize: number): number {
  let s = 0;
  if (c.sources.includes("local")) s += 100 + Math.min(c.hits?.length ?? 0, 5);
  if (c.starred) s += 30;
  if (c.stars != null) s += 4 * Math.log10(c.stars + 1);
  else if (c.popularity) s += 8; // packages: registry rank stands in for stars
  if (c.pushedAt) {
    const age = (now.getTime() - new Date(c.pushedAt).getTime()) / DAY;
    if (Number.isFinite(age)) s += 10 * Math.max(0, 1 - age / 730);
  }
  s += 15 * (vocabSize ? Math.min(1, matchCount / Math.min(vocabSize, 4)) : 0);
  s += 3 * (c.sources.length - 1);
  if (c.licenseClass === "flag") s -= 5;
  return Math.round(s * 100) / 100;
}
