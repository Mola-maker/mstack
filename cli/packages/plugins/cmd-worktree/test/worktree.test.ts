import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyGc, newWorktree, planGc } from "../src/index.js";

function repo(cfg?: object): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mola-wt-")), "proj");
  fs.mkdirSync(dir);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
  if (cfg) {
    fs.mkdirSync(path.join(dir, ".mstack"));
    fs.writeFileSync(path.join(dir, ".mstack", "worktree.json"), JSON.stringify(cfg));
  }
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}

test("new: creates agent/<name> beside the repo and runs setup with the worktree env", () => {
  const dir = repo({ setup: 'echo "$MOLA_WORKTREE_BRANCH" > setup-ran.txt' });
  const r = newWorktree(dir, "a1");
  assert.equal(r.branch, "agent/a1");
  assert.equal(r.path, path.join(path.dirname(dir), "proj-wt", "a1"));
  assert.equal(r.setup!.ok, true);
  assert.equal(fs.readFileSync(path.join(r.path, "setup-ran.txt"), "utf8").trim(), "agent/a1");
});

test("new: a failing setup rolls the worktree and branch back (or keeps them when asked)", () => {
  const dir = repo({ setup: "echo broken >&2; exit 3" });
  const r = newWorktree(dir, "b1");
  assert.equal(r.setup!.ok, false);
  assert.match(r.setup!.output, /broken/);
  assert.equal(fs.existsSync(r.path), false);
  assert.equal(execFileSync("git", ["branch", "--list", "agent/b1"], { cwd: dir, encoding: "utf8" }).trim(), "");
  const k = newWorktree(dir, "b2", { keepOnFailure: true });
  assert.equal(fs.existsSync(k.path), true);
});

test("gc: removes merged and inactive, keeps dirty; never touches unknown folders; teardown runs", () => {
  const dir = repo({ teardown: "touch ../torn-$(basename $MOLA_WORKTREE_ROOT)" });
  const merged = newWorktree(dir, "merged");
  const dirty = newWorktree(dir, "dirty");
  const idle = newWorktree(dir, "idle");
  fs.writeFileSync(path.join(dirty.path, "wip.txt"), "unsaved\n");
  // idle gets a commit main does not have
  fs.writeFileSync(path.join(idle.path, "f.txt"), "y\n");
  execFileSync("git", ["commit", "-qam", "idle work"], { cwd: idle.path });
  fs.mkdirSync(path.join(path.dirname(merged.path), "stray"));
  fs.writeFileSync(path.join(path.dirname(merged.path), "stray", "big.bin"), Buffer.alloc(4096));

  const plan = planGc(dir, { inactiveDays: 14 });
  const byName = Object.fromEntries(plan.items.map((i) => [path.basename(i.path), i]));
  assert.equal(byName.merged.action, "remove");
  assert.equal(byName.dirty.action, "keep");
  assert.match(byName.dirty.reason, /uncommitted/);
  assert.equal(byName.idle.action, "keep");
  assert.equal(plan.orphans.length, 1);

  const later = planGc(dir, { inactiveDays: 14, now: Date.now() + 30 * 86400000 });
  assert.equal(later.items.find((i) => i.path.endsWith("idle"))!.action, "remove");

  const res = applyGc(dir, later.items);
  assert.equal(res.removed.length, 2);
  assert.equal(fs.existsSync(dirty.path), true);
  assert.equal(fs.existsSync(path.join(path.dirname(merged.path), "stray")), true);
  assert.equal(fs.existsSync(path.join(path.dirname(merged.path), "torn-merged")), true);
  // the idle branch is kept; only the checkout goes
  assert.notEqual(execFileSync("git", ["branch", "--list", "agent/idle"], { cwd: dir, encoding: "utf8" }).trim(), "");
});
