/** `scout(need, opts, deps)`: search, harvest, decide (FRAMEWORK §13.5). */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cratesSearch,
  findSeedTsv,
  githubCode,
  githubRepos,
  loadStarred,
  localChannel,
  npmSearch,
  starredRaws,
  type Raw,
  type StarredItem,
} from "./channels.js";
import { harvestRepo } from "./harvest.js";
import { deriveQueries, extractKeywords, matchVocabulary, matchedKeywords } from "./query.js";
import { renderReuse } from "./report.js";
import { classifyLicense, scoreCandidate } from "./score.js";
import type { Candidate, ChannelReport, ScoutDeps, ScoutOptions, ScoutResult, Source } from "./types.js";

const DEFAULT_TIMEOUT = 25_000;
const PENDING = "decision: pending (run without --no-llm or decide by hand)";

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timer = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what}: timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, "0");
}
export function makeId(now: Date, hex: string): string {
  return `scout-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${hex}`;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function parseQueryList(text: string): string[] {
  const m = /\[[\s\S]*?\]/.exec(text);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string").map((s) => s.trim().slice(0, 80)).filter(Boolean).slice(0, 4);
  } catch {
    return [];
  }
}

interface ChannelOut {
  report: ChannelReport;
  raws: Raw[];
  starred?: StarredItem[];
}

/** Run one search per query, merge, and report ok/failed (partial failure stays ok with a note). */
async function perQuery(
  channel: string,
  queries: string[],
  timeoutMs: number,
  fn: (q: string) => Promise<Raw[]>,
): Promise<ChannelOut> {
  const settled = await Promise.allSettled(queries.map((q) => withTimeout(fn(q), timeoutMs, channel)));
  const raws: Raw[] = [];
  const errs: string[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") raws.push(...s.value);
    else errs.push((s.reason as Error).message);
  }
  if (errs.length === queries.length) return { raws: [], report: { channel, status: "failed", detail: [...new Set(errs)].join("; ") } };
  const detail = `${raws.length} results${errs.length ? `; ${errs.length}/${queries.length} queries failed: ${[...new Set(errs)].join("; ")}` : ""}`;
  return { raws, report: { channel, status: "ok", detail } };
}

async function guarded(channel: string, timeoutMs: number, fn: () => Promise<ChannelOut>): Promise<ChannelOut> {
  try {
    return await withTimeout(fn(), timeoutMs, channel);
  } catch (e) {
    return { raws: [], report: { channel, status: "failed", detail: (e as Error).message } };
  }
}

export function buildDecisionPrompt(need: string, cands: Candidate[]): string {
  const rows = cands.slice(0, 12).map((c, i) => {
    const lic = c.licenseClass === "flag" ? `${c.license ?? "none"} (FLAGGED: never "adapt")` : (c.license ?? "none");
    return `${i + 1}. [${c.sources.join("+")}] ${c.name} ${c.url} stars=${c.stars ?? c.popularity ?? "?"} pushed=${c.pushedAt?.slice(0, 10) ?? "?"} license=${lic}${c.starred ? " owner-starred" : ""}\n   ${c.description ?? c.why.join("; ")}`;
  });
  const harvest = cands
    .filter((c) => c.harvest?.files.length)
    .map((c) => {
      const fs_ = c.harvest!.files
        .map((f) => `--- ${f.path} (${f.lines ?? "?"} lines, first match line ${f.hitLine ?? "?"})\n${f.excerpt ?? ""}`)
        .join("\n");
      return `### ${c.name}\n${fs_}`;
    });
  return [
    "You are the scout stage of a coding workflow. Decide whether to reuse existing code before anyone writes new code.",
    `NEED: ${need}`,
    "CANDIDATES (ranked):",
    rows.join("\n") || "(none)",
    "HARVESTED FILES:",
    harvest.join("\n") || "(none)",
    "Answer in markdown with exactly these parts:",
    "1. First line: `decision: reuse|adapt|write — <one-sentence reason>`. reuse = take a dependency; adapt = copy code with attribution; write = none fit, state why.",
    "2. `patterns:` 1-3 code patterns worth copying, each as `file:line — what to copy` (use the repo name from the candidates).",
    "3. `license:` the consequence (attribution, copyleft, or missing license). A FLAGGED license must never be answered with adapt.",
    "Be concise; do not invent files that are not listed.",
  ].join("\n");
}

export async function scout(need: string, opts: ScoutOptions, deps: ScoutDeps): Promise<ScoutResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const limit = opts.limit ?? 3;
  const now = deps.clock();
  const id = makeId(now, (deps.randHex ?? (() => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")))());
  const outDir = opts.out ? path.resolve(cwd, opts.out) : path.join(cwd, ".mstack", "scout", id);
  fs.mkdirSync(outDir, { recursive: true });
  const reports: ChannelReport[] = [];
  const useLlm = opts.llm !== false;

  // ---- queries
  let queries = deriveQueries(need);
  if (useLlm) {
    try {
      const text = await withTimeout(
        deps.model(
          `Give 2-4 short search queries (JSON array of strings, nothing else) to find the best existing open-source libraries and code for GitHub, npm and crates.io search. Need: ${need}\nBaseline queries: ${JSON.stringify(queries)}`,
          { kind: "explore", cwd },
        ),
        60_000,
        "llm queries",
      );
      const llm = parseQueryList(text);
      if (llm.length) {
        queries = [...new Set([...llm.slice(0, 3), ...queries])].slice(0, 4);
        reports.push({ channel: "llm-queries", status: "ok", detail: `${llm.length} queries from the explore model` });
      } else reports.push({ channel: "llm-queries", status: "failed", detail: "model reply had no JSON array; kept deterministic queries" });
    } catch (e) {
      reports.push({ channel: "llm-queries", status: "failed", detail: `${(e as Error).message}; kept deterministic queries` });
    }
  } else reports.push({ channel: "llm-queries", status: "skipped", detail: "--no-llm" });
  const vocab = matchVocabulary(need, queries);

  // ---- channels in parallel
  const repoDir = path.resolve(cwd, opts.repo ?? ".");
  const roots = [{ label: path.basename(repoDir) || "repo", dir: repoDir }];
  for (const r of opts.roots ?? []) {
    const d = path.resolve(cwd, expandHome(r));
    if (!roots.some((x) => x.dir === d)) roots.push({ label: path.basename(d), dir: d });
  }
  const seedTsv = findSeedTsv([cwd, repoDir], opts.seedTsv);
  const homeDir = opts.homeDir ?? os.homedir();
  const ghQ = queries;
  const outs = await Promise.all([
    guarded("local", timeoutMs, async () => {
      const r = await localChannel(deps.exec, roots, vocab, timeoutMs);
      return { raws: r.raws, report: { channel: "local", status: "ok", detail: r.detail } };
    }),
    guarded("stars", timeoutMs * 3, async () => {
      const s = await loadStarred({ exec: deps.exec, now, homeDir, seedTsv, timeoutMs });
      const raws = starredRaws(s.items, vocab);
      return {
        raws,
        starred: s.items,
        report: { channel: "stars", status: "ok", detail: `${raws.length} matches in ${s.items.length} stars (${s.origin})${s.note ? `; ${s.note}` : ""}` },
      };
    }),
    guarded("github-repos", timeoutMs * 2, () => perQuery("github-repos", ghQ, timeoutMs, (q) => githubRepos(deps.exec, q, timeoutMs))),
    guarded("github-code", timeoutMs * 2, () => perQuery("github-code", ghQ.slice(0, 2), timeoutMs, (q) => githubCode(deps.exec, q, timeoutMs))),
    guarded("npm", timeoutMs * 2, () => perQuery("npm", ghQ, timeoutMs, (q) => npmSearch(deps.fetch, q, timeoutMs))),
    guarded("crates", timeoutMs * 2, () => perQuery("crates", ghQ, timeoutMs, (q) => cratesSearch(deps.fetch, q, timeoutMs))),
  ]);
  for (const o of outs) reports.push(o.report);

  // ---- merge + score
  const starredSet = new Set((outs.find((o) => o.starred)?.starred ?? []).map((i) => i.fullName.toLowerCase()));
  const map = new Map<string, Candidate>();
  for (const o of outs) {
    for (const r of o.raws) {
      const lic = classifyLicense(r.license);
      const local = r.kind === "local";
      const prev = map.get(r.key);
      const { source, license, ...rest } = r;
      if (!prev) {
        map.set(r.key, {
          ...rest,
          sources: [source as Source],
          license: local ? "(local)" : license,
          licenseClass: local ? "ok" : lic.cls,
          adaptable: local || lic.cls !== "flag",
          starred: false,
          score: 0,
        } as Candidate);
      } else {
        if (!prev.sources.includes(source as Source)) prev.sources.push(source as Source);
        prev.stars = Math.max(prev.stars ?? 0, r.stars ?? 0) || undefined;
        prev.pushedAt ??= r.pushedAt;
        prev.description ??= r.description;
        prev.sizeKB ??= r.sizeKB;
        prev.popularity ??= r.popularity;
        prev.repo ??= r.repo;
        if (!prev.license || prev.licenseClass === "flag") {
          const l2 = classifyLicense(license);
          if (license && (l2.cls !== "flag" || !prev.license)) {
            prev.license = license;
            prev.licenseClass = l2.cls;
            prev.adaptable = l2.cls !== "flag";
          }
        }
        prev.why.push(...r.why);
      }
    }
  }
  const cands = [...map.values()];
  for (const c of cands) {
    c.starred = c.kind !== "local" && !!c.repo && starredSet.has(c.repo.toLowerCase());
    if (c.starred && !c.sources.includes("stars")) c.why.push("you starred it");
    const matched = matchedKeywords(`${c.name} ${c.description ?? ""}`.replace(/[_/.:-]/g, " "), vocab).length;
    c.score = scoreCandidate(c, now, matched, vocab.length);
  }
  cands.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // ---- harvest
  const harvestKws = vocab.length ? vocab : extractKeywords(need);
  if (opts.clone === false) reports.push({ channel: "harvest", status: "skipped", detail: "--no-clone" });
  else {
    const targets = cands.filter((c) => c.repo && c.kind !== "local").slice(0, limit);
    if (!targets.length) reports.push({ channel: "harvest", status: "skipped", detail: "no remote repo candidates" });
    else {
      const res = await Promise.all(
        targets.map(async (c) => {
          try {
            c.harvest = await withTimeout(harvestRepo(deps.exec, c, outDir, harvestKws, timeoutMs * 4), timeoutMs * 5, `harvest ${c.repo}`);
            return c.harvest.files.length ? "ok" : "empty";
          } catch (e) {
            c.harvest = { files: [], note: (e as Error).message };
            return "failed";
          }
        }),
      );
      const ok = res.filter((r) => r === "ok").length;
      reports.push({
        channel: "harvest",
        status: ok ? "ok" : "failed",
        detail: `${ok}/${targets.length} repos yielded files${targets.map((t) => (t.harvest?.note ? `; ${t.repo}: ${t.harvest.note}` : "")).join("")}`,
      });
    }
  }

  // ---- decide
  let decision: ScoutResult["decision"];
  if (!useLlm) decision = { status: "pending", text: PENDING };
  else {
    try {
      const text = (await withTimeout(deps.model(buildDecisionPrompt(need, cands), { kind: "explore", cwd }), 120_000, "llm decision")).trim();
      if (!text) throw new Error("empty reply");
      const flagged = cands.filter((c) => !c.adaptable && c.kind !== "local").slice(0, 12);
      const guard = flagged.length ? `\n\n> license guard: ${flagged.map((c) => c.name).join(", ")} are flagged (GPL/AGPL/missing/unknown); they are never \`adapt\` candidates.` : "";
      decision = { status: "decided", text: text + guard };
      reports.push({ channel: "llm-decision", status: "ok", detail: "explore model" });
    } catch (e) {
      decision = { status: "failed", text: `decision: pending (model call failed: ${(e as Error).message}; decide by hand)` };
      reports.push({ channel: "llm-decision", status: "failed", detail: (e as Error).message });
    }
  }
  if (!useLlm) reports.push({ channel: "llm-decision", status: "skipped", detail: "--no-llm" });

  // ---- write
  const reusePath = path.join(outDir, "reuse.md");
  const candidatesPath = path.join(outDir, "candidates.json");
  fs.writeFileSync(reusePath, renderReuse({ id, need, queries, candidates: cands, channels: reports, decision: decision.text }));
  fs.writeFileSync(
    candidatesPath,
    JSON.stringify({ id, need, generatedAt: now.toISOString(), queries, channels: reports, decision, candidates: cands }, null, 2) + "\n",
  );

  const chans = reports.filter((r) => !r.channel.startsWith("llm") && r.channel !== "harvest");
  const okN = chans.filter((r) => r.status === "ok").length;
  const top = cands[0];
  const harvested = cands.filter((c) => c.harvest?.files.length);
  const summary = [
    `scout ${id}: ${cands.length} candidates, ${okN}/${chans.length} channels ok${chans.filter((r) => r.status === "failed").length ? ` (failed: ${chans.filter((r) => r.status === "failed").map((r) => r.channel).join(", ")})` : ""}`,
    top ? `top: ${top.name} (${top.sources.join("+")}, score ${top.score}, license ${top.license ?? "none"}${top.adaptable ? "" : " ⚠"})` : "top: none",
    `harvest: ${harvested.length ? harvested.map((c) => `${c.repo} (${c.harvest!.files.length} files)`).join(", ") : opts.clone === false ? "skipped (--no-clone)" : "nothing"}`,
    decision.text.split("\n")[0]!.slice(0, 160),
    `queries: ${queries.map((q) => `"${q}"`).join(", ")}`,
  ];
  return { id, need, dir: outDir, reusePath, candidatesPath, queries, candidates: cands, channels: reports, decision, summary };
}
