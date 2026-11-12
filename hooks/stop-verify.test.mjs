// Tests for stop-verify.mjs. Run: node --test "hooks/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("./stop-verify.mjs", import.meta.url));
const receipt = fileURLToPath(new URL("../skills/m-verify/scripts/receipt.mjs", import.meta.url));

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
};
function repo({ gate = true, required = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stop-verify-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, ".claude", "skills", "verify"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "verify", "SKILL.md"), `# Verify\n\nRequired level: L${required}\n`);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  if (gate) {
    mkdirSync(join(dir, ".mstack", "verify"), { recursive: true });
    writeFileSync(join(dir, ".mstack", "verify", "gate"), "");
  }
  return dir;
}
const run = (dir, payload = {}) =>
  spawnSync(process.execPath, [hook], { cwd: dir, input: JSON.stringify({ hook_event_name: "Stop", cwd: dir, ...payload }), encoding: "utf8" });
const writeReceipt = (dir, level) =>
  spawnSync(process.execPath, [receipt, "write", "--level", String(level), "--cmd", "t", "--exit", "0"], { cwd: dir, encoding: "utf8" });

test("gate absent: exit 0, no output", () => {
  const r = run(repo({ gate: false }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("gate on, no receipt: exit 0 with a non-blocking systemMessage naming the level gap and the command", () => {
  const r = run(repo());
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, /L3/);
  assert.match(out.systemMessage, /no receipt/);
  assert.match(out.systemMessage, /receipt\.mjs"? write/);
  for (const k of ["decision", "reason", "continue", "stopReason", "hookSpecificOutput"]) assert.equal(k in out, false, `must not set ${k}`);
});

test("gate on, receipt at the required level: exit 0, no output", () => {
  const dir = repo();
  writeReceipt(dir, 3);
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("gate on, receipt too low: message names found level", () => {
  const dir = repo();
  writeReceipt(dir, 1);
  const out = JSON.parse(run(dir).stdout);
  assert.match(out.systemMessage, /found L1/);
});

test("editing a file after the receipt brings the reminder back", () => {
  const dir = repo();
  writeReceipt(dir, 3);
  writeFileSync(join(dir, "a.txt"), "two\n");
  assert.match(JSON.parse(run(dir).stdout).systemMessage, /L3/);
});

test("stop_hook_active set: exit 0, no output", () => {
  const r = run(repo(), { stop_hook_active: true });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("not a git repo: exit 0, no output", () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-verify-nogit-"));
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("garbage stdin, missing cwd: exit 0, no output", () => {
  const dir = repo();
  for (const input of ["{not json", "", JSON.stringify({ cwd: join(dir, "does-not-exist") })]) {
    const r = spawnSync(process.execPath, [hook], { cwd: dir, input, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.includes("decision"), false);
  }
});

test("hooks.json registers it under Stop with timeout 10", () => {
  const cfg = JSON.parse(readFileSync(new URL("./hooks.json", import.meta.url), "utf8"));
  const h = cfg.hooks.Stop[0].hooks[0];
  assert.ok(h.command.includes('node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-verify.mjs"'), h.command);
  assert.equal(h.timeout, 10);
});
