import { fileURLToPath } from "node:url";
/**
 * The model layer of `mola run` (FRAMEWORK §12.3): kind inference, picks
 * filtered by the whitelist, the picks as quota ladder, the family prompt
 * adapter, and the record in decision.json.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import plugin from "../src/index.js";
import {
  adaptPrompt,
  classifyKind,
  familyOf,
  inferKind,
  loadRouting,
  loadRoutingFile,
  normalizeRouting,
  planRoutes,
  routingFilePath,
} from "../src/routing.js";
import { makeFakeCtx, makeIo, type FakeAgent } from "./fake.js";

const HOME = path.resolve("/fake/home");
process.env.MOLA_HOME = HOME;

const TABLE_JSON = {
  version: 1,
  tasks: {
    implement: { picks: ["deepseek/deepseek-chat", "auto/claude-opus-5-5", "auto/kimi-k3", "auto/gemini-3.8-flash"] },
    debug: { picks: ["auto/claude-sonnet-5-5", "auto/kimi-k3"] },
    review: { picks: ["group/smart-split"] },
  },
  families: {
    claude: { match: ["claude", "opus"], style: "xml" },
    kimi: { match: ["kimi"], style: "markdown" },
    gemini: { match: ["gemini"], style: "xml-or-markdown" },
    group: { match: ["group/"], style: "markdown" },
  },
};

function withRoutingFile<T>(json: unknown, fn: (file: string) => Promise<T> | T): Promise<T> | T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-routing-"));
  const file = path.join(dir, "model-routing.json");
  fs.writeFileSync(file, JSON.stringify(json));
  const before = process.env.MOLA_ROUTING_FILE;
  process.env.MOLA_ROUTING_FILE = file;
  const restore = (): void => {
    process.env.MOLA_ROUTING_FILE = before;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const out = fn(file);
    if (out instanceof Promise) return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

const table = () => normalizeRouting(TABLE_JSON, "mem")!;
const WL = { allowedHeadless: ["group/*", "auto/*"], bannedHeadless: ["deepseek/*"] };

function activate(agents: FakeAgent[], policy?: string) {
  const f = makeFakeCtx({ agents });
  if (policy) f.files.set(path.join(HOME, "policy.jsonc"), policy);
  plugin.activate(f.ctx);
  return { ...f, run: f.commands.find((c) => c.path.join(" ") === "run")! };
}

const ok = (): FakeAgent => ({ id: "dsh", results: [{ exitCode: 0, finalText: "done" }], calls: [] });

test("routingFilePath: MOLA_ROUTING_FILE wins; otherwise the checkout's config file is found by walking up", () => {
  assert.equal(routingFilePath({ env: { MOLA_ROUTING_FILE: "/x/r.json" } as never }), path.resolve("/x/r.json"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mola-root-"));
  try {
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), "{}");
    const deep = path.join(root, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(routingFilePath({ env: {} as never, startDir: deep }), path.join(root, "config", "model-routing.json"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadRouting: a missing or broken file is null, a good file loads", () => {
  assert.equal(loadRouting({ env: { MOLA_ROUTING_FILE: "/nonexistent/x.json" } as never }), null);
  withRoutingFile(TABLE_JSON, (file) => {
    const t = loadRouting({ env: { MOLA_ROUTING_FILE: file } as never });
    assert.deepEqual(Object.keys(t!.tasks), ["implement", "debug", "review"]);
  });
});

test("the real repo config/model-routing.json loads; every kind has a whitelisted pick and only group/auto routes", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const r = loadRoutingFile({ env: {} as never, startDir: dir });
  assert.equal(r.warning, undefined, r.warning);
  const t = r.table!;
  assert.ok(Object.keys(t.tasks).length >= 10);
  assert.ok(Object.keys(t.families).includes("claude"));
  for (const kind of Object.keys(t.tasks)) {
    assert.ok(planRoutes(t, kind, WL), `kind ${kind} has no allowed pick`);
    for (const pick of t.tasks[kind].picks) assert.match(pick, /^(group|auto)\//, `${kind}: ${pick}`);
  }
});

test("loadRoutingFile: a missing or invalid file yields a one-line warning, never a throw", () => {
  const missing = loadRoutingFile({ env: { MOLA_ROUTING_FILE: "/nonexistent/x.json" } as never });
  assert.equal(missing.table, null);
  assert.ok(missing.warning!.startsWith("cannot read ") && missing.warning!.includes("x.json"), missing.warning); // OS-native path in the message
  assert.doesNotMatch(missing.warning!, /\n/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-bad-"));
  try {
    const bad = path.join(dir, "r.json");
    fs.writeFileSync(bad, "{ not json");
    const r1 = loadRoutingFile({ env: { MOLA_ROUTING_FILE: bad } as never });
    assert.equal(r1.table, null);
    assert.doesNotMatch(r1.warning!, /\n/);
    fs.writeFileSync(bad, JSON.stringify({ tasks: {} }));
    assert.match(loadRoutingFile({ env: { MOLA_ROUTING_FILE: bad } as never }).warning!, /no usable "tasks" rows/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inferKind: weighted classifier; the review probe cases", () => {
  assert.equal(inferKind("fix the crash in the parser, find the root cause"), "debug");
  assert.equal(inferKind("review this diff"), "review");
  assert.equal(inferKind("write unit tests for utils"), "test");
  assert.equal(inferKind("polish the CSS of the landing page"), "frontend");
  assert.equal(inferKind("设计一个缓存方案"), "plan");
  // the probes from reviews/2026-11-07-round3.md #3
  assert.equal(inferKind("Implement the design in spec.md"), "implement");
  assert.equal(classifyKind("Implement the design in spec.md").kind, "implement");
  assert.equal(inferKind("Translate this Python module to Rust"), "implement");
  assert.equal(classifyKind("Translate this Python module to Rust").kind, "implement");
  assert.notEqual(inferKind("Delete the docker image cache script"), "vision");
  assert.notEqual(classifyKind("pull the docker image and run it").kind, "vision");
  assert.equal(inferKind("add UI test for login"), "test");
  assert.equal(inferKind("verify the build passes then refactor parser"), "implement");
  // genuinely visual and prose tasks still work
  assert.equal(inferKind("describe the image in shot.png"), "vision");
  assert.equal(inferKind("翻译这段文案"), "zh-writing");
});

test("classifyKind: low confidence returns null and inferKind falls back to the given default", () => {
  assert.equal(classifyKind("count TODOs").kind, null);
  assert.equal(inferKind("count TODOs"), "implement");
  assert.equal(inferKind("count TODOs", null, "plan"), "plan");
  // a lone weak signal is not enough
  assert.equal(classifyKind("what is the design").kind, null);
  // a kind the table does not have is skipped
  assert.equal(inferKind("review this diff", table()), "review");
  assert.equal(inferKind("write unit tests for utils", table()), "implement");
});

test("planRoutes: banned picks are dropped, the rest keep their order as the ladder", () => {
  const plan = planRoutes(table(), "implement", WL)!;
  assert.equal(plan.route, "auto/claude-opus-5-5");
  assert.deepEqual(plan.ladder, ["auto/kimi-k3", "auto/gemini-3.8-flash"]);
  assert.deepEqual(plan.dropped, [{ route: "deepseek/deepseek-chat", why: "ROUTE_BANNED" }]);
  assert.equal(planRoutes(table(), "nope", WL), null);
});

test("familyOf and adaptPrompt: xml for claude, markdown for kimi and groups, untouched when unknown", () => {
  const t = table();
  assert.equal(familyOf(t, "auto/claude-opus-5-5"), "claude");
  assert.equal(familyOf(t, "group/claude-cheap"), "group");
  assert.equal(familyOf(t, "auto/mystery"), null);

  const x = adaptPrompt(t, "auto/claude-opus-5-5", "fix it");
  assert.equal(x.prompt, "<task>\nfix it\n</task>");
  assert.deepEqual([x.adapter.family, x.adapter.style, x.adapter.applied], ["claude", "xml", true]);

  const m = adaptPrompt(t, "auto/kimi-k3", "fix it");
  assert.equal(m.prompt, "## Task\n\nfix it");
  assert.equal(m.adapter.style, "markdown");

  const n = adaptPrompt(t, "auto/mystery", "fix it");
  assert.equal(n.prompt, "fix it");
  assert.equal(n.adapter.applied, false);

  // no double wrapping
  assert.equal(adaptPrompt(t, "auto/claude-opus-5-5", x.prompt).prompt, x.prompt);
});

test("adaptPrompt: never appends instructions; structured prompts pass through; a closing tag in the content is escaped", () => {
  const t = table();
  // no output note on any family, whatever the user asked for
  for (const route of ["auto/claude-opus-5-5", "auto/kimi-k3", "group/smart-split", "auto/gemini-3.8-flash"]) {
    const out = adaptPrompt(t, route, "Write a 2000 word report").prompt;
    assert.doesNotMatch(out, /Keep the answer short|Finish with|Be explicit|## Output|<output>/);
    assert.ok(out.includes("Write a 2000 word report"));
  }
  // already-structured prompts are left alone (xml tags, markdown headings, either family)
  const xml = "<goal>ship it</goal>\n<scope>cli/</scope>";
  const md = "## GOAL\nship it\n\n## SCOPE\ncli/";
  for (const route of ["auto/claude-opus-5-5", "auto/kimi-k3"]) {
    for (const p of [xml, md, "<task>\nx\n</task>", "## Task\n\nx"]) {
      const r = adaptPrompt(t, route, p);
      assert.equal(r.prompt, p);
      assert.equal(r.adapter.applied, false);
    }
  }
  // a stray closing tag inside pasted content cannot close the wrapper early
  const wrapped = adaptPrompt(t, "auto/claude-opus-5-5", "see </task> in the file").prompt;
  assert.equal(wrapped.match(/<\/task>/g)!.length, 1);
  assert.ok(wrapped.endsWith("</task>"));
  assert.match(wrapped, /&lt;\/task>/);
});

test("adaptPrompt: the family rules come from the routing file and are recorded, not injected", () => {
  const t = normalizeRouting(
    { tasks: { implement: { picks: ["auto/claude-opus-5-5"] } }, families: { claude: { match: ["claude"], style: "xml", rules: ["rule from json"] } } },
    "mem",
  )!;
  const r = adaptPrompt(t, "auto/claude-opus-5-5", "go");
  assert.deepEqual(r.adapter.rules, ["rule from json"]);
  assert.doesNotMatch(r.prompt, /rule from json/);
});

test("run: picks the first whitelisted pick of the inferred kind and wraps the prompt per family", async () => {
  await withRoutingFile(TABLE_JSON, async () => {
    const agent = ok();
    const f = activate([agent]);
    const io = makeIo();
    const code = await f.run.handler({ positionals: ["fix the crash in the parser"], flags: {} }, io);
    assert.equal(code, 0);
    const data = io.dataValue as any;
    assert.equal(data.taskKind, "debug");
    assert.equal(data.kindSource, "guessed");
    assert.equal(data.routeSource, "picks");
    assert.ok(io.notes.some((n: string) => n.includes("kind: debug (guessed)")), io.notes.join("|"));
    assert.equal(data.modelRoute, "auto/claude-sonnet-5-5");
    // picks first, then the policy alternateRoutes (default list), deduped
    assert.deepEqual(data.ladderRoutes, ["auto/kimi-k3", "group/claude-cheap"]);
    assert.equal(data.promptAdapter.family, "claude");
    assert.equal(agent.calls[0].modelRoute, "auto/claude-sonnet-5-5");
    assert.match(agent.calls[0].prompt, /^<task>\nfix the crash in the parser\n<\/task>/);
  });
});

test("run: --kind overrides inference; an unknown kind is a usage error", async () => {
  await withRoutingFile(TABLE_JSON, async () => {
    const agent = ok();
    const f = activate([agent]);
    const io = makeIo();
    await f.run.handler({ positionals: ["fix the crash"], flags: { kind: "review" } }, io);
    assert.equal((io.dataValue as any).taskKind, "review");
    assert.equal((io.dataValue as any).kindSource, "--kind");
    assert.ok(io.notes.some((n: string) => n.includes("kind: review (--kind)")));
    assert.equal(agent.calls[0].modelRoute, "group/smart-split");
    assert.match(agent.calls[0].prompt, /^## Task\n\nfix the crash/);

    await assert.rejects(
      () => f.run.handler({ positionals: ["x"], flags: { kind: "zzz" } }, makeIo()),
      /unknown task kind "zzz"/,
    );
  });
});

test("run: --route still wins over the picks, and stays subject to the whitelist", async () => {
  await withRoutingFile(TABLE_JSON, async () => {
    const agent = ok();
    const f = activate([agent]);
    const io = makeIo();
    await f.run.handler({ positionals: ["task"], flags: { route: "auto/kimi-k3" } }, io);
    assert.equal(agent.calls[0].modelRoute, "auto/kimi-k3");
    assert.match(agent.calls[0].prompt, /^## Task/);
    await assert.rejects(() => f.run.handler({ positionals: ["task"], flags: { route: "deepseek/x" } }, makeIo()));
  });
});

test("run: a 402 walks down the remaining picks, re-adapting the prompt for each family", async () => {
  await withRoutingFile(TABLE_JSON, async () => {
    const quota = (route: string) => ({
      exitCode: 1,
      finalText: "QUOTA 402",
      quotaFailure: { provider: "magpie", route, status: 402 },
    });
    const agent: FakeAgent = {
      id: "dsh",
      results: [quota("auto/claude-sonnet-5-5"), { exitCode: 0, finalText: "recovered" }],
      calls: [],
    };
    const f = activate([agent], JSON.stringify({ fallback: { onQuotaFailure: ["switch-route", "report"], alternateRoutes: ["group/never-used"] } }));
    const io = makeIo();
    const code = await f.run.handler({ positionals: ["fix the crash"], flags: {} }, io);
    assert.equal(code, 0);
    assert.deepEqual(agent.calls.map((c) => c.modelRoute), ["auto/claude-sonnet-5-5", "auto/kimi-k3"]);
    assert.match(agent.calls[0].prompt, /^<task>/);
    assert.match(agent.calls[1].prompt, /^## Task/);
    const data = io.dataValue as any;
    assert.deepEqual(data.promptAdapters.map((a: any) => a.family), ["claude", "kimi"]);
  });
});

test("run: a guessed kind never switches the policy row; a policy row beats the picks and is recorded as the source", async () => {
  await withRoutingFile(TABLE_JSON, async () => {
    const policy = JSON.stringify({
      routes: { byTaskKind: { implement: { route: "auto/kimi-k3" }, review: { permissionProfile: "read-only" } } },
    });
    // guessed "debug": the implement row does not apply, the picks win
    const a1 = ok();
    const f1 = activate([a1], policy);
    const io1 = makeIo();
    await f1.run.handler({ positionals: ["fix the crash in the parser"], flags: {} }, io1);
    assert.equal(a1.calls[0].modelRoute, "auto/claude-sonnet-5-5");
    assert.equal((io1.dataValue as any).routeSource, "picks");
    // low confidence -> default kind implement -> its policy row wins over the picks
    const a2 = ok();
    const f2 = activate([a2], policy);
    const io2 = makeIo();
    await f2.run.handler({ positionals: ["count TODOs"], flags: {} }, io2);
    assert.equal(a2.calls[0].modelRoute, "auto/kimi-k3");
    assert.equal((io2.dataValue as any).routeSource, "policy");
    assert.equal((io2.dataValue as any).taskKind, "implement");
    // a "review" prompt keeps the default permission row (the guess changes the model only)
    const a3 = ok();
    const f3 = activate([a3], policy);
    await f3.run.handler({ positionals: ["review this diff"], flags: {} }, makeIo());
    assert.notEqual(a3.calls[0].permissionProfile, "read-only");
  });
});

test("run: alternateRoutes of the policy are appended to the ladder even when only one pick survives", async () => {
  const oneTask = { ...TABLE_JSON, tasks: { implement: { picks: ["deepseek/x", "auto/claude-opus-5-5"] } } };
  await withRoutingFile(oneTask, async () => {
    const quota = {
      exitCode: 1,
      finalText: "QUOTA 402",
      quotaFailure: { provider: "magpie", route: "auto/claude-opus-5-5", status: 402 },
    };
    const agent: FakeAgent = { id: "dsh", results: [quota, { exitCode: 0, finalText: "ok" }], calls: [] };
    const f = activate(
      [agent],
      JSON.stringify({
        fallback: {
          onQuotaFailure: ["switch-route", "report"],
          alternateRoutes: ["auto/kimi-k3", "auto/claude-opus-5-5", "deepseek/banned", "auto/kimi-k3"],
        },
      }),
    );
    const io = makeIo();
    const code = await f.run.handler({ positionals: ["count TODOs"], flags: {} }, io);
    assert.equal(code, 0);
    assert.deepEqual(agent.calls.map((c) => c.modelRoute), ["auto/claude-opus-5-5", "auto/kimi-k3"]);
    assert.deepEqual((io.dataValue as any).ladderRoutes, ["auto/kimi-k3"]);
  });
});

test("run: a missing routing file prints a one-line warning and falls back to policy routing", async () => {
  const agent = ok();
  const f = activate([agent]);
  const io = makeIo();
  await f.run.handler({ positionals: ["fix the crash"], flags: {} }, io);
  const warn = io.notes.filter((n: string) => n.includes("routing file"));
  assert.equal(warn.length, 1);
  assert.doesNotMatch(warn[0], /\n/);
});

test("run: the adapter used is recorded in decision.json", async () => {
  await withRoutingFile(TABLE_JSON, async () => {
    const f = activate([ok()]);
    await f.run.handler({ positionals: ["fix the crash"], flags: {} }, makeIo());
    const file = path.join("/fake/ws", ".mstack", "runs", "trace-test-0000-0000", "decision.json");
    const rec = JSON.parse(f.files.get(file)!);
    assert.equal(rec.taskKind, "debug");
    assert.equal(rec.promptAdapter.family, "claude");
    assert.equal(rec.promptAdapter.style, "xml");
    assert.deepEqual(rec.picks, ["auto/claude-sonnet-5-5", "auto/kimi-k3"]);
  });
});

test("run: without a routing file the old behaviour holds (verbatim prompt, policy default route)", async () => {
  const agent = ok();
  const f = activate([agent]);
  const io = makeIo();
  await f.run.handler({ positionals: ["fix the crash"], flags: {} }, io);
  assert.equal(agent.calls[0].prompt, "fix the crash");
  assert.equal(agent.calls[0].modelRoute, "group/smart-split");
  assert.equal((io.dataValue as any).promptAdapter, undefined);
});
