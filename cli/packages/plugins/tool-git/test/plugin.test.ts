/**
 * tool-git plugin-level tests: a stub PluginContext with a *mocked* exec
 * service records the argv it is given and returns canned results, so `git`
 * and `gh` are never really executed here (the real-git integration lives in
 * worktree.integration.test.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DoctorCheck, ExecResult, PluginContext, ToolAdapter } from "@mola/plugin-sdk";
import plugin, { type GitToolAdapter } from "@mola/plugin-tool-git";

// Fake binaries are POSIX shell scripts: run on Linux (WSL, CI); skipped on a Windows host.
const linuxTest = process.platform === "win32" ? test.skip : test;

interface Call {
  argv: string[];
  opts: { cwd?: string };
}

interface Ctx {
  ctx: PluginContext;
  tools: ToolAdapter[];
  checks: DoctorCheck[];
  calls: Call[];
}

type ExecScript = (argv: string[], opts: { cwd?: string }) => ExecResult;

function makeCtx(script: ExecScript): Ctx {
  const tools: ToolAdapter[] = [];
  const checks: DoctorCheck[] = [];
  const calls: Call[] = [];
  const ctx = {
    id: "mola-tool-git",
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => ctx.log, level: "info" },
    tools: { register: (a: ToolAdapter) => (tools.push(a), () => {}) },
    doctor: { registerCheck: (c: DoctorCheck) => (checks.push(c), () => {}) },
    process: {
      exec: async (argv: string[], opts: { cwd?: string } = {}) => {
        calls.push({ argv, opts });
        return script(argv, opts);
      },
    },
  } as unknown as PluginContext;
  return { ctx, tools, checks, calls };
}

function gitAdapter(c: Ctx): GitToolAdapter {
  plugin.activate(c.ctx);
  assert.equal(c.tools.length, 1);
  assert.equal(c.tools[0].id, "git");
  return c.tools[0] as unknown as GitToolAdapter;
}

/** Ensure locateBinary finds stand-in files named git/gh (never executed). */
function fakeBinariesOnPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-tool-git-fake-"));
  for (const name of ["git", "gh"]) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "");
    fs.chmodSync(p, 0o755);
  }
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev ?? ""}`;
  return prev ?? "";
}

function restorePath(prev: string): void {
  if (prev === "") delete process.env.PATH;
  else process.env.PATH = prev;
}

const VERSIONS: ExecScript = (argv) => {
  if (argv[1] === "--version") {
    return argv[0].endsWith("git")
      ? { code: 0, stdout: "git version 2.53.0\n", stderr: "" }
      : { code: 0, stdout: "gh version 2.103.3 (2026-10-26)\n", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

test("activate registers the git tool adapter plus tool.git and tool.gh checks", () => {
  const c = makeCtx(VERSIONS);
  plugin.activate(c.ctx);
  assert.equal(c.tools.length, 1);
  assert.deepEqual(
    c.checks.map((x) => x.id),
    ["tool.git", "tool.gh"],
  );
});

linuxTest("detect reads git and gh versions through the exec service", async () => {
  const c = makeCtx(VERSIONS);
  const adapter = gitAdapter(c);
  const prev = fakeBinariesOnPath();
  try {
    const info = await adapter.detect();
    assert.equal(info.git.version, "2.53.0");
    assert.equal(info.gh.version, "2.103.3");
    assert.deepEqual(
      c.calls.map((x) => x.argv.slice(1)),
      [["--version"], ["--version"]],
    );
  } finally {
    restorePath(prev);
  }
});

test("worktreeAdd runs stable porcelain and reports the new worktree", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mola-tool-git-repo-"));
  const target = path.resolve(cwd, "../stack-b1-task");
  const porcelain = [
    `worktree ${cwd}`,
    "HEAD c94eb1f",
    "branch refs/heads/master",
    "",
    `worktree ${target}`,
    "HEAD c94eb1f",
    "branch refs/heads/agent/b1-task",
    "",
  ].join("\n");
  const c = makeCtx((argv) =>
    argv[1] === "worktree" && argv[2] === "list"
      ? { code: 0, stdout: porcelain, stderr: "" }
      : { code: 0, stdout: "", stderr: "" },
  );
  const adapter = gitAdapter(c);
  const prev = fakeBinariesOnPath();
  try {
    const wt = await adapter.worktreeAdd({ path: "../stack-b1-task", task: "b1 task", cwd });
    const addCall = c.calls.find((x) => x.argv[1] === "worktree" && x.argv[2] === "add")!;
    assert.ok(addCall, "expected a `git worktree add` call");
    // argv = [git, "worktree", "add", <target>, "-b", <branch>]
    const [, verb, addVerb, targetArg, flag, branch] = addCall.argv;
    assert.equal(verb, "worktree");
    assert.equal(addVerb, "add");
    assert.equal(targetArg, target);
    assert.equal(flag, "-b");
    assert.equal(branch, "agent/b1-task", "the branch is derived from the task slug");
    assert.equal(wt.branch, "agent/b1-task");
  } finally {
    restorePath(prev);
  }
});

test("worktreeList parses --porcelain output", async () => {
  const c = makeCtx((argv) =>
    argv[1] === "worktree" && argv[2] === "list"
      ? { code: 0, stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/main\n", stderr: "" }
      : { code: 0, stdout: "", stderr: "" },
  );
  const adapter = gitAdapter(c);
  const prev = fakeBinariesOnPath();
  try {
    const list = await adapter.worktreeList({ cwd: "/repo" });
    assert.equal(list.length, 1);
    assert.equal(list[0].path, path.resolve("/repo")); // native absolute path on every OS
    assert.equal(list[0].branch, "main");
    const listCall = c.calls.find((x) => x.argv[1] === "worktree" && x.argv[2] === "list")!;
    assert.deepEqual(listCall.argv.slice(1), ["worktree", "list", "--porcelain"]);
  } finally {
    restorePath(prev);
  }
});

test("worktreeRemove forwards --force; a failing git surfaces its stderr", async () => {
  let fail = false;
  const c = makeCtx((argv) =>
    fail ? { code: 128, stdout: "", stderr: "fatal: contains modified or untracked files" } : { code: 0, stdout: "", stderr: "" },
  );
  const adapter = gitAdapter(c);
  const prev = fakeBinariesOnPath();
  try {
    await adapter.worktreeRemove({ path: "/repo/wt", force: true, cwd: "/repo" });
    const rm = c.calls.find((x) => x.argv[1] === "worktree" && x.argv[2] === "remove")!;
    assert.deepEqual(rm.argv.slice(1), ["worktree", "remove", path.resolve("/repo/wt"), "--force"]);

    fail = true;
    await assert.rejects(
      adapter.worktreeRemove({ path: "/repo/wt", cwd: "/repo" }),
      (err: any) => err.exitCode === 69 && /untracked/.test(err.details?.stderr ?? ""),
    );
  } finally {
    restorePath(prev);
  }
});

test("doctor tool.git fails with exit 69 when git is missing", async () => {
  const c = makeCtx(VERSIONS);
  plugin.activate(c.ctx);
  const prev = process.env.PATH;
  delete process.env.PATH;
  try {
    const res = await c.checks.find((x) => x.id === "tool.git")!.run();
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 69);
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
});

test("doctor tool.gh reports (not fails) the gh auth state — exit 1 is 'not logged in'", async () => {
  const c = makeCtx((argv) => {
    if (argv[1] === "auth" && argv[2] === "status") {
      return {
        code: 1,
        stdout: "",
        stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
      };
    }
    return VERSIONS(argv, {});
  });
  plugin.activate(c.ctx);
  const prev = fakeBinariesOnPath();
  try {
    const res = await c.checks.find((x) => x.id === "tool.gh")!.run();
    assert.equal(res.ok, true, "an unauthenticated gh must not fail doctor");
    assert.match(res.message!, /not authenticated/);
  } finally {
    restorePath(prev);
  }
});

test("doctor tool.gh reports the authenticated host when gh auth status exits 0", async () => {
  const c = makeCtx((argv) => {
    if (argv[1] === "auth" && argv[2] === "status") {
      return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account mola-maker", stderr: "" };
    }
    return VERSIONS(argv, {});
  });
  plugin.activate(c.ctx);
  const prev = fakeBinariesOnPath();
  try {
    const res = await c.checks.find((x) => x.id === "tool.gh")!.run();
    assert.equal(res.ok, true);
    assert.match(res.message!, /authenticated/);
    assert.match(res.message!, /github\.com/);
  } finally {
    restorePath(prev);
  }
});
