/**
 * Worktree API integration test against a real, throwaway git repository in a
 * temp dir (the brief only forbids real magpie/wsl/dsh traffic; local git is
 * the unit under test). This is the surface B2's router will call.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { DoctorCheck, ExecResult, PluginContext } from "@mola/plugin-sdk";
import plugin, { type GitToolAdapter } from "@mola/plugin-tool-git";

const run = promisify(execFile);

/** A real exec service (same shape as core's) — nothing is mocked here. */
async function realExec(argv: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await run(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: any) {
    if (typeof err?.code === "number") {
      return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    throw err;
  }
}

function makeCtx(): PluginContext & { tools: any; doctor: any } {
  const tools: any[] = [];
  const checks: any[] = [];
  const ctx = {
    id: "mola-tool-git",
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => ctx.log, level: "info" },
    tools: {
      register: (a: any) => (tools.push(a), () => {}),
      list: () => tools,
      get: (id: string) => tools.find((t) => t.id === id),
    },
    doctor: {
      registerCheck: (c: any) => (checks.push(c), () => {}),
      list: () => checks,
    },
    process: { exec: realExec },
  } as unknown as PluginContext & { tools: any; doctor: any };
  plugin.activate(ctx);
  return ctx;
}

/** Create a repo with one commit so `git worktree add` has a HEAD. */
async function makeRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mola-worktree-repo-"));
  const git = (args: string[]): Promise<unknown> => run("git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "mola@example.test"]);
  await git(["config", "user.name", "mola test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
  await git(["add", "README.md"]);
  await git(["commit", "-q", "-m", "initial"]);
  return repo;
}

test("worktree add → list → remove round-trips on a real repo", async () => {
  const repo = await makeRepo();
  const ctx = makeCtx();
  const adapter = ctx.tools.get("git") as unknown as GitToolAdapter;
  assert.ok(adapter, "the git tool adapter is registered under id 'git'");

  const wtPath = path.join(os.tmpdir(), `mola-worktree-${Date.now()}-task`);
  const added = await adapter.worktreeAdd({ path: wtPath, task: "b1 smoke", cwd: repo });
  assert.equal(added.branch, "agent/b1-smoke");
  assert.equal(added.path, wtPath);
  assert.ok(fs.existsSync(path.join(wtPath, "README.md")), "the worktree is checked out");

  const list = await adapter.worktreeList({ cwd: repo });
  assert.ok(list.some((w) => w.path === wtPath && w.branch === "agent/b1-smoke"));

  await adapter.worktreeRemove({ path: wtPath, cwd: repo });
  assert.equal(fs.existsSync(wtPath), false, "the worktree dir is gone");
  const after = await adapter.worktreeList({ cwd: repo });
  assert.equal(after.some((w) => w.path === wtPath), false);

  // the branch survives a worktree remove (B2 decides what to do with it)
  const branches = await run("git", ["branch", "--list", "agent/b1-smoke"], { cwd: repo });
  assert.match(branches.stdout, /agent\/b1-smoke/);
});

test("worktreeAdd fails loudly when the branch already exists", async () => {
  const repo = await makeRepo();
  const ctx = makeCtx();
  const adapter = ctx.tools.get("git") as unknown as GitToolAdapter;
  const wtPath = path.join(os.tmpdir(), `mola-worktree-${Date.now()}-dup`);
  await adapter.worktreeAdd({ path: wtPath, branch: "agent/dup", cwd: repo });
  try {
    await assert.rejects(
      adapter.worktreeAdd({ path: `${wtPath}-2`, branch: "agent/dup", cwd: repo }),
      (err: any) => err.exitCode === 69 && /already exists|exit code/.test(err.message),
    );
  } finally {
    await adapter.worktreeRemove({ path: wtPath, force: true, cwd: repo }).catch(() => {});
  }
});

test("doctor checks pass on a machine with git (gh auth reported, not failed)", async () => {
  const repo = await makeRepo();
  const ctx = makeCtx();
  const checks: DoctorCheck[] = ctx.doctor.list();
  const ids = checks.map((c) => c.id).sort();
  assert.deepEqual(ids, ["tool.gh", "tool.git"]);
  for (const check of checks) {
    const res = await check.run();
    assert.equal(res.ok, true, `${check.id}: ${res.message}`);
  }
  void repo;
});
