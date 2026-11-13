// Tests for receipt.mjs. Run: node --test "skills/m-verify/scripts/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
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
const receipt = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
const tree = (cwd) => {
  const r = receipt(cwd, "tree");
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// Fresh repo per test: one tracked file, one commit.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "receipt-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}
const write = (dir, level, exit = 0, cmd = `check-L${level}`) =>
  receipt(dir, "write", "--level", String(level), "--cmd", cmd, "--exit", String(exit));

test("no receipt: check fails and names required level, level found and a command", () => {
  const dir = repo();
  const r = receipt(dir, "check", "--required", "3");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = r.stdout + r.stderr;
  assert.match(out, /L3/);
  assert.match(out, /no receipt|found L-|none/i);
  assert.match(out, /receipt\.mjs"? write/);
});

test("write L3 then check required 3 passes", () => {
  const dir = repo();
  assert.equal(write(dir, 3).status, 0);
  const r = receipt(dir, "check", "--required", "3");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("receipt file is .mstack/verify/receipts/<tree>.json with the documented shape", () => {
  const dir = repo();
  const t = tree(dir);
  assert.equal(write(dir, 2, 0, "node --test").status, 0);
  const file = join(dir, ".mstack", "verify", "receipts", `${t}.json`);
  assert.ok(existsSync(file), `missing ${file}`);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(doc.tree, t);
  assert.equal(doc.level, 2);
  assert.deepEqual(doc.checks.map((c) => [c.level, c.cmd, c.exit]), [[2, "node --test", 0]]);
  assert.ok(doc.ts);
});

test("editing a tracked file invalidates the receipt", () => {
  const dir = repo();
  write(dir, 3);
  writeFileSync(join(dir, "a.txt"), "two\n");
  assert.equal(receipt(dir, "check", "--required", "3").status, 1);
});

test("adding an untracked file invalidates the receipt", () => {
  const dir = repo();
  write(dir, 3);
  writeFileSync(join(dir, "new.txt"), "x\n");
  assert.equal(receipt(dir, "check", "--required", "3").status, 1);
});

test("write L1 then check required 3 fails", () => {
  const dir = repo();
  write(dir, 1);
  const r = receipt(dir, "check", "--required", "3");
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /L3/);
  assert.match(r.stdout + r.stderr, /L1/);
});

test("a failed check at level N caps the receipt at N-1", () => {
  const dir = repo();
  write(dir, 1);
  write(dir, 2);
  write(dir, 3, 1);
  const t = tree(dir);
  const doc = JSON.parse(readFileSync(join(dir, ".mstack", "verify", "receipts", `${t}.json`), "utf8"));
  assert.equal(doc.level, 2);
  assert.equal(doc.checks.length, 3);
  assert.equal(receipt(dir, "check", "--required", "3").status, 1);
  assert.equal(receipt(dir, "check", "--required", "2").status, 0);
});

test("a lone failing check proves nothing; the same command passing later replaces it", () => {
  const dir = repo();
  write(dir, 2, 1);
  const t = tree(dir);
  const doc = JSON.parse(readFileSync(join(dir, ".mstack", "verify", "receipts", `${t}.json`), "utf8"));
  assert.ok(doc.level < 0, "no passing check, so no level is proven");
  assert.equal(receipt(dir, "check", "--required", "0").status, 1);
  assert.equal(receipt(dir, "check", "--required", "2").status, 1);
  write(dir, 2, 0);
  assert.equal(receipt(dir, "check", "--required", "2").status, 0);
});

test("check without --required uses the project's `Required level: L<n>` line, else 1", () => {
  const dir = repo();
  write(dir, 1);
  assert.equal(receipt(dir, "check").status, 0, "default required level is 1");
  mkdirSync(join(dir, ".claude", "skills", "verify"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "verify", "SKILL.md"), "---\nname: x-verify\n---\n\n# Verify x\n\nRequired level: L3\n");
  // the new file changes the tree: write again at L1 so only the required level differs
  write(dir, 1);
  const r = receipt(dir, "check");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /L3/);
});

test("two consecutive tree calls on an untouched checkout match (CRLF file, autocrlf on)", () => {
  const dir = repo();
  git(dir, "config", "core.autocrlf", "true");
  writeFileSync(join(dir, "win.txt"), "line1\r\nline2\r\n");
  const first = tree(dir);
  const second = tree(dir);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{40}$/);
});

test("writing a receipt or any file under .mstack/ does not change the hash", () => {
  const dir = repo();
  const before = tree(dir);
  write(dir, 2);
  mkdirSync(join(dir, ".mstack", "other"), { recursive: true });
  writeFileSync(join(dir, ".mstack", "other", "note.md"), "x\n");
  assert.equal(tree(dir), before);
  assert.equal(receipt(dir, "check", "--required", "2").status, 0);
});

test("tree never touches the real index: staged stays staged, unstaged stays unstaged", () => {
  const dir = repo();
  writeFileSync(join(dir, "staged.txt"), "s\n");
  git(dir, "add", "staged.txt");
  writeFileSync(join(dir, "unstaged.txt"), "u\n");
  writeFileSync(join(dir, "a.txt"), "modified\n");
  const before = git(dir, "status", "--porcelain");
  const indexBefore = readFileSync(join(dir, ".git", "index"));
  tree(dir);
  assert.equal(git(dir, "status", "--porcelain"), before);
  assert.ok(indexBefore.equals(readFileSync(join(dir, ".git", "index"))));
  assert.match(before, /^A  staged\.txt/m);
  assert.match(before, /^\?\? unstaged\.txt/m);
  // no temp index left behind
  assert.deepEqual(readdirSync(join(dir, ".git")).filter((f) => /^index\./.test(f) || /receipt/.test(f)), []);
});

test("outside a git repo, tree and check exit 2 without a stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "receipt-nogit-"));
  for (const sub of [["tree"], ["check", "--required", "1"]]) {
    const r = receipt(dir, ...sub);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/);
  }
});
