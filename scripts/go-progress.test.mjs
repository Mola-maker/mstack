// Tests for scripts/go-progress.mjs (the /go command's progress writer).
// The file it writes must match cli/packages/plugin-sdk/src/progress.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./go-progress.mjs", import.meta.url));

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "go-progress-"));
  const env = { ...process.env, MOLA_GO_CWD: cwd };
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { env, encoding: "utf8" }).trim();
  const fail = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  const prog = (id) => JSON.parse(readFileSync(join(cwd, ".mstack", "runs", id, "progress.json"), "utf8"));
  return { cwd, run, fail, prog };
}

test("start writes a schema-1 progress file with chosen and skipped stages", () => {
  const { run, prog, cwd } = setup();
  const id = run("start", "add a ship stage", "--stages", "plan,implement,verify,review,ship");
  assert.match(id, /^go-\d{8}-\d{4}-[0-9a-f]{4}$/);
  const p = prog(id);
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.origin, "claude-code");
  assert.equal(p.cwd, cwd);
  assert.equal(p.stage, "plan");
  assert.deepEqual(p.stages.map((s) => s.status), ["skipped", "skipped", "pending", "pending", "pending", "pending", "pending"]);
});

test("stage and worker updates accumulate cost and status", () => {
  const { run, prog } = setup();
  const id = run("start", "x");
  run("stage", id, "plan", "running", "--model", "auto/claude-opus-5-5");
  run("worker", id, "m-critic-1", "plan", "working", "--model", "opus", "--line", "reading plan");
  run("stage", id, "plan", "done", "--cost", "0.1", "--summary", "3 steps");
  run("stage", id, "implement", "running", "--cost", "0.05");
  run("stage", id, "implement", "running", "--cost", "0.05");
  const p = prog(id);
  assert.equal(p.stage, "implement");
  assert.equal(p.costUsd, 0.2);
  assert.equal(p.stages[2].summary, "3 steps");
  assert.equal(p.workers[0].lastLine, "reading plan");
  run("done", id);
  assert.equal(prog(id).workers[0].status, "done");
});

test("block, check and decide gate a run; a decision cannot be changed", () => {
  const { run, fail, prog } = setup();
  const id = run("start", "ship it");
  const ap = run("block", id, "approve push", "git push origin feat/x");
  assert.equal(prog(id).status, "blocked");
  assert.equal(prog(id).blocked.approvalId, ap);
  assert.equal(run("check", id, ap), "pending");
  run("decide", id, ap, "approve");
  assert.equal(run("check", id, ap), "approved");
  assert.equal(prog(id).status, "running");
  assert.equal(fail("decide", id, ap, "deny").status, 1);
  const ap2 = run("block", id, "approve PR", "gh pr create");
  run("decide", id, ap2, "deny");
  assert.equal(prog(id).status, "stopped");
});

test("rejects unknown stages, bad ids and unknown commands", () => {
  const { run, fail } = setup();
  const id = run("start", "x");
  assert.equal(fail("stage", id, "bogus", "running").status, 1);
  assert.equal(fail("stage", "../etc", "plan", "running").status, 1);
  assert.equal(fail("nope").status, 64);
});
