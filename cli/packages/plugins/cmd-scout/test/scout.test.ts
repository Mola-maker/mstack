import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { parsePagedArrays } from "../src/channels.js";
import { classifyLicense, deriveQueries, extractKeywords, scout, scoreCandidate } from "../src/index.js";
import { rankPaths } from "../src/harvest.js";
import type { Candidate, ExecFn, FetchFn, ScoutDeps } from "../src/index.js";

const NOW = new Date("2026-11-08T10:30:00");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "scout-"));

type Calls = { exec: { cmd: string; args: string[] }[]; fetch: { url: string; headers?: Record<string, string> }[] };

function mk(opts: {
  exec?: (cmd: string, args: string[]) => { stdout?: string; stderr?: string; code?: number } | undefined;
  fetchJson?: (url: string) => unknown;
  model?: (p: string) => Promise<string>;
}): { deps: ScoutDeps; calls: Calls } {
  const calls: Calls = { exec: [], fetch: [] };
  const exec: ExecFn = async (cmd, args) => {
    calls.exec.push({ cmd, args });
    const r = opts.exec?.(cmd, args);
    if (r) return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
    return { stdout: "", stderr: "", code: cmd === "gh" ? 1 : 0 };
  };
  const fetch: FetchFn = async (url, init) => {
    calls.fetch.push({ url, headers: init?.headers });
    const body = opts.fetchJson?.(url);
    if (body === undefined) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return {
    deps: { exec, fetch, clock: () => NOW, model: opts.model ?? (async () => ""), randHex: () => "abcd" },
    calls,
  };
}

const ghRepo = (fullName: string, stars: number, license: string | null, extra: object = {}) => ({
  fullName,
  description: "terminal dashboard with live log tail",
  stargazersCount: stars,
  pushedAt: "2026-10-01T00:00:00Z",
  license: license ? { key: license.toLowerCase(), name: license } : null,
  url: `https://github.com/${fullName}`,
  ...extra,
});

const base = (cwd: string, extra: object = {}) => ({ cwd, homeDir: cwd, seedTsv: path.join(cwd, "none.tsv"), clone: false, llm: false, ...extra });

test("query extraction: English, Chinese, mixed", () => {
  const en = extractKeywords("terminal UI dashboard with live log tail, zero dependencies");
  assert.deepEqual(en.slice(0, 6), ["terminal", "ui", "dashboard", "live", "log", "tail"]);
  assert.ok(!en.includes("with") && !en.includes("zero") && !en.includes("dependencies"));
  const zh = extractKeywords("需要一个终端日志实时查看工具");
  assert.ok(zh.length >= 1 && zh.every((w) => /[㐀-鿿]/.test(w)), JSON.stringify(zh));
  assert.ok(!zh.includes("需要") && !zh.includes("一个"));
  const mixed = extractKeywords("用 rust 写一个 websocket 代理服务");
  assert.ok(mixed.includes("rust") && mixed.includes("websocket"));
  assert.ok(mixed.some((w) => /[㐀-鿿]/.test(w)));
  const qs = deriveQueries("terminal UI dashboard with live log tail, zero dependencies");
  assert.ok(qs.length >= 2 && qs.length <= 4, JSON.stringify(qs));
  assert.equal(qs[0], "terminal ui dashboard live");
  assert.ok(deriveQueries("parser").length >= 2);
});

test("license classification", () => {
  for (const l of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "0BSD", "Unlicense"]) assert.equal(classifyLicense(l).cls, "ok", l);
  assert.equal(classifyLicense("MPL-2.0").cls, "note");
  for (const l of ["GPL-3.0", "AGPL-3.0", "GPL-2.0-only", "", undefined, "NOASSERTION", "WTFPL"]) assert.equal(classifyLicense(l).cls, "flag", String(l));
});

test("scoring order: local > starred > stars", () => {
  const mkc = (p: Partial<Candidate>): Candidate => ({
    key: "k", kind: "repo", name: "n", url: "u", sources: ["github-repos"], licenseClass: "ok", adaptable: true, starred: false, why: [], score: 0, pushedAt: "2026-10-01T00:00:00Z", ...p,
  });
  const local = scoreCandidate(mkc({ sources: ["local"], kind: "local", hits: ["a:1"], stars: undefined }), NOW, 2, 4);
  const starred = scoreCandidate(mkc({ starred: true, stars: 12 }), NOW, 2, 4);
  const famous = scoreCandidate(mkc({ stars: 200_000 }), NOW, 2, 4);
  assert.ok(local > starred && starred > famous, `${local} ${starred} ${famous}`);
});

test("end to end: ranking, dedupe, license flags, local hits", async () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "logtail.ts"), "function logTail() {}\n");
  fs.writeFileSync(path.join(cwd, "none.tsv"), "");
  const { deps } = mk({
    exec: (cmd, args) => {
      if (cmd === "rg") return { stdout: "./src/logtail.ts:1:function logTail() {} // dashboard\n" };
      if (cmd === "gh" && args[0] === "search" && args[1] === "repos")
        return { stdout: JSON.stringify([ghRepo("Foo/Bar", 5000, "MIT"), ghRepo("gpl/thing", 90000, "GPL-3.0"), ghRepo("nolic/x", 10, null)]) };
      if (cmd === "gh" && args[1] === "code")
        return { stdout: JSON.stringify([{ repository: { nameWithOwner: "foo/bar" }, path: "a.go", url: "u" }]) };
      if (cmd === "gh" && args[0] === "api")
        return { stdout: JSON.stringify([{ full_name: "foo/bar", description: "terminal dashboard log", stargazers_count: 5000, license: { spdx_id: "MIT" }, topics: [] }]) };
      return undefined;
    },
    fetchJson: (url) =>
      url.includes("npmjs")
        ? { objects: [{ package: { name: "bar-cli", description: "dashboard", links: { repository: "git+https://github.com/Foo/Bar.git" } } }] }
        : undefined,
  });
  const r = await scout("terminal dashboard log tail", base(cwd), deps);
  assert.equal(r.candidates[0]!.kind, "local");
  assert.ok(r.candidates[0]!.hits![0]!.endsWith("src/logtail.ts:1"));
  const foo = r.candidates.filter((c) => c.key === "foo/bar");
  assert.equal(foo.length, 1, "dedupe by repo");
  assert.ok(foo[0]!.sources.length >= 3, foo[0]!.sources.join());
  assert.ok(foo[0]!.starred);
  const gpl = r.candidates.find((c) => c.key === "gpl/thing")!;
  assert.equal(gpl.licenseClass, "flag");
  assert.equal(gpl.adaptable, false);
  assert.equal(r.candidates.find((c) => c.key === "nolic/x")!.adaptable, false);
  assert.ok(r.candidates.findIndex((c) => c.key === "foo/bar") < r.candidates.findIndex((c) => c.key === "gpl/thing"));
  const json = JSON.parse(fs.readFileSync(r.candidatesPath, "utf8"));
  assert.equal(json.id, "scout-20261108-1030-abcd");
  assert.ok(r.reusePath.endsWith(path.join(".mstack", "scout", "scout-20261108-1030-abcd", "reuse.md")));
});

test("one failing channel does not abort and is reported", async () => {
  const cwd = tmp();
  const { deps } = mk({
    exec: (cmd, args) => {
      if (cmd === "gh" && args[1] === "repos") return { stdout: JSON.stringify([ghRepo("a/b", 100, "MIT")]) };
      if (cmd === "gh" && args[1] === "code") return { code: 1, stderr: "HTTP 403: API rate limit exceeded" };
      return undefined;
    },
    fetchJson: () => undefined,
  });
  const r = await scout("terminal dashboard", base(cwd), deps);
  const by = Object.fromEntries(r.channels.map((c) => [c.channel, c]));
  assert.equal(by["github-code"]!.status, "failed");
  assert.match(by["github-code"]!.detail, /rate limit/);
  assert.equal(by["github-repos"]!.status, "ok");
  assert.equal(by["npm"]!.status, "failed");
  assert.equal(by["crates"]!.status, "failed");
  assert.ok(r.candidates.some((c) => c.key === "a/b"));
  assert.match(fs.readFileSync(r.reusePath, "utf8"), /- github-code: failed — .*rate limit/);
});

test("rg missing falls back to git grep", async () => {
  const cwd = tmp();
  const { deps, calls } = mk({
    exec: (cmd) => {
      if (cmd === "rg") return { code: 127, stderr: "ENOENT" };
      if (cmd === "git") return { stdout: "src/dash.ts:4:terminal dashboard\n" };
      return undefined;
    },
  });
  const r = await scout("terminal dashboard", base(cwd), deps);
  assert.ok(calls.exec.some((c) => c.cmd === "git" && c.args[0] === "grep"));
  assert.equal(r.channels.find((c) => c.channel === "local")!.status, "ok");
  assert.equal(r.candidates.find((c) => c.kind === "local")!.hits![0]!.split("/").slice(1).join("/"), "src/dash.ts:4");
});

test("starred cache: fresh used, stale refreshes, refresh failure seeds from tsv", async () => {
  const cwd = tmp();
  const cacheFile = path.join(cwd, ".mola", "cache", "starred.json");
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const item = { fullName: "me/dashy", description: "terminal dashboard", stargazersCount: 7 };
  const seed = path.join(cwd, "starred.tsv");
  fs.writeFileSync(seed, "2026-11-06\tseed/dashboard-tui\t99\tterminal dashboard in a seed\n");
  const opts = { cwd, homeDir: cwd, seedTsv: seed, clone: false, llm: false };

  // fresh (23h old): no gh api call, cache used
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date(NOW.getTime() - 23 * 3600e3).toISOString(), items: [item] }));
  let m = mk({});
  let r = await scout("terminal dashboard", opts, m.deps);
  assert.ok(!m.calls.exec.some((c) => c.cmd === "gh" && c.args[0] === "api"));
  assert.ok(r.candidates.some((c) => c.key === "me/dashy"));
  assert.match(r.channels.find((c) => c.channel === "stars")!.detail, /\(cache\)/);

  // stale (25h): refresh via gh api (paged arrays), cache rewritten
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date(NOW.getTime() - 25 * 3600e3).toISOString(), items: [item] }));
  const page = (n: string) => JSON.stringify([{ full_name: n, description: "terminal dashboard [x]", stargazers_count: 3, topics: [] }]);
  m = mk({ exec: (cmd, args) => (cmd === "gh" && args[0] === "api" ? { stdout: page("new/one") + page("new/two") } : undefined) });
  r = await scout("terminal dashboard", opts, m.deps);
  assert.ok(m.calls.exec.some((c) => c.cmd === "gh" && c.args[0] === "api" && c.args.includes("--paginate")));
  assert.ok(r.candidates.some((c) => c.key === "new/two") && !r.candidates.some((c) => c.key === "me/dashy"));
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).items.length, 2);

  // stale + refresh fails: seed from tsv
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date(NOW.getTime() - 48 * 3600e3).toISOString(), items: [item] }));
  m = mk({});
  r = await scout("terminal dashboard", opts, m.deps);
  assert.ok(r.candidates.some((c) => c.key === "seed/dashboard-tui"));
  const d = r.channels.find((c) => c.channel === "stars")!;
  assert.equal(d.status, "ok");
  assert.match(d.detail, /seeded from starred\.tsv/);
});

test("paged gh arrays parse, even with brackets in strings", () => {
  assert.equal(parsePagedArrays('[{"a":"x]["}][{"a":2}]\n[{"a":3}]').length, 3);
});

test("reuse.md has every section; --no-llm marks the decision pending", async () => {
  const cwd = tmp();
  const { deps } = mk({ exec: (cmd, args) => (cmd === "gh" && args[1] === "repos" ? { stdout: JSON.stringify([ghRepo("a/b", 100, "MIT")]) } : undefined) });
  const r = await scout("terminal dashboard", base(cwd), deps);
  const md = fs.readFileSync(r.reusePath, "utf8");
  const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(heads, ["Need", "Queries", "Candidates", "Harvest", "Decision", "Channels"]);
  assert.match(md, /decision: pending \(run without --no-llm or decide by hand\)/);
  assert.match(md, /\| # \| source \| name \| stars \| last push \| license \| why it matched \|/);
  assert.equal(r.decision.status, "pending");
  assert.equal(r.summary.length, 5);
  assert.match(md, /- harvest: skipped — --no-clone/);
});

test("LLM on: queries and decision come from the explore model", async () => {
  const cwd = tmp();
  const prompts: string[] = [];
  const { deps } = mk({
    exec: (cmd, args) => (cmd === "gh" && args[1] === "repos" ? { stdout: JSON.stringify([ghRepo("a/b", 100, "GPL-3.0")]) } : undefined),
    model: async (p) => {
      prompts.push(p);
      return p.includes("search queries") ? 'Sure: ["blessed tui", "ink dashboard"]' : "decision: reuse — a/b fits\npatterns: x.ts:1\nlicense: GPL";
    },
  });
  const r = await scout("terminal dashboard", { ...base(cwd), llm: true }, deps);
  assert.equal(r.queries[0], "blessed tui");
  assert.ok(r.queries.includes("terminal dashboard"));
  assert.equal(r.decision.status, "decided");
  assert.match(fs.readFileSync(r.reusePath, "utf8"), /decision: reuse — a\/b fits[\s\S]*license guard: a\/b/);
  assert.match(prompts[1]!, /FLAGGED/);
  // model failure is soft
  const f = mk({ model: async () => { throw new Error("no model"); } });
  const r2 = await scout("terminal dashboard", { ...base(cwd), llm: true }, f.deps);
  assert.equal(r2.decision.status, "failed");
  assert.deepEqual(r2.queries, deriveQueries("terminal dashboard"));
});

test("crates.io request carries User-Agent mola-scout and no email", async () => {
  const cwd = tmp();
  const { deps, calls } = mk({ fetchJson: () => ({ crates: [{ name: "tui", downloads: 5, repository: "https://github.com/x/tui" }], objects: [] }) });
  const r = await scout("terminal dashboard", base(cwd), deps);
  const c = calls.fetch.find((f) => f.url.startsWith("https://crates.io/api/v1/crates?q="))!;
  assert.equal(c.headers!["User-Agent"], "mola-scout");
  assert.ok(c.url.endsWith("&per_page=10"));
  assert.ok(!JSON.stringify(c.headers).includes("@"));
  assert.ok(calls.fetch.some((f) => f.url.startsWith("https://registry.npmjs.org/-/v1/search?text=") && f.url.endsWith("&size=10")));
  assert.ok(r.candidates.some((x) => x.key === "x/tui"));
});

test("harvest: clones top N sparse, skips repos over 200 MB", async () => {
  const cwd = tmp();
  const { deps, calls } = mk({
    exec: (cmd, args) => {
      if (cmd === "gh" && args[1] === "repos")
        return { stdout: JSON.stringify([ghRepo("big/huge", 90000, "MIT", { size: 300 * 1024 }), ghRepo("ok/small", 500, "MIT", { size: 2048 })]) };
      if (cmd === "git" && args.includes("ls-tree")) return { stdout: "src/dashboard.ts\nREADME.md\nsrc/log-tail.ts\nnode_modules/x/dashboard.js\n" };
      return undefined;
    },
  });
  const r = await scout("terminal dashboard log tail", { ...base(cwd), clone: true, limit: 2 }, deps);
  const clones = calls.exec.filter((c) => c.cmd === "git" && c.args[0] === "clone");
  assert.equal(clones.length, 1, "huge repo is not cloned");
  assert.deepEqual(clones[0]!.args.slice(0, 5), ["clone", "--depth", "1", "--filter=blob:none", "--sparse"]);
  assert.ok(clones[0]!.args.at(-1)!.endsWith(path.join("repos", "ok__small")));
  const big = r.candidates.find((c) => c.key === "big/huge")!;
  assert.match(big.harvest!.note!, /300 MB > 200 MB/);
  const small = r.candidates.find((c) => c.key === "ok/small")!;
  assert.deepEqual(small.harvest!.files.map((f) => f.path).sort(), ["src/dashboard.ts", "src/log-tail.ts"]);
  assert.match(fs.readFileSync(r.reusePath, "utf8"), /src\/dashboard\.ts/);
});

test("rankPaths caps at 8 and drops noise", () => {
  const paths = Array.from({ length: 20 }, (_, i) => `src/dashboard${i}.ts`).concat(["node_modules/dashboard.js", "dashboard.min.js"]);
  const out = rankPaths(paths, ["dashboard"]);
  assert.equal(out.length, 8);
  assert.ok(out.every((p) => !p.includes("node_modules") && !p.includes(".min.")));
});

test("local channel ignores docs and needs several keyword hits", async () => {
  const cwd = tmp();
  const { deps } = mk({
    exec: (cmd) =>
      cmd === "rg"
        ? { stdout: "./notes.md:1:terminal dashboard log tail\n./src/one.ts:2:dashboard only\n./src/tui.ts:3:terminal dashboard log tail\n" }
        : undefined,
  });
  const r = await scout("terminal dashboard log tail", base(cwd), deps);
  assert.deepEqual(r.candidates.filter((c) => c.kind === "local").map((c) => c.name.split("/").slice(1).join("/")), ["src/tui.ts"]);
});
