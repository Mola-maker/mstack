// Hardening cases for receipt.mjs (review findings). Run: node --test "skills/m-verify/scripts/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./receipt.mjs", import.meta.url));

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
const receipt = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const tree = (cwd) => {
  const r = receipt(cwd, "tree");
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "receipt-h-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}
const tmpDir = (dir) => join(dir, ".git", "mstack-tmp");
const leftovers = (dir) => (existsSync(tmpDir(dir)) ? readdirSync(tmpDir(dir)) : []);
const receiptPath = (dir, t) => join(dir, ".mstack", "verify", "receipts", `${t}.json`);

// Finding 1: git's per-file CRLF warnings must not overflow a buffer and kill git.
test("autocrlf=true with thousands of LF files: tree still succeeds", (t) => {
  const dir = repo();
  git(dir, "config", "core.autocrlf", "true");
  const started = Date.now();
  mkdirSync(join(dir, "many"));
  for (let i = 0; i < 5000; i++) {
    writeFileSync(join(dir, "many", `f${i}_${"x".repeat(110)}.txt`), "lf\n");
    if (Date.now() - started > 20000) return t.skip("creating the fixture files took more than 20 s on this machine");
  }
  const r = receipt(dir, "tree");
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stdout.trim(), /^[0-9a-f]{40}$/);
  assert.deepEqual(leftovers(dir), []);
});

// Finding 2: own deadline, temp index under the git dir, stale ones swept.
test("a run that hits its deadline exits 2 naming the timeout and leaves no temp index", () => {
  const dir = repo();
  const r = receipt(dir, "tree", "--timeout-ms", "1");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /timed out after 1 ms/);
  assert.deepEqual(leftovers(dir), []);
});

test("the deadline can come from MSTACK_RECEIPT_TIMEOUT_MS", () => {
  const dir = repo();
  const r = spawnSync(process.execPath, [script, "tree"], { cwd: dir, encoding: "utf8", env: { ...process.env, MSTACK_RECEIPT_TIMEOUT_MS: "1" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /timed out after 1 ms/);
});

// A temp file is stale only when its pid is dead AND it is older than 10 minutes (pids are not shared between WSL and Windows).
const plant = (dir, name, ageMinutes) => {
  mkdirSync(tmpDir(dir), { recursive: true });
  const p = join(tmpDir(dir), name);
  writeFileSync(p, "x");
  const t = new Date(Date.now() - ageMinutes * 60000);
  utimesSync(p, t, t);
};

test("an old temp index of a dead pid is removed (index, .err and .lock); a live pid's is kept", () => {
  const dir = repo();
  for (const n of ["index.99999999", "index.99999999.err", "index.99999999.lock"]) plant(dir, n, 11);
  plant(dir, `index.${process.pid}`, 11);
  tree(dir);
  assert.deepEqual(leftovers(dir), [`index.${process.pid}`]);
});

test("a fresh temp file with a dead pid is kept", () => {
  const dir = repo();
  plant(dir, "index.99999999", 1);
  plant(dir, "index.99999999.lock", 0);
  tree(dir);
  assert.deepEqual(leftovers(dir).sort(), ["index.99999999", "index.99999999.lock"]);
});

test("a run that hits the deadline leaves no .lock of its own behind", () => {
  const dir = repo();
  receipt(dir, "tree", "--timeout-ms", "1");
  assert.deepEqual(leftovers(dir).filter((f) => f.endsWith(".lock")), []);
});

// Finding 4: check recomputes the level from validated checks; write recovers from a malformed receipt.
test("a malformed receipt counts as no receipt for check, and write overwrites it", () => {
  const dir = repo();
  const t = tree(dir);
  mkdirSync(join(dir, ".mstack", "verify", "receipts"), { recursive: true });
  writeFileSync(receiptPath(dir, t), JSON.stringify({ tree: t, checks: "x", level: 5 }));
  const c = receipt(dir, "check", "--required", "5");
  assert.equal(c.status, 1, c.stdout + c.stderr);
  assert.match(c.stdout, /malformed/);
  const w = receipt(dir, "write", "--level", "1", "--cmd", "npm test", "--exit", "0");
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.equal(receipt(dir, "check", "--required", "1").status, 0);
  assert.equal(receipt(dir, "check", "--required", "2").status, 1);
});

test("a hand-raised level field is ignored: the level comes from the checks", () => {
  const dir = repo();
  const t = tree(dir);
  mkdirSync(join(dir, ".mstack", "verify", "receipts"), { recursive: true });
  writeFileSync(receiptPath(dir, t), JSON.stringify({ tree: t, level: 5, checks: [{ level: 1, cmd: "build", exit: 0, log: null }] }));
  assert.equal(receipt(dir, "check", "--required", "5").status, 1);
  assert.equal(receipt(dir, "check", "--required", "1").status, 0);
});

test("checks with invalid entries make the receipt malformed", () => {
  const dir = repo();
  const t = tree(dir);
  mkdirSync(join(dir, ".mstack", "verify", "receipts"), { recursive: true });
  for (const checks of [[null], [{ level: 9, cmd: "x", exit: 0 }], [{ level: 1, cmd: 5, exit: 0 }], [{ level: 1, cmd: "x", exit: "0" }]]) {
    writeFileSync(receiptPath(dir, t), JSON.stringify({ tree: t, level: 1, checks }));
    const c = receipt(dir, "check", "--required", "1");
    assert.equal(c.status, 1, JSON.stringify(checks));
    assert.match(c.stdout, /malformed/);
  }
});

test("a receipt file that is not JSON is malformed, not a crash", () => {
  const dir = repo();
  const t = tree(dir);
  mkdirSync(join(dir, ".mstack", "verify", "receipts"), { recursive: true });
  writeFileSync(receiptPath(dir, t), "{nope");
  assert.equal(receipt(dir, "check", "--required", "1").status, 1);
  assert.equal(receipt(dir, "write", "--level", "1", "--cmd", "c", "--exit", "0").status, 0);
  assert.equal(JSON.parse(readFileSync(receiptPath(dir, t), "utf8")).level, 1);
});
