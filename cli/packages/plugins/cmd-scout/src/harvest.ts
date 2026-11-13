/** Shallow sparse clone of the top remote candidates and extraction of the files that implement the need. */
import * as fs from "node:fs";
import * as path from "node:path";
import { matchedKeywords } from "./query.js";
import type { Candidate, ExecFn, Harvest, HarvestFile } from "./types.js";

export const SIZE_CAP_KB = 200 * 1024;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|lua|sh|zig|md)$/i;
const NOISE = /(^|\/)(node_modules|vendor|dist|build|target|\.github|docs?|examples?|fixtures?|__snapshots__)\//i;
const SPECIAL = /[[\]*?!#\\]/;

export function rankPaths(paths: string[], kws: string[], max = 8): string[] {
  const scored: { p: string; s: number }[] = [];
  for (const p of paths) {
    if (SPECIAL.test(p) || !CODE_EXT.test(p) || /\.(min\.js|lock)$/.test(p) || NOISE.test(p)) continue;
    const m = matchedKeywords(p.replace(/[_/.-]/g, " "), kws).length;
    if (!m) continue;
    let s = m * 10;
    if (!/\.md$/i.test(p)) s += 3;
    if (/(^|\/)(test|tests|spec|__tests__)\//i.test(p) || /\.(test|spec)\./.test(p)) s -= 6;
    s -= p.split("/").length * 0.5;
    scored.push({ p, s });
  }
  return scored.sort((a, b) => b.s - a.s || a.p.localeCompare(b.p)).slice(0, max).map((x) => x.p);
}

function inspect(file: string, kws: string[]): Pick<HarvestFile, "lines" | "hitLine" | "excerpt"> {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let hit = lines.findIndex((l) => matchedKeywords(l, kws).length > 0);
    if (hit < 0) hit = 0;
    return {
      lines: lines.length,
      hitLine: hit + 1,
      excerpt: lines.slice(Math.max(0, hit - 1), hit + 24).join("\n").slice(0, 1400),
    };
  } catch {
    return { lines: null };
  }
}

export async function harvestRepo(exec: ExecFn, c: Candidate, outDir: string, kws: string[], timeoutMs: number): Promise<Harvest> {
  if (!c.repo) return { files: [], note: "no GitHub repo behind this candidate" };
  if (c.sizeKB != null && c.sizeKB > SIZE_CAP_KB) {
    return { files: [], note: `skipped clone: ${(c.sizeKB / 1024).toFixed(0)} MB > ${SIZE_CAP_KB / 1024} MB cap` };
  }
  const dest = path.join(outDir, "repos", c.repo.replace("/", "__"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const url = `https://github.com/${c.repo}.git`;
  const clone = await exec("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse", url, dest], { timeoutMs });
  if (clone.code !== 0) return { files: [], note: `clone failed: ${(clone.stderr || `exit ${clone.code}`).trim().split("\n")[0]!.slice(0, 140)}` };
  const ls = await exec("git", ["-C", dest, "ls-tree", "-r", "--name-only", "HEAD"], { timeoutMs });
  if (ls.code !== 0) return { dir: dest, files: [], note: "git ls-tree failed" };
  const picked = rankPaths(ls.stdout.split("\n").filter(Boolean), kws);
  if (!picked.length) return { dir: dest, files: [], note: "no file path matches the queries" };
  const sp = await exec("git", ["-C", dest, "sparse-checkout", "set", "--no-cone", ...picked.map((p) => `/${p}`)], { timeoutMs });
  const files: HarvestFile[] = picked.map((p) => ({ path: p, ...inspect(path.join(dest, p), kws) }));
  return { dir: dest, files, ...(sp.code !== 0 ? { note: "sparse-checkout failed; file contents not read" } : {}) };
}
