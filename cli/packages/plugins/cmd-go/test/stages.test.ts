import test from "node:test";
import assert from "node:assert/strict";
import { asksToShip, isVague, selectStages, wordCount } from "../src/stages.js";
import { buildStagePrompt, parseStatus } from "../src/prompts.js";
import { normalizeGoArgs } from "../src/index.js";
import { mintRunId } from "../src/engine.js";

test("a concrete intent runs plan → implement → verify → review (no think, no ship)", () => {
  assert.deepEqual(selectStages("fix the login bug in src/auth.ts so tokens refresh"), ["plan", "implement", "verify", "review"]);
});

test("a vague intent gets a think stage first", () => {
  assert.deepEqual(selectStages("make it better"), ["think", "plan", "implement", "verify", "review"]);
});

test("ship only with --until ship or when the intent asks for it", () => {
  assert.ok(!selectStages("add a retry flag to the fetch helper").includes("ship"));
  assert.ok(selectStages("add a retry flag to the fetch helper and open a PR").includes("ship"));
  assert.ok(selectStages("给 cmd-run 加个重试参数然后提PR").includes("ship"));
  assert.ok(selectStages("fix the typo in README.md, push it").includes("ship"));
  assert.deepEqual(selectStages("add a retry flag to the fetch helper", "ship"), ["plan", "implement", "verify", "review", "ship"]);
});

test("--until caps the run; unselected stages are simply absent", () => {
  assert.deepEqual(selectStages("fix the login bug", "plan"), ["plan"]);
  assert.deepEqual(selectStages("fix the login bug", "verify"), ["plan", "implement", "verify"]);
  // an explicit cap beats the intent asking for a PR
  assert.ok(!selectStages("fix the login bug and open a PR", "review").includes("ship"));
  assert.deepEqual(selectStages("fix the login bug", "think"), ["think"]);
});

test("vague heuristic: short and nothing to act on", () => {
  for (const v of ["make it better", "improve things", "clean up", "优化一下", "do the thing", ""]) assert.equal(isVague(v), true, v);
  for (const c of [
    "fix the login bug",
    "update README.md",
    "run `pnpm test` and fix failures",
    "mola run is slow",
    "修复登录页面的报错",
    "refactor src/engine.ts",
    "write a long enough sentence that clearly has many words in it",
  ]) assert.equal(isVague(c), false, c);
});

test("word count: CJK characters count half a word", () => {
  assert.equal(wordCount("fix the bug"), 3);
  assert.equal(wordCount("修复登录报错"), 3);
});

test("asksToShip", () => {
  for (const s of ["ship it", "open a pull request", "create a PR", "推送到远端", "帮我提PR"]) assert.equal(asksToShip(s), true, s);
  for (const s of ["fix the bug", "review the pull request comments", "shipping container parser"]) assert.equal(asksToShip(s), false, s);
});

test("STATUS line: parsed, last one wins, missing counts as failed", () => {
  assert.deepEqual(parseStatus("work\nSTATUS: done 3 files changed"), { status: "done", summary: "3 files changed", found: true });
  assert.equal(parseStatus("STATUS: failed a\nmore\nSTATUS: blocked need creds").status, "blocked");
  const missing = parseStatus("I did it, all good");
  assert.equal(missing.status, "failed");
  assert.equal(missing.found, false);
  assert.equal(parseStatus("**STATUS: done** shipped").status, "done");
});

test("stage prompt names intent, run dir, previous artifacts, artifact and the STATUS contract", () => {
  const p = buildStagePrompt({ stage: "verify", intent: "fix X", dir: ".mstack/runs/go-1", previous: ["plan.md", "implement.md"] });
  assert.match(p, /Intent: fix X/);
  assert.match(p, /\.mstack\/runs\/go-1\/plan\.md/);
  assert.match(p, /\.mstack\/runs\/go-1\/verify\.md/);
  assert.match(p, /STATUS: done\|failed\|blocked/);
  assert.match(p, /exact command/);
  const r = buildStagePrompt({ stage: "implement", intent: "fix X", dir: "d", previous: ["plan.md"], retryFrom: "verify.md" });
  assert.match(r, /d\/verify\.md/);
  assert.match(buildStagePrompt({ stage: "review", intent: "i", dir: "d", previous: [] }), /FINDING[\s\S]*CLEARED/);
});

test("--auto before the intent does not swallow it", () => {
  const n = normalizeGoArgs({ positionals: [], flags: { auto: "fix the bug" } });
  assert.deepEqual(n.positionals, ["fix the bug"]);
  assert.equal(n.flags.auto, true);
});

test("run id: go-yyyymmdd-hhmm-4hex", () => {
  assert.match(mintRunId(), /^go-\d{8}-\d{4}-[0-9a-f]{4}$/);
  assert.equal(mintRunId(new Date(2026, 10, 8, 9, 5), () => "abcd"), "go-20261108-0905-abcd");
});
