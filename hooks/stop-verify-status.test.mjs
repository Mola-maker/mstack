// Tests for the verdict file stop-verify.mjs leaves for the status line. Run: node --test "hooks/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("./stop-verify.mjs", import.meta.url));
const receipt = fileURLToPath(new URL("../skills/m-verify/scripts/receipt.mjs", import.meta.url));
const git = (cwd, ...args) => assert.equal(spawnSync("git", args, { cwd, encoding: "utf8" }).status, 0, `git ${args.join(" ")}`);

function repo({ gate = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stop-status-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, ".claude", "skills", "verify"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "verify", "SKILL.md"), "# Verify\n\nRequired level: L3\n");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  if (gate) {
    mkdirSync(join(dir, ".mstack", "verify"), { recursive: true });
    writeFileSync(join(dir, ".mstack", "verify", "gate"), "");
  }
  return dir;
}
const stop = (dir) => spawnSync(process.execPath, [hook], { cwd: dir, input: JSON.stringify({ hook_event_name: "Stop", cwd: dir }), encoding: "utf8" });
const status = (dir) => JSON.parse(readFileSync(join(dir, ".mstack", "verify", "status.json"), "utf8"));

test("gate off: no verdict file is written", () => {
  const dir = repo({ gate: false });
  assert.equal(stop(dir).status, 0);
  assert.equal(existsSync(join(dir, ".mstack", "verify", "status.json")), false);
});

test("below the required level: ok false, the same line the user was shown, and a timestamp", () => {
  const dir = repo();
  const shown = JSON.parse(stop(dir).stdout).systemMessage;
  const s = status(dir);
  assert.equal(s.ok, false);
  assert.ok(shown.startsWith(s.message), `${s.message} / ${shown}`);
  assert.match(s.message, /required L3, found no receipt/);
  // the hint with this machine's absolute path stays out of the file
  assert.doesNotMatch(s.message, /receipt\.mjs|; run /);
  assert.ok(Math.abs(Date.now() - Date.parse(s.ts)) < 60_000);
});

test("receipt at the required level: ok true; an edit afterwards turns it false again on the next stop", () => {
  const dir = repo();
  assert.equal(spawnSync(process.execPath, [receipt, "write", "--level", "3", "--cmd", "t", "--exit", "0"], { cwd: dir, encoding: "utf8" }).status, 0);
  const r = stop(dir);
  assert.equal(r.stdout, "");
  assert.equal(status(dir).ok, true);
  writeFileSync(join(dir, "a.txt"), "two\n");
  stop(dir);
  assert.equal(status(dir).ok, false);
});

test("writing the verdict does not void the receipt it reports on", () => {
  const dir = repo();
  spawnSync(process.execPath, [receipt, "write", "--level", "3", "--cmd", "t", "--exit", "0"], { cwd: dir, encoding: "utf8" });
  stop(dir);
  stop(dir);
  assert.equal(status(dir).ok, true);
});

test("the check cannot run: ok null, never true", () => {
  const dir = repo();
  const r = spawnSync(process.execPath, [hook], { cwd: dir, input: JSON.stringify({ cwd: dir }), encoding: "utf8", env: { ...process.env, MSTACK_STOP_VERIFY_TIMEOUT_MS: "1" } });
  assert.equal(r.status, 0);
  const s = status(dir);
  assert.equal(s.ok, null);
  assert.match(s.message, /could not be evaluated/);
});

test("the verdict file is kept out of git: a .gitignore beside it, written once, and an existing one is kept", () => {
  const dir = repo();
  stop(dir);
  stop(dir);
  assert.equal(readFileSync(join(dir, ".mstack", "verify", ".gitignore"), "utf8"), "status.json\n");
  const st = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }).stdout;
  assert.doesNotMatch(st, /status\.json/);

  const other = repo();
  writeFileSync(join(other, ".mstack", "verify", ".gitignore"), "receipts/");
  stop(other);
  assert.equal(readFileSync(join(other, ".mstack", "verify", ".gitignore"), "utf8"), "receipts/\nstatus.json\n");
});
