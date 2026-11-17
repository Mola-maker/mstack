// Block mode of stop-verify.mjs: opt-in, once per turn, never on a broken check, and it gives up after a few in a row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("./stop-verify.mjs", import.meta.url));
const receipt = fileURLToPath(new URL("../skills/m-verify/scripts/receipt.mjs", import.meta.url));
const git = (cwd, ...args) => assert.equal(spawnSync("git", args, { cwd, encoding: "utf8" }).status, 0, `git ${args.join(" ")}`);

function repo(gate) {
  const dir = mkdtempSync(join(tmpdir(), "stop-block-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, ".claude", "skills", "verify"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "verify", "SKILL.md"), "# Verify\n\nRequired level: L3\n");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  mkdirSync(join(dir, ".mstack", "verify"), { recursive: true });
  writeFileSync(join(dir, ".mstack", "verify", "gate"), gate);
  return dir;
}
const run = (dir, payload = {}, env = {}) =>
  spawnSync(process.execPath, [hook], { cwd: dir, input: JSON.stringify({ hook_event_name: "Stop", cwd: dir, ...payload }), encoding: "utf8", env: { ...process.env, ...env } });
const status = (dir) => JSON.parse(readFileSync(join(dir, ".mstack", "verify", "status.json"), "utf8"));
const prove = (dir, level) => spawnSync(process.execPath, [receipt, "write", "--level", String(level), "--cmd", "t", "--exit", "0"], { cwd: dir, encoding: "utf8" });

test("an empty gate or a gate that says anything but `block` only reminds", () => {
  for (const gate of ["", "remind\n", "blocks\n"]) {
    const r = run(repo(gate));
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.decision, undefined, JSON.stringify(gate));
    assert.match(j.systemMessage, /found no receipt/);
  }
});

test("block mode, code below the level: the stop is refused with the gap and what to do", () => {
  const dir = repo("block\n");
  const r = run(dir);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.decision, "block");
  assert.match(j.reason, /found no receipt/);
  assert.match(j.reason, /block mode/);
  assert.equal(j.systemMessage, undefined);
  assert.equal(status(dir).ok, false);
  assert.equal(status(dir).blocks, 1);
});

test("block mode, receipt at the level: silent, and the count goes back to zero", () => {
  const dir = repo("block\n");
  run(dir);
  assert.equal(status(dir).blocks, 1);
  prove(dir, 3);
  const r = run(dir);
  assert.equal(r.stdout, "");
  assert.equal(status(dir).ok, true);
  assert.equal(status(dir).blocks, 0);
});

test("a stop that is already continuing because of a hook is not blocked again", () => {
  const r = run(repo("block\n"), { stop_hook_active: true });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("after the limit in a row it reminds instead, and says why", () => {
  const dir = repo("block\n");
  const env = { MSTACK_STOP_VERIFY_MAX_BLOCKS: "2" };
  assert.equal(JSON.parse(run(dir, {}, env).stdout).decision, "block");
  assert.equal(JSON.parse(run(dir, {}, env).stdout).decision, "block");
  const third = JSON.parse(run(dir, {}, env).stdout);
  assert.equal(third.decision, undefined);
  assert.match(third.systemMessage, /block limit 2 reached; reminding only/);
  assert.equal(status(dir).blocks, 2, "the count stays at the limit");
});

test("a check that cannot run never blocks, even in block mode", () => {
  const dir = repo("block\n");
  const r = run(dir, {}, { MSTACK_STOP_VERIFY_TIMEOUT_MS: "1" });
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.decision, undefined);
  assert.match(j.systemMessage, /could not be evaluated|found no receipt/);
});

test("no gate, no output, block word or not", () => {
  const dir = repo("block\n");
  spawnSync(process.execPath, ["-e", `require("fs").rmSync(${JSON.stringify(join(dir, ".mstack", "verify", "gate"))})`]);
  assert.equal(run(dir).stdout, "");
});
