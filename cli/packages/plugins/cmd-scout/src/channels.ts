/** The search channels. Every one returns raw candidates; failures throw and are caught by the caller. */
import * as fs from "node:fs";
import * as path from "node:path";
import { matchedKeywords } from "./query.js";
import type { Candidate, ExecFn, FetchFn, Source } from "./types.js";

export type Raw = Omit<Candidate, "score" | "starred" | "licenseClass" | "adaptable" | "sources"> & { source: Source; license?: string };

const UA = "mola-scout";

export function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what}: output is not JSON`);
  }
}

function must(r: { code: number; stdout: string; stderr: string }, what: string): string {
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`;
    throw new Error(`${what}: ${r.code === 127 ? "not installed" : msg.slice(0, 160)}`);
  }
  return r.stdout;
}

/** Concatenated top-level JSON arrays (what `gh api --paginate` prints) -> one array. */
export function parsePagedArrays(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const part = JSON.parse(text.slice(start, i + 1)) as unknown;
        if (Array.isArray(part)) out.push(...part);
        else out.push(part);
        start = -1;
      }
    }
  }
  if (!out.length && text.trim() !== "[]") throw new Error("gh api: empty or unparsable output");
  return out;
}

// ------------------------------------------------------------------ local

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|lua|sh|zig)$/i;
const CODE_EXCLUDES = ["!node_modules", "!.git", "!.mstack", "!dist", "!*.lock", "!pnpm-lock.yaml", "!package-lock.json", "!*.min.js"];

async function grepHits(exec: ExecFn, root: string, kws: string[], timeoutMs: number): Promise<string[]> {
  const rgArgs = ["-n", "-i", "--no-heading", "--max-count", "3", "--max-columns", "200", "--max-columns-preview"];
  for (const g of CODE_EXCLUDES) rgArgs.push("-g", g);
  for (const k of kws) rgArgs.push("-e", k);
  rgArgs.push(".");
  const rg = await exec("rg", rgArgs, { cwd: root, timeoutMs });
  if (rg.code === 0 || rg.code === 1) return rg.stdout.split("\n").filter(Boolean);
  if (rg.code !== 127) throw new Error(`rg: ${(rg.stderr || "failed").trim().split("\n")[0]!.slice(0, 120)}`);
  const gitArgs = ["grep", "-n", "-i", "-I", "--max-count", "3"];
  for (const k of kws) gitArgs.push("-e", k);
  gitArgs.push("--", ".", ":(exclude)node_modules", ":(exclude).mstack", ":(exclude)*.lock");
  const g = await exec("git", gitArgs, { cwd: root, timeoutMs });
  if (g.code === 0 || g.code === 1) return g.stdout.split("\n").filter(Boolean);
  throw new Error(`rg not installed; git grep: ${(g.stderr || "failed").trim().split("\n")[0]!.slice(0, 120)}`);
}

export async function localChannel(
  exec: ExecFn,
  roots: { label: string; dir: string }[],
  kws: string[],
  timeoutMs: number,
): Promise<{ raws: Raw[]; detail: string }> {
  const raws: Raw[] = [];
  const problems: string[] = [];
  const need = Math.min(3, Math.ceil(kws.length * 0.6));
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) {
      problems.push(`${root.label}: directory not found`);
      continue;
    }
    let lines: string[];
    try {
      lines = await grepHits(exec, root.dir, kws, timeoutMs);
    } catch (e) {
      problems.push(`${root.label}: ${(e as Error).message}`);
      continue;
    }
    const byFile = new Map<string, { hits: string[]; kws: Set<string> }>();
    for (const line of lines) {
      const m = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      const f = m[1]!;
      const e = byFile.get(f) ?? { hits: [], kws: new Set<string>() };
      e.hits.push(`${f}:${m[2]}`);
      for (const k of matchedKeywords(`${f} ${m[3]}`.replace(/[_/.-]/g, " "), kws)) e.kws.add(k);
      byFile.set(f, e);
    }
    const ranked = [...byFile.entries()]
      .filter(([f, e]) => CODE_FILE.test(f) && e.kws.size >= need)
      .sort((a, b) => b[1].kws.size - a[1].kws.size || b[1].hits.length - a[1].hits.length)
      .slice(0, 5);
    for (const [f, e] of ranked) {
      const abs = path.join(root.dir, f);
      raws.push({
        key: `local:${root.label}/${f}`,
        kind: "local",
        name: `${root.label}/${f}`,
        url: abs,
        source: "local",
        license: "(local)",
        hits: e.hits.map((h) => `${root.label}/${h}`),
        why: [`local: ${[...e.kws].join(", ")} at ${e.hits.slice(0, 3).join(", ")}`],
        repo: undefined,
      } as Raw);
    }
  }
  if (problems.length && !raws.length && problems.length === roots.length) throw new Error(problems.join("; "));
  const detail = `${raws.length} files with hits in ${roots.length - problems.length}/${roots.length} roots${problems.length ? ` (${problems.join("; ")})` : ""}`;
  return { raws, detail };
}

// ------------------------------------------------------------------ stars

export interface StarredItem {
  fullName: string;
  description?: string;
  stargazersCount?: number;
  pushedAt?: string;
  license?: string;
  topics?: string[];
  url?: string;
  sizeKB?: number;
}
interface StarredCache {
  fetchedAt: string;
  items: StarredItem[];
}

const DAY_MS = 86_400_000;

function fromApi(r: Record<string, unknown>): StarredItem {
  const lic = r.license as { spdx_id?: string; key?: string } | null | undefined;
  return {
    fullName: String(r.full_name ?? ""),
    description: (r.description as string | null) ?? undefined,
    stargazersCount: r.stargazers_count as number | undefined,
    pushedAt: r.pushed_at as string | undefined,
    license: lic?.spdx_id ?? lic?.key ?? undefined,
    topics: Array.isArray(r.topics) ? (r.topics as string[]) : [],
    url: (r.html_url as string | undefined) ?? `https://github.com/${r.full_name}`,
    sizeKB: r.size as number | undefined,
  };
}

export function parseSeedTsv(text: string): StarredItem[] {
  const items: StarredItem[] = [];
  for (const line of text.split("\n")) {
    const cols = line.replace(/\r$/, "").split("\t");
    if (cols.length < 3 || !/^[^/\s]+\/[^/\s]+$/.test(cols[1]!)) continue;
    items.push({
      fullName: cols[1]!,
      stargazersCount: Number(cols[2]) || undefined,
      description: cols.slice(3).join(" ") || undefined,
      url: `https://github.com/${cols[1]}`,
    });
  }
  return items;
}

export function findSeedTsv(startDirs: string[], explicit?: string): string | null {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  for (const start of startDirs) {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i++) {
      const f = path.join(dir, "research", "round3", "starred.tsv");
      if (fs.existsSync(f)) return f;
      const p = path.dirname(dir);
      if (p === dir) break;
      dir = p;
    }
  }
  return null;
}

/** Load the owner's stars: fresh cache, else gh refresh, else tsv seed. */
export async function loadStarred(opts: {
  exec: ExecFn;
  now: Date;
  homeDir: string;
  seedTsv: string | null;
  timeoutMs: number;
}): Promise<{ items: StarredItem[]; origin: "cache" | "refreshed" | "seed"; note?: string }> {
  const file = path.join(opts.homeDir, ".mola", "cache", "starred.json");
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8")) as StarredCache;
    const age = opts.now.getTime() - new Date(c.fetchedAt).getTime();
    if (Array.isArray(c.items) && age >= 0 && age < DAY_MS) return { items: c.items, origin: "cache" };
  } catch {
    /* missing or corrupt: refresh */
  }
  let refreshError = "";
  try {
    const out = must(await opts.exec("gh", ["api", "user/starred", "--paginate"], { timeoutMs: opts.timeoutMs }), "gh api user/starred");
    const items = parsePagedArrays(out).map((r) => fromApi(r as Record<string, unknown>)).filter((i) => i.fullName);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ fetchedAt: opts.now.toISOString(), items } satisfies StarredCache));
    } catch {
      /* cache write is best-effort */
    }
    return { items, origin: "refreshed" };
  } catch (e) {
    refreshError = (e as Error).message;
  }
  if (!opts.seedTsv) throw new Error(`refresh failed (${refreshError}) and no starred.tsv seed found`);
  const items = parseSeedTsv(fs.readFileSync(opts.seedTsv, "utf8"));
  if (!items.length) throw new Error(`refresh failed (${refreshError}); seed ${opts.seedTsv} is empty`);
  return { items, origin: "seed", note: `refresh failed (${refreshError}); seeded from ${path.basename(opts.seedTsv)}` };
}

export function starredRaws(items: StarredItem[], kws: string[]): Raw[] {
  const need = kws.length > 1 ? 2 : 1;
  const out: { raw: Raw; n: number }[] = [];
  for (const it of items) {
    const hay = `${it.fullName.replace(/[/_-]/g, " ")} ${it.description ?? ""} ${(it.topics ?? []).join(" ")}`;
    const m = matchedKeywords(hay, kws);
    if (m.length < need) continue;
    out.push({
      n: m.length,
      raw: {
        key: it.fullName.toLowerCase(),
        kind: "repo",
        name: it.fullName,
        url: it.url ?? `https://github.com/${it.fullName}`,
        source: "stars",
        stars: it.stargazersCount,
        pushedAt: it.pushedAt,
        license: it.license,
        sizeKB: it.sizeKB,
        description: it.description,
        repo: it.fullName,
        why: [`you starred it; matches ${m.join(", ")}`],
      } as Raw,
    });
  }
  return out.sort((a, b) => b.n - a.n).slice(0, 10).map((x) => x.raw);
}

// ----------------------------------------------------------------- github

interface GhRepo {
  fullName?: string;
  description?: string;
  stargazersCount?: number;
  pushedAt?: string;
  license?: { key?: string; name?: string } | null;
  url?: string;
  size?: number;
}

export async function githubRepos(exec: ExecFn, q: string, timeoutMs: number): Promise<Raw[]> {
  const out = must(
    await exec("gh", ["search", "repos", q, "--limit", "10", "--json", "fullName,description,stargazersCount,pushedAt,license,url,size"], { timeoutMs }),
    "gh search repos",
  );
  return parseJson<GhRepo[]>(out, "gh search repos")
    .filter((r) => r.fullName)
    .map(
      (r) =>
        ({
          key: r.fullName!.toLowerCase(),
          kind: "repo",
          name: r.fullName!,
          url: r.url ?? `https://github.com/${r.fullName}`,
          source: "github-repos",
          stars: r.stargazersCount,
          pushedAt: r.pushedAt,
          license: r.license?.key && r.license.key !== "other" ? (r.license.name ?? r.license.key) : r.license?.key,
          sizeKB: r.size,
          description: r.description ?? undefined,
          repo: r.fullName,
          why: [`repo search "${q}"`],
        }) as Raw,
    );
}

interface GhCode {
  repository?: { nameWithOwner?: string; fullName?: string; url?: string };
  path?: string;
  url?: string;
}

export async function githubCode(exec: ExecFn, q: string, timeoutMs: number): Promise<Raw[]> {
  const out = must(await exec("gh", ["search", "code", q, "--limit", "10", "--json", "repository,path,url"], { timeoutMs }), "gh search code");
  const res: Raw[] = [];
  for (const r of parseJson<GhCode[]>(out, "gh search code")) {
    const full = r.repository?.nameWithOwner ?? r.repository?.fullName;
    if (!full) continue;
    res.push({
      key: full.toLowerCase(),
      kind: "repo",
      name: full,
      url: r.repository?.url ?? `https://github.com/${full}`,
      source: "github-code",
      repo: full,
      why: [`code search "${q}": ${r.path ?? "?"}`],
    } as Raw);
  }
  return res;
}

// --------------------------------------------------------------- registries

function repoFromUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(u);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

async function getJson(fetchFn: FetchFn, url: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function npmSearch(fetchFn: FetchFn, q: string, timeoutMs: number): Promise<Raw[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=10`;
  const j = (await getJson(fetchFn, url, timeoutMs)) as {
    objects?: { package?: { name?: string; description?: string; date?: string; license?: string; links?: { npm?: string; repository?: string; homepage?: string } }; score?: { detail?: { popularity?: number } } }[];
  };
  const res: Raw[] = [];
  for (const o of j.objects ?? []) {
    const p = o.package;
    if (!p?.name) continue;
    const repo = repoFromUrl(p.links?.repository);
    res.push({
      key: repo ? repo.toLowerCase() : `npm:${p.name}`,
      kind: repo ? "repo" : "package",
      name: repo ?? `npm:${p.name}`,
      url: p.links?.npm ?? p.links?.repository ?? `https://www.npmjs.com/package/${p.name}`,
      source: "npm",
      pushedAt: p.date,
      license: p.license,
      description: p.description,
      popularity: o.score?.detail?.popularity != null ? `npm popularity ${o.score.detail.popularity.toFixed(2)}` : "npm result",
      repo,
      why: [`npm package ${p.name}${repo ? ` (${repo})` : ""} for "${q}"`],
    } as Raw);
  }
  return res;
}

export async function cratesSearch(fetchFn: FetchFn, q: string, timeoutMs: number): Promise<Raw[]> {
  const url = `https://crates.io/api/v1/crates?q=${encodeURIComponent(q)}&per_page=10`;
  const j = (await getJson(fetchFn, url, timeoutMs)) as {
    crates?: { name?: string; description?: string; downloads?: number; updated_at?: string; repository?: string; license?: string }[];
  };
  const res: Raw[] = [];
  for (const c of j.crates ?? []) {
    if (!c.name) continue;
    const repo = repoFromUrl(c.repository);
    res.push({
      key: repo ? repo.toLowerCase() : `crates:${c.name}`,
      kind: repo ? "repo" : "package",
      name: repo ?? `crates:${c.name}`,
      url: `https://crates.io/crates/${c.name}`,
      source: "crates",
      pushedAt: c.updated_at,
      license: c.license,
      description: c.description,
      popularity: `${c.downloads ?? 0} downloads`,
      repo,
      why: [`crate ${c.name}${repo ? ` (${repo})` : ""} for "${q}"`],
    } as Raw);
  }
  return res;
}

