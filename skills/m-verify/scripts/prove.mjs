#!/usr/bin/env node
// Red-first, proven: the test command fails on the base and passes on the current tree.
//
//   node prove.mjs --cmd "<test command>" [--base <ref>] [--tests <path>]... [--setup "<cmd>"] [--timeout-ms <n>]
//
// The base is a temporary detached worktree at <base> (default: merge-base of HEAD and the default branch;
// when HEAD is the base, the comparison is HEAD vs the working tree). The test files (--tests, default: changed
// files under a test/spec path) are copied from the working tree into it, so the new test runs against the old
// code. node_modules is linked from the repo when present; --setup runs in the base worktree first.
//
// Exit: 0 proved (red on base, green now) · 1 not proved (base passed, or the current tree fails) ·
//       2 usage or setup error (no repo, worktree failed, setup failed).
// The result is written to .mstack/verify/proof.json.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

export function parseArgs(argv) {
  const o = { tests: [], timeoutMs: 600000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--cmd") o.cmd = v();
    else if (a === "--base") o.base = v();
    else if (a === "--tests") o.tests.push(v());
    else if (a === "--setup") o.setup = v();
    else if (a === "--timeout-ms") o.timeoutMs = Number(v());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.cmd) throw new Error('usage: prove.mjs --cmd "<test command>" [--base <ref>] [--tests <path>]... [--setup "<cmd>"]');
  return o;
}

const TEST_PATH = /(^|\/)(tests?|spec|__tests__)\/|[._-](test|spec)\.[a-z]+$/i;

function defaultBase(top) {
  const head = git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], top);
  const branch = head.ok && head.out ? head.out : ["main", "master"].find((b) => git(["rev-parse", "--verify", "-q", b], top).ok);
  if (!branch) return "HEAD";
  const mb = git(["merge-base", "HEAD", branch], top);
  return mb.ok ? mb.out : "HEAD";
}

function shell(cmd, cwd, timeoutMs) {
  const win = process.platform === "win32";
  // a node:test parent's context would make a child `node --test` report to it and exit 0
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(win ? "cmd.exe" : "sh", win ? ["/d", "/s", "/c", cmd] : ["-c", cmd], { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
  return { code: r.status, timedOut: r.error?.code === "ETIMEDOUT", tail };
}

export function prove(o, cwd = process.cwd()) {
  const topR = git(["rev-parse", "--show-toplevel"], cwd);
  if (!topR.ok) return { exit: 2, verdict: "error", reason: "not inside a git repository" };
  const top = topR.out;
  const base = o.base ?? defaultBase(top);
  const baseSha = git(["rev-parse", "--verify", "-q", `${base}^{commit}`], top);
  if (!baseSha.ok) return { exit: 2, verdict: "error", reason: `no such commit: ${base}` };
  let tests = o.tests;
  if (tests.length === 0) {
    const changed = git(["diff", "--name-only", baseSha.out], top).out.split("\n");
    const untracked = git(["ls-files", "--others", "--exclude-standard"], top).out.split("\n");
    tests = [...new Set([...changed, ...untracked])].filter((f) => f && TEST_PATH.test(f) && existsSync(join(top, f)));
  }
  const wt = join(mkdtempSync(join(tmpdir(), "mstack-prove-")), "base");
  const add = git(["worktree", "add", "--detach", wt, baseSha.out], top);
  if (!add.ok) return { exit: 2, verdict: "error", reason: `git worktree add failed: ${add.err}` };
  try {
    for (const f of tests) {
      mkdirSync(dirname(join(wt, f)), { recursive: true });
      copyFileSync(join(top, f), join(wt, f));
    }
    if (existsSync(join(top, "node_modules")) && !existsSync(join(wt, "node_modules"))) {
      try {
        symlinkSync(join(top, "node_modules"), join(wt, "node_modules"), "junction");
      } catch {
        // without the link the setup command can install
      }
    }
    if (o.setup) {
      const s = shell(o.setup, wt, o.timeoutMs);
      if (s.code !== 0) return { exit: 2, verdict: "error", reason: `setup failed in the base worktree (exit ${s.code})`, setupTail: s.tail, base: baseSha.out, tests };
    }
    const onBase = shell(o.cmd, wt, o.timeoutMs);
    const onHead = shell(o.cmd, top, o.timeoutMs);
    const red = onBase.code !== 0 && !onBase.timedOut;
    const green = onHead.code === 0;
    const verdict = red && green ? "proved" : !red ? "base-passed" : "head-failed";
    const reason =
      verdict === "proved"
        ? "fails on the base, passes now"
        : verdict === "base-passed"
          ? onBase.timedOut
            ? "the base run timed out: that is not a failure the test caught"
            : "the test also passes on the base: it does not catch the bug"
          : "the test fails on the current tree";
    return { exit: verdict === "proved" ? 0 : 1, verdict, reason, cmd: o.cmd, base: baseSha.out, tests, onBase, onHead };
  } finally {
    git(["worktree", "remove", "--force", wt], top);
    rmSync(dirname(wt), { recursive: true, force: true });
  }
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const r = prove(o);
  const top = git(["rev-parse", "--show-toplevel"], process.cwd());
  if (top.ok) {
    const file = join(top.out, ".mstack", "verify", "proof.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...r, at: new Date().toISOString() }, null, 2) + "\n");
  }
  process.stdout.write(`PROOF: ${r.verdict} — ${r.reason}${r.base ? ` (base ${r.base.slice(0, 10)})` : ""}\n`);
  if (r.onBase) process.stdout.write(`base exit ${r.onBase.code}:\n${r.onBase.tail}\nhead exit ${r.onHead.code}:\n${r.onHead.tail}\n`);
  return r.exit;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) process.exitCode = main();
