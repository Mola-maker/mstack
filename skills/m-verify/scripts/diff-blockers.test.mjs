import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./diff-blockers.mjs", import.meta.url));

// One throwaway git repo shared by the run; each test restores the tree it dirtied.
const root = mkdtempSync(join(tmpdir(), "diff-blockers-"));
const git = (...args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
};

git("init", "-q");
git("config", "user.email", "test@example.com");
git("config", "user.name", "test");
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "app.js"), "const x = 1;\nexport default x;\n");
writeFileSync(join(root, "README.md"), "base readme\n");
git("add", "-A");
git("commit", "-qm", "base");
const baseSha = git("rev-list", "--max-parents=0", "HEAD").stdout.trim();

const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });

test("clean diff exits 0 with an OK line", () => {
  writeFileSync(join(root, "src", "app.js"), "const x = 2;\nexport default x;\n");
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK/);
  git("checkout", "-q", "--", ".");
});

test("every blocker marker in an added line fails, with file:line; non-markers stay quiet", () => {
  writeFileSync(join(root, "src", "app.js"), [
    "const x = it.only('one', () => {});", // .only(
    "test.skip('two', () => {});", // .skip(
    "// TODO later", // TODO
    "// FIXME now", // FIXME
    "class NotImplemented {}", // NotImplemented (case-insensitive family)
    "debugger;", // debugger
    "const lonely = x; // the word 'only' inside 'lonely' must NOT match",
  ].join("\n"));
  const r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL — 6 blocker/);
  assert.match(r.stdout, /src\/app\.js:1: \.only\(/);
  assert.match(r.stdout, /src\/app\.js:6: debugger/);
  assert.doesNotMatch(r.stdout, /lonely/);
  git("checkout", "-q", "--", ".");
});

test("'not implemented' matches snake_case and spaced spellings once", () => {
  writeFileSync(join(root, "src", "app.js"), "const a = not_implemented_yet();\nconst b = 'Not Implemented';\n");
  const r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL — 2 blocker/);
  git("checkout", "-q", "--", ".");
});

test("markers in context or removed lines are ignored; an explicit base ref is scanned", () => {
  // Commit the marker, then diff from the base commit in both directions.
  writeFileSync(join(root, "src", "app.js"), "// TODO on the branch\nconst x = 1;\nexport default x;\n");
  git("add", "-A");
  git("commit", "-qm", "dirty");
  const headSha = git("rev-parse", "HEAD").stdout.trim();
  git("checkout", "-q", baseSha); // HEAD = base; worktree = base
  const reversed = run(headSha); // head -> base: the TODO line is REMOVED
  assert.equal(reversed.status, 0, reversed.stdout + reversed.stderr);
  git("checkout", "-q", headSha);
  const forward = run(baseSha); // base -> head: the TODO line is ADDED at line 1
  assert.equal(forward.status, 1, forward.stdout + forward.stderr);
  assert.match(forward.stdout, /src\/app\.js:1: TODO/);
});

test("deleted-file sections do not crash and report no phantom blockers", () => {
  writeFileSync(join(root, "README.md"), "changed readme\n");
  rmSync(join(root, "src", "app.js"));
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  git("checkout", "-q", "--", ".");
});

test("no args means uncommitted changes; a bad ref exits 2", () => {
  writeFileSync(join(root, "src", "app.js"), "const x = 1; // FIXME uncommitted\n");
  const r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  git("checkout", "-q", "--", ".");
  const bad = run("no-such-ref");
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /failed/);
});

test("flags and more than one arg are rejected with the usage line (exit 2)", () => {
  const flag = run("--staged");
  assert.equal(flag.status, 2);
  assert.match(flag.stderr, /Usage:/);
  const two = run("a", "b");
  assert.equal(two.status, 2);
  assert.match(two.stderr, /Usage:/);
});

test("new-side line numbers count across hunks and context", () => {
  writeFileSync(join(root, "src", "app.js"), [
    "const x = 1;",
    "",
    "",
    "",
    "",
    "export default x; // TODO deep",
  ].join("\n"));
  const r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /src\/app\.js:6: TODO/);
  git("checkout", "-q", "--", ".");
});

// Isolated repos: the shared tree above is restored by checkout, and these repros commit.
const cleanEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "diff-blockers-iso-"));
  const g = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r;
  };
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "test");
  writeFileSync(join(dir, "README.md"), "base\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  return { dir, g };
}
const runIn = (dir, ...args) => spawnSync(process.execPath, [script, ...args], {
  cwd: dir, encoding: "utf8", env: cleanEnv,
});

test("untracked it.only is a blocker when git diff HEAD is empty (review repro)", () => {
  const { dir } = makeRepo();
  writeFileSync(join(dir, "new.test.js"), 'it.only("x", () => {});\n');
  const r = runIn(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /new\.test\.js:1: \.only\(/);
  rmSync(dir, { recursive: true, force: true });
});

test("a clean untracked file is not a blocker", () => {
  const { dir } = makeRepo();
  writeFileSync(join(dir, "new.test.js"), 'it("x", () => {});\n');
  const r = runIn(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 untracked file/);
  rmSync(dir, { recursive: true, force: true });
});

test("with a base ref, untracked files are still scanned (base..working tree)", () => {
  const { dir, g } = makeRepo();
  const base = g("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(dir, "new.test.js"), 'it.only("x", () => {});\n');
  const r = runIn(dir, base);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /new\.test\.js:1: \.only\(/);
  rmSync(dir, { recursive: true, force: true });
});

test("after commit, HEAD alone is clean; the start commit still sees the blocker", () => {
  const { dir, g } = makeRepo();
  const base = g("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(dir, "new.test.js"), 'it.only("x", () => {});\n');
  g("add", "-A");
  g("commit", "-qm", "add only");
  const head = runIn(dir);
  assert.equal(head.status, 0, head.stdout + head.stderr);
  const fromBase = runIn(dir, base);
  assert.equal(fromBase.status, 1, fromBase.stdout + fromBase.stderr);
  assert.match(fromBase.stdout, /new\.test\.js:1: \.only\(/);
  rmSync(dir, { recursive: true, force: true });
});
