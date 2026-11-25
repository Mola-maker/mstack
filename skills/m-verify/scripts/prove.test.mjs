import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, prove } from "./prove.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "prove-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "add.mjs"), "export const add = (a, b) => a - b;\n");
  g("add", "-A");
  g("commit", "-qm", "buggy");
  g("checkout", "-qb", "fix");
  return { dir, g };
}

const CMD = "node --test test/add.test.mjs";
const TEST = 'import test from "node:test"; import assert from "node:assert"; import { add } from "../add.mjs"; test("adds", () => assert.equal(add(2, 3), 5));\n';

test("proved: the new test fails on the base and passes with the fix", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "add.mjs"), "export const add = (a, b) => a + b;\n");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "add.test.mjs"), TEST);
  const r = prove({ cmd: CMD, tests: [], timeoutMs: 60000 }, dir);
  assert.equal(r.verdict, "proved", JSON.stringify(r));
  assert.deepEqual(r.tests, ["test/add.test.mjs"]);
  assert.equal(r.exit, 0);
});

test("not proved: a test that passes on the base catches nothing", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "add.mjs"), "export const add = (a, b) => a + b;\n");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "add.test.mjs"), 'import test from "node:test"; test("trivial", () => {});\n');
  const r = prove({ cmd: CMD, tests: [], timeoutMs: 60000 }, dir);
  assert.equal(r.verdict, "base-passed");
  assert.equal(r.exit, 1);
});

test("not proved: the fix does not make it pass", () => {
  const { dir } = repo();
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "add.test.mjs"), TEST);
  const r = prove({ cmd: CMD, tests: [], timeoutMs: 60000 }, dir);
  assert.equal(r.verdict, "head-failed");
});

test("args: --cmd required, unknown flags refused", () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["--cmd", "x", "--nope"]), /unknown/);
  assert.deepEqual(parseArgs(["--cmd", "x", "--tests", "a", "--tests", "b"]).tests, ["a", "b"]);
});
