/**
 * tool-git parsing/discovery unit tests — fixture strings and directories, no
 * real git or gh process is started (core §9).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  locateBinary,
  parseGhVersion,
  parseGitVersion,
  parseWorktreeList,
  taskBranchName,
} from "@mola/plugin-tool-git";

test("parseWorktreeList reads a single attached worktree", () => {
  const raw = [
    "worktree /mnt/e/mstack",
    "HEAD c94eb1f6868f79518e91e497a573d15cd600ead3",
    "branch refs/heads/master",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreeList(raw), [
    {
      path: "/mnt/e/mstack",
      head: "c94eb1f6868f79518e91e497a573d15cd600ead3",
      branch: "master",
      ref: "refs/heads/master",
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    },
  ]);
});

test("parseWorktreeList handles detached, bare, locked and prunable records", () => {
  const raw = [
    "worktree /repo/main",
    "HEAD 0f1e2d3",
    "branch refs/heads/main",
    "",
    "worktree /repo/bare",
    "HEAD 1111111",
    "bare",
    "",
    "worktree /repo/task",
    "HEAD 2222222",
    "detached",
    "",
    "worktree /repo/stale",
    "HEAD 3333333",
    "branch refs/heads/agent/old",
    "locked",
    "prunable 0001 (git file points to missing dir)",
    "",
  ].join("\n");
  const list = parseWorktreeList(raw);
  assert.equal(list.length, 4);
  assert.equal(list[1].bare, true);
  assert.equal(list[1].branch, undefined, "a bare worktree has no branch line");
  assert.equal(list[2].detached, true);
  assert.equal(list[2].branch, undefined);
  assert.equal(list[3].locked, true);
  assert.equal(list[3].prunable, true);
  assert.equal(list[3].branch, "agent/old");
});

test("parseWorktreeList returns [] for empty output", () => {
  assert.deepEqual(parseWorktreeList(""), []);
  assert.deepEqual(parseWorktreeList("\n\n"), []);
});

test("unknown porcelain markers are ignored (forward compatible)", () => {
  const raw = ["worktree /w", "HEAD abc", "branch refs/heads/b", "future-marker x", ""].join("\n");
  const list = parseWorktreeList(raw);
  assert.equal(list.length, 1);
  assert.equal(list[0].branch, "b");
});

test("version parsers", () => {
  assert.equal(parseGitVersion("git version 2.53.0"), "2.53.0");
  assert.equal(parseGhVersion("gh version 2.103.3 (2026-10-26)"), "2.103.3");
  assert.equal(parseGitVersion("no digits here"), null);
});

test("taskBranchName slugs the task into agent/<slug>", () => {
  assert.equal(taskBranchName("b1-smoke"), "agent/b1-smoke");
  assert.equal(taskBranchName("Implement B1 dispatch flow!"), "agent/implement-b1-dispatch-flow");
  assert.equal(taskBranchName("  "), "agent/task");
});

test("locateBinary scans PATH (fixture dir, no real binary needed)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-tool-git-"));
  const exe = path.join(dir, "git");
  fs.writeFileSync(exe, "");
  fs.chmodSync(exe, 0o755);
  const loc = locateBinary("git", { PATH: dir }, "linux");
  assert.deepEqual(loc, { path: exe, source: "path" });
  const missing = locateBinary("gh", { PATH: dir }, "linux");
  assert.deepEqual(missing, { path: null, source: "none" });
});
