// Tests for hooks/guard-git.mjs: every rule runs against a real temp git repo, through the real script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globToRe, isProtectedRef, parseGitArgv, splitCommand } from "./guard-git.mjs";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "guard-git.mjs");
const posix = process.platform !== "win32";
const t = posix ? test : test.skip; // shim/hooks are POSIX sh

const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^(GIT_|MOLA_)/.test(k)) delete CLEAN_ENV[k];
CLEAN_ENV.GIT_CONFIG_NOSYSTEM = "1";
CLEAN_ENV.GIT_AUTHOR_NAME = CLEAN_ENV.GIT_COMMITTER_NAME = "t";
CLEAN_ENV.GIT_AUTHOR_EMAIL = CLEAN_ENV.GIT_COMMITTER_EMAIL = "t@example.com";

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...CLEAN_ENV, ...(opts.env ?? {}) }, cwd: opts.cwd, input: opts.input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const git = (cwd, ...args) => sh("git", ["-c", "commit.gpgsign=false", ...args], { cwd });

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `guard-${name}-`));
}

/** A repo whose first commit exists on `branch`. Global config is isolated; no hooks yet. */
function mkRepo(branch = "main", dir = tmp("repo")) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch, ".");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

/** cwd on agent/x plus a sibling repo `other` that sits on main. */
function mkWorld() {
  const root = tmp("world");
  const work = mkRepo("agent/x", path.join(root, "work"));
  git(work, "branch", "main");
  mkRepo("main", path.join(root, "work", "x"));
  const other = mkRepo("main", path.join(root, "other"));
  return { root, work, other, x: path.join(work, "x") };
}

function hook(command, cwd, env = {}) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });
  const r = sh(process.execPath, [GUARD, "claude-hook"], { input, env });
  return { ...r, json: r.out.trim() ? JSON.parse(r.out) : null };
}
function denied(r) {
  return r.json?.hookSpecificOutput?.permissionDecision === "deny";
}

// ------------------------------------------------------------------ parsing helpers

test("protected patterns: defaults, release/*, tags are never protected", () => {
  const pats = ["main", "master", "release/*", "layerfs_v2_0_0"];
  for (const ref of ["main", "refs/heads/master", "release/1.0", "refs/heads/release/2/x", "layerfs_v2_0_0"]) assert.ok(isProtectedRef(ref, pats), ref);
  for (const ref of ["agent/x", "feature", "refs/tags/main", "refs/remotes/origin/main", "mainline", "releases/1"]) assert.ok(!isProtectedRef(ref, pats), ref);
  assert.ok(globToRe("a.b").test("a.b") && !globToRe("a.b").test("axb"));
});

test("parseGitArgv: global options before the subcommand", () => {
  const p = parseGitArgv(["-C", "/r", "-c", "k=v", "--git-dir=/g", "--no-pager", "commit", "-m", "x"]);
  assert.deepEqual(p.globals.C, ["/r"]);
  assert.deepEqual(p.globals.cfg, ["k=v"]);
  assert.equal(p.globals.gitDir, "/g");
  assert.equal(p.sub, "commit");
  assert.deepEqual(p.rest, ["-m", "x"]);
});

test("splitCommand: &&, ;, |, newline, quotes and $() inside quotes", () => {
  const { segs, subs } = splitCommand(`cd x && git commit -m "a b"; echo 'q' | cat\ngit status "$(git push)"`);
  assert.deepEqual(segs.map((s) => s[0]), ["cd", "git", "echo", "cat", "git"]);
  assert.deepEqual(segs[1], ["git", "commit", "-m", "a b"]);
  assert.deepEqual(subs, ["git push"]);
});

// ------------------------------------------------------------------ claude-hook

t("claude-hook: hook JSON in, deny JSON out (exact shape)", () => {
  const { work } = mkWorld();
  git(work, "checkout", "-q", "main");
  const r = hook("git commit -m x", work);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.json), ["hookSpecificOutput"]);
  assert.equal(r.json.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(r.json.hookSpecificOutput.permissionDecision, "deny");
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /mola land/);
});

t("claude-hook: `cd x && git commit` where x is on main", () => {
  const { work } = mkWorld();
  assert.ok(denied(hook("cd x && git commit -m y", work)));
});

t(`claude-hook: bash -c "git push origin main"`, () => {
  const { work } = mkWorld();
  assert.ok(denied(hook(`bash -c "git push origin main"`, work)));
  assert.ok(denied(hook(`bash -lc 'cd x; git push origin HEAD:main'`, work)));
  assert.ok(denied(hook(`echo "$(git push origin main)"`, work)), "substitution inside echo");
});

t("claude-hook: git -C other commit where other is on main", () => {
  const { work, other } = mkWorld();
  assert.ok(denied(hook(`git -C ${other} commit -m z`, work)));
  assert.ok(!denied(hook(`git -C ${work} commit -m z`, work)), "the same global option on a non-protected repo is fine");
});

t("claude-hook: push destinations", () => {
  const { work } = mkWorld();
  for (const c of [
    "git push origin HEAD:refs/heads/master",
    "git push origin HEAD:main",
    "git push origin agent/x:release/1.0",
    "git push --all origin",
    "git push --mirror",
    "git push origin :main",
    "git push --delete origin main",
    "git push origin +agent/x",
    "git push origin 'refs/heads/*:refs/heads/*'",
  ]) assert.ok(denied(hook(c, work)), c);
});

t("claude-hook: implicit push of the current protected branch", () => {
  const { work } = mkWorld();
  assert.ok(!denied(hook("git push origin", work)), "on agent/x an implicit push is fine");
  git(work, "checkout", "-q", "main");
  assert.ok(denied(hook("git push", work)));
  assert.ok(denied(hook("git push origin", work)));
  assert.ok(denied(hook("git push -u origin HEAD", work)));
});

t("claude-hook: force push to any ref, --no-verify, -n, hooksPath", () => {
  const { work } = mkWorld();
  for (const c of [
    "git push --force origin feature",
    "git push -f origin feature",
    "git push --force-with-lease origin feature",
    "git push origin +feature",
    "git commit --no-verify -m x",
    "git commit -nm x",
    "git commit -n -m x",
    "git push --no-verify origin agent/x",
    "git push -n origin agent/x",
    "git -c core.hooksPath=/dev/null commit -m x",
    "git -c core.hookspath=/tmp/h push origin agent/x",
    "git config core.hooksPath /tmp/h",
    "GIT_CONFIG_KEY_0=core.hooksPath git status",
  ]) assert.ok(denied(hook(c, work)), c);
});

t("claude-hook: other mutations on a protected branch", () => {
  const { work } = mkWorld();
  git(work, "checkout", "-q", "main");
  for (const c of ["git merge feature", "git rebase origin/main", "git reset --hard HEAD~1", "git cherry-pick abc", "git am p.patch", "git revert HEAD", "git pull", "git branch -f other HEAD", "git update-ref HEAD HEAD", "git update-ref refs/heads/main HEAD", "git checkout -B main"]) {
    assert.ok(denied(hook(c, work)), c);
  }
  for (const c of ["git status", "git log", "git diff", "git merge --abort", "git checkout agent/x", "git branch -a", "git fetch origin"]) assert.ok(!denied(hook(c, work)), c);
});

t("claude-hook: protected targets even from a non-protected branch", () => {
  const { work } = mkWorld();
  for (const c of ["git update-ref refs/heads/main HEAD", "git branch -f main HEAD", "git branch -D master", "git checkout -B main", "git fetch origin agent/x:main", "git rebase main main", "git checkout main && git commit -m x", "git switch main; git merge feature"]) {
    assert.ok(denied(hook(c, work)), c);
  }
});

t("claude-hook: separators, wrappers, aliases", () => {
  const { work, other } = mkWorld();
  for (const c of [
    `cd ${other} && git commit -m x`,
    `echo hi; cd ${other}\ngit commit -m x`,
    `true | cd ${other} && git commit -m x`,
    `sudo -u root git -C ${other} commit -m x`,
    `env FOO=1 /usr/bin/git -C ${other} commit -m x`,
    `(cd ${other} && git commit -m x)`,
    `timeout 5 xargs git -C ${other} commit`,
    "ssh host 'git push origin main'",
  ]) assert.ok(denied(hook(c, work)), c);
  git(work, "config", "alias.ci", "commit");
  git(work, "config", "alias.pm", "!git push origin main");
  assert.ok(!denied(hook("git ci -m x", work)));
  git(work, "checkout", "-q", "main");
  assert.ok(denied(hook("git ci -m x", work)), "alias to commit on main");
  git(work, "checkout", "-q", "agent/x");
  assert.ok(denied(hook("git pm", work)), "shell alias");
});

t("claude-hook: allowed commit and push on agent/x; non-Bash and garbage never block", () => {
  const { work } = mkWorld();
  for (const c of ["git commit -m 'fix git push origin main docs'", "git add -A && git commit -m x", "git push origin agent/x", "git push -u origin agent/x", "git push origin HEAD", "git status; git diff | cat", "echo git commit", "npm test"]) {
    assert.ok(!denied(hook(c, work)), c);
  }
  const notBash = sh(process.execPath, [GUARD, "claude-hook"], { input: JSON.stringify({ tool_name: "Edit", tool_input: { command: "git commit" }, cwd: work }) });
  assert.equal(notBash.code, 0);
  assert.equal(notBash.out, "");
  for (const input of ["", "not json", "{}", '{"tool_name":"Bash","tool_input":{}}', "null"]) {
    const r = sh(process.execPath, [GUARD, "claude-hook"], { input });
    assert.equal(r.code, 0, input);
    assert.equal(r.out, "");
  }
});

t("claude-hook: not a git repo is not blocked, but a push to main still is", () => {
  const dir = tmp("nogit");
  assert.ok(!denied(hook("git status", dir)));
  assert.ok(denied(hook("git push origin main", dir)));
});

t("protected set: .mstack/guard.json and MOLA_GUARD_PROTECTED add refs", () => {
  const { work } = mkWorld();
  assert.ok(!denied(hook("git push origin staging", work)));
  fs.mkdirSync(path.join(work, ".mstack"), { recursive: true });
  fs.writeFileSync(path.join(work, ".mstack", "guard.json"), JSON.stringify({ protected: ["staging"] }));
  assert.ok(denied(hook("git push origin staging", work)));
  assert.ok(denied(hook("git push origin prod2", work, { MOLA_GUARD_PROTECTED: "prod1,prod2" })));
  assert.ok(!denied(hook("git push origin prod3", work, { MOLA_GUARD_PROTECTED: "prod1,prod2" })));
  fs.writeFileSync(path.join(work, ".mstack", "guard.json"), JSON.stringify({ protected: [] }));
  assert.ok(denied(hook("git push origin main", work)), "guard.json can only add");
});

// ------------------------------------------------------------------ shim

function mkShim() {
  const dir = tmp("shim");
  fs.mkdirSync(path.join(dir, "bin"));
  fs.copyFileSync(GUARD, path.join(dir, "guard-git.mjs"));
  fs.writeFileSync(path.join(dir, "bin", "git"), `#!/bin/sh\nexec "${process.execPath}" "${dir}/guard-git.mjs" shim "$@"\n`, { mode: 0o755 });
  return { dir, env: { PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}` } };
}
const gitShim = (shim, cwd, args, env = {}) => sh("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: { ...shim.env, ...env } });

t("shim: refuses commit on main with one line that names `mola land`; exit 1; nothing committed", () => {
  const shim = mkShim();
  const repo = mkRepo("main");
  const before = git(repo, "rev-parse", "HEAD").out;
  const r = gitShim(shim, repo, ["commit", "--allow-empty", "-m", "nope"]);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim().split("\n").length, 1);
  assert.match(r.err, /mola land/);
  assert.equal(git(repo, "rev-parse", "HEAD").out, before);
});

t("shim: allowed commit on agent/x passes stdio and the real exit code through", () => {
  const shim = mkShim();
  const repo = mkRepo("agent/x");
  const ok = gitShim(shim, repo, ["commit", "--allow-empty", "-m", "fine"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(git(repo, "log", "-1", "--format=%s").out.trim(), "fine");
  assert.equal(gitShim(shim, repo, ["log", "-1", "--format=%s"]).out.trim(), "fine");
  assert.equal(gitShim(shim, repo, ["rev-parse", "--verify", "nope"]).code, 128);
});

t("shim: refuses -C other (on main), --no-verify, force push, hooksPath", () => {
  const shim = mkShim();
  const { work, other } = mkWorld();
  assert.equal(gitShim(shim, work, ["-C", other, "commit", "--allow-empty", "-m", "x"]).code, 1);
  assert.equal(gitShim(shim, work, ["commit", "--allow-empty", "--no-verify", "-m", "x"]).code, 1);
  assert.equal(gitShim(shim, work, ["push", "--force", "origin", "feature"]).code, 1);
  assert.equal(gitShim(shim, work, ["-c", "core.hooksPath=/x", "status"]).code, 1);
});

function landToken(repo, ms) {
  const token = "tok-" + Math.random().toString(16).slice(2);
  fs.writeFileSync(path.join(repo, ".git", "mola-land-token"), JSON.stringify({ token, expires: Date.now() + ms }));
  return token;
}

t("land token: one-shot through the shim, then refused again", () => {
  const shim = mkShim();
  const repo = mkRepo("main");
  const token = landToken(repo, 600_000);
  const first = gitShim(shim, repo, ["commit", "--allow-empty", "-m", "landed"], { MOLA_LAND_TOKEN: token });
  assert.equal(first.code, 0, first.err);
  assert.ok(!fs.existsSync(path.join(repo, ".git", "mola-land-token")), "token consumed");
  assert.ok(!fs.existsSync(path.join(repo, ".git", "mola-land-grant")), "grant released");
  const second = gitShim(shim, repo, ["commit", "--allow-empty", "-m", "again"], { MOLA_LAND_TOKEN: token });
  assert.equal(second.code, 1);
  assert.match(second.err, /mola land/);
});

t("land token: expired or wrong token is refused", () => {
  const shim = mkShim();
  const repo = mkRepo("main");
  const old = landToken(repo, -1000);
  assert.equal(gitShim(shim, repo, ["commit", "--allow-empty", "-m", "x"], { MOLA_LAND_TOKEN: old }).code, 1);
  assert.ok(!fs.existsSync(path.join(repo, ".git", "mola-land-token")), "expired token is deleted");
  landToken(repo, 600_000);
  assert.equal(gitShim(shim, repo, ["commit", "--allow-empty", "-m", "x"], { MOLA_LAND_TOKEN: "guess" }).code, 1);
  assert.ok(fs.existsSync(path.join(repo, ".git", "mola-land-token")), "a wrong guess does not consume");
});

t("land token never lifts force push or --no-verify", () => {
  const shim = mkShim();
  const repo = mkRepo("main");
  const token = landToken(repo, 600_000);
  assert.equal(gitShim(shim, repo, ["commit", "--allow-empty", "--no-verify", "-m", "x"], { MOLA_LAND_TOKEN: token }).code, 1);
  assert.equal(gitShim(shim, repo, ["push", "--force", "origin", "main"], { MOLA_LAND_TOKEN: token }).code, 1);
  assert.ok(fs.existsSync(path.join(repo, ".git", "mola-land-token")));
});

// ------------------------------------------------------------------ git hooks

function installHooks(repo) {
  const hooksDir = tmp("hooks");
  for (const name of ["pre-commit", "pre-push", "reference-transaction"]) {
    fs.writeFileSync(path.join(hooksDir, name), `#!/bin/sh\nexec "${process.execPath}" "${GUARD}" ${name} "$@"\n`, { mode: 0o755 });
  }
  git(repo, "config", "core.hooksPath", hooksDir);
  return hooksDir;
}

t("hooks: pre-commit refuses on main, allows on agent/x", () => {
  const repo = mkRepo("main");
  installHooks(repo);
  const r = git(repo, "commit", "--allow-empty", "-m", "x");
  assert.notEqual(r.code, 0);
  assert.match(r.err, /protected branch 'main'/);
  git(repo, "checkout", "-q", "-b", "agent/x");
  assert.equal(git(repo, "commit", "--allow-empty", "-m", "x").code, 0);
});

t("hooks: reference-transaction refuses `git update-ref refs/heads/main <sha>`", () => {
  const repo = mkRepo("agent/x");
  installHooks(repo);
  const sha = git(repo, "rev-parse", "HEAD").out.trim();
  const r = git(repo, "update-ref", "refs/heads/main", sha);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /protected ref 'main'/);
  assert.equal(git(repo, "rev-parse", "--verify", "-q", "refs/heads/main").code, 1, "ref was not created");
  assert.equal(git(repo, "update-ref", "refs/heads/agent/y", sha).code, 0);
  assert.equal(git(repo, "update-ref", "refs/tags/v1", sha).code, 0, "tags are not protected");
});

t("hooks: a merge commit on main is stopped at the ref update, and the land token passes the whole command once", () => {
  const repo = mkRepo("agent/x");
  git(repo, "commit", "-q", "--allow-empty", "-m", "work");
  git(repo, "branch", "main", "HEAD~1");
  git(repo, "checkout", "-q", "main");
  installHooks(repo);
  const refused = git(repo, "merge", "--ff-only", "agent/x");
  assert.notEqual(refused.code, 0);
  const token = landToken(repo, 600_000);
  const ok = sh("git", ["merge", "--ff-only", "agent/x"], { cwd: repo, env: { MOLA_LAND_TOKEN: token } });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(git(repo, "rev-parse", "main").out, git(repo, "rev-parse", "agent/x").out);
});

function mkRemote() {
  const bare = tmp("bare");
  git(bare, "init", "-q", "--bare", "-b", "main", ".");
  return bare;
}

t("hooks: pre-push refuses protected destinations and force, allows agent/x", () => {
  const repo = mkRepo("agent/x");
  const bare = mkRemote();
  git(repo, "remote", "add", "origin", bare);
  installHooks(repo);
  assert.equal(git(repo, "push", "origin", "agent/x").code, 0, "allowed push of agent/x");
  const toMain = git(repo, "push", "origin", "agent/x:main");
  assert.notEqual(toMain.code, 0);
  assert.match(toMain.err, /protected ref 'main'/);
  git(repo, "branch", "-q", "main");
  const all = git(repo, "push", "--all", "origin");
  assert.notEqual(all.code, 0);
  assert.match(all.err, /protected ref/);
  // make a diverged agent/x and force it: non-fast-forward is a force push
  git(repo, "commit", "-q", "--allow-empty", "-m", "a");
  git(repo, "push", "origin", "agent/x");
  git(repo, "reset", "-q", "--hard", "HEAD~1");
  git(repo, "commit", "-q", "--allow-empty", "-m", "b");
  const forced = sh("git", ["push", "--force", "origin", "agent/x"], { cwd: repo });
  assert.notEqual(forced.code, 0);
  assert.match(forced.err, /force push/);
});

t("everything together: the shim in front of hooks still lets a normal agent flow work", () => {
  const shim = mkShim();
  const repo = mkRepo("main");
  const bare = mkRemote();
  git(repo, "remote", "add", "origin", bare);
  installHooks(repo);
  assert.equal(gitShim(shim, repo, ["checkout", "-q", "-b", "agent/x"]).code, 0);
  assert.equal(gitShim(shim, repo, ["commit", "--allow-empty", "-m", "work"]).code, 0);
  assert.equal(gitShim(shim, repo, ["push", "-u", "origin", "agent/x"]).code, 0);
  assert.equal(gitShim(shim, repo, ["checkout", "-q", "main"]).code, 0);
  assert.equal(gitShim(shim, repo, ["merge", "agent/x"]).code, 1);
});
