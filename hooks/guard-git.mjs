#!/usr/bin/env node
// guard-git.mjs — the single source of the mstack branch guard (FRAMEWORK §13.4). Zero dependencies.
//
// Modes (first argv):
//   claude-hook             Claude Code PreToolUse hook: hook JSON on stdin, deny JSON on stdout.
//   shim <git args...>      the `git` wrapper for agent workers (PATH shim); refuses or execs the real git.
//   pre-commit              git hook.
//   pre-push <remote> <url> git hook; ref lines on stdin.
//   reference-transaction <state>   git hook; `<old> <new> <ref>` lines on stdin; acts on `prepared`.
//
// What it refuses (see FRAMEWORK §13.4): commit/merge/rebase/reset/cherry-pick/am/revert/pull (and branch -f,
// update-ref, checkout -B, fetch x:main) on or into a protected ref; any push whose destination is a protected
// ref; any force push; --no-verify / -n; `-c core.hooksPath=`. The only bypass is the one-shot land token that
// `mola land` writes to <git-common-dir>/mola-land-token and passes as MOLA_LAND_TOKEN.
//
// Failure policy: `claude-hook` and `shim` FAIL OPEN on an internal error (exit 0 / exec real git) because the
// git hooks (layer a) and GitHub branch protection (layer c) back them up. The git hooks fail CLOSED.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PROTECTED = ["main", "master", "release/*", "layerfs_v2_0_0"];
const TOKEN_FILE = "mola-land-token";
const GRANT_FILE = "mola-land-grant";
const GRANT_TTL_MS = 30_000;
const ZERO_SHA = /^0+$/;
const LAND_HINT = "land it with `mola land <branch>` (needs an independent review receipt)";

// ------------------------------------------------------------------ protected refs

export function globToRe(pattern) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`);
}

/** Short branch name for a ref, or null when the ref is not under refs/heads (tags, remotes, notes). */
export function shortBranch(ref) {
  if (typeof ref !== "string" || !ref) return null;
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/")) return null;
  return ref;
}

export function isProtectedRef(ref, patterns) {
  const name = shortBranch(ref);
  if (!name) return false;
  return patterns.some((p) => globToRe(p).test(name));
}

export function loadProtected(toplevel, env = process.env) {
  const list = [...DEFAULT_PROTECTED];
  if (toplevel) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(toplevel, ".mstack", "guard.json"), "utf8"));
      if (Array.isArray(j.protected)) for (const p of j.protected) if (typeof p === "string" && p) list.push(p);
    } catch { /* no guard.json: defaults only. The file can only add refs, never remove one. */ }
  }
  for (const p of String(env.MOLA_GUARD_PROTECTED ?? "").split(",")) if (p.trim()) list.push(p.trim());
  return [...new Set(list)];
}

// ------------------------------------------------------------------ real git + repo lookups

function realPathSafe(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** PATH entries that hold the guard shim: MOLA_GUARD_SHIM_DIR, ./bin next to this file, or a `git` that names guard-git. */
export function stripShimDirs(pathVar, env = process.env) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const shimDirs = new Set([realPathSafe(path.join(here, "bin"))]);
  if (env.MOLA_GUARD_SHIM_DIR) shimDirs.add(realPathSafe(env.MOLA_GUARD_SHIM_DIR));
  return String(pathVar ?? "").split(path.delimiter).filter((dir) => {
    if (!dir) return false;
    if (shimDirs.has(realPathSafe(dir))) return false;
    try {
      const f = path.join(dir, "git");
      const st = fs.statSync(f);
      if (st.isFile() && st.size < 4096 && fs.readFileSync(f, "utf8").includes("guard-git.mjs")) return false;
    } catch { /* not there */ }
    return true;
  }).join(path.delimiter);
}

export function findRealGit(env = process.env) {
  const clean = stripShimDirs(env.PATH, env);
  for (const dir of clean.split(path.delimiter)) {
    const f = path.join(dir, "git");
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

function runGit(args, { cwd, env = process.env } = {}) {
  const real = findRealGit(env);
  if (!real) return { code: 127, stdout: "", stderr: "git not found" };
  const r = spawnSync(real, args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
    env: { ...env, PATH: stripShimDirs(env.PATH, env), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** What the guard needs to know about the repo at `dir`. Never throws. */
export function repoInfo(dir, { gitDir, workTree, env = process.env } = {}) {
  const base = [];
  if (gitDir) base.push("--git-dir", gitDir);
  if (workTree) base.push("--work-tree", workTree);
  const out = (args) => runGit([...base, ...args], { cwd: dir, env });
  const top = out(["rev-parse", "--show-toplevel"]);
  const common = out(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const sym = out(["symbolic-ref", "-q", "--short", "HEAD"]);
  const toplevel = top.code === 0 ? top.stdout.trim() : null;
  let commonDir = common.code === 0 ? common.stdout.trim() : null;
  if (commonDir && !path.isAbsolute(commonDir)) commonDir = path.resolve(dir, commonDir);
  return {
    ok: common.code === 0,
    toplevel,
    commonDir,
    branch: sym.code === 0 ? sym.stdout.trim() || null : null,
    protected: loadProtected(toplevel, env),
    config: (key, all = false) => {
      const r = out(["config", all ? "--get-all" : "--get", key]);
      return r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    },
  };
}

// ------------------------------------------------------------------ land token (one-shot)

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * Does MOLA_LAND_TOKEN match a live token for this repo? A match CONSUMES the token: the token file is renamed
 * to a short-lived grant (so the hooks of the same git command also pass) and the caller deletes the grant
 * with releaseGrant() when that command ends. A second use finds neither file and is refused.
 */
export function consumeLandToken(commonDir, env = process.env, now = Date.now()) {
  const t = env.MOLA_LAND_TOKEN;
  if (!t || !commonDir) return false;
  const grantFile = path.join(commonDir, GRANT_FILE);
  const tokenFile = path.join(commonDir, TOKEN_FILE);
  const g = readJson(grantFile);
  if (g && g.token === t) {
    if (Number(g.expires) > now) return true;
    try { fs.unlinkSync(grantFile); } catch { /* gone */ }
  }
  const f = readJson(tokenFile);
  if (!f || f.token !== t) return false;
  if (!(Number(f.expires) > now)) {
    try { fs.unlinkSync(tokenFile); } catch { /* gone */ }
    return false;
  }
  try { fs.renameSync(tokenFile, grantFile); } catch { return false; } // lost the race: someone else consumed it
  try { fs.writeFileSync(grantFile, JSON.stringify({ token: t, expires: now + GRANT_TTL_MS })); } catch { /* keep the renamed file */ }
  return true;
}

export function releaseGrant(commonDir) {
  if (!commonDir) return;
  try { fs.unlinkSync(path.join(commonDir, GRANT_FILE)); } catch { /* none */ }
}

// ------------------------------------------------------------------ shell command parsing

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish"]);
// first words whose arguments are text, not a command to run (their $(...) substitutions are still scanned)
const NON_EXEC = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "man", "cat", "which", "type", "ls", "head", "tail", "less", "wc", "sed", "awk", "tee", "test", "["]);

function baseName(word) {
  return path.basename(String(word)).toLowerCase().replace(/\.exe$/, "");
}

/** Split a shell string into simple commands (arrays of words). Also returns $(...) / `...` bodies found inside "…". */
export function splitCommand(str) {
  const segs = [];
  const subs = [];
  let words = [];
  let cur = "";
  let has = false;
  let i = 0;
  const n = str.length;
  const endWord = () => { if (has) words.push(cur); cur = ""; has = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  while (i < n) {
    const c = str[i];
    if (c === "'") {
      has = true;
      const j = str.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      cur += str.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      has = true;
      i += 1;
      while (i < n && str[i] !== '"') {
        if (str[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(str[i + 1])) { cur += str[i + 1]; i += 2; continue; }
        if (str[i] === "$" && str[i + 1] === "(") {
          let depth = 1;
          let j = i + 2;
          while (j < n && depth > 0) { if (str[j] === "(") depth += 1; else if (str[j] === ")") depth -= 1; j += 1; }
          subs.push(str.slice(i + 2, j - 1));
        } else if (str[i] === "`") {
          const j = str.indexOf("`", i + 1);
          if (j > 0) subs.push(str.slice(i + 1, j));
        }
        cur += str[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < n) {
        if (str[i + 1] === "\n") { i += 2; continue; }
        cur += str[i + 1];
        has = true;
        i += 2;
      } else i += 1;
      continue;
    }
    if (c === "#" && !has) { while (i < n && str[i] !== "\n") i += 1; continue; }
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "`") { endSeg(); i += 1; continue; }
    if (c === " " || c === "\t" || c === "\r") { endWord(); i += 1; continue; }
    cur += c;
    has = true;
    i += 1;
  }
  endSeg();
  return { segs, subs };
}

function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Every `git` invocation in a shell string, in order, with the directory it would run in.
 * Over-matching is deliberate (a `git` word anywhere in the first 14 words counts); under-matching is not.
 */
export function findGitInvocations(command, cwd, depth = 0, state = { cwd }) {
  const out = [];
  if (depth > 5) return out;
  const { segs, subs } = splitCommand(String(command));
  const recurse = (text) => out.push(...findGitInvocations(text, state.cwd, depth + 1, { cwd: state.cwd }));
  for (const words of segs) {
    let k = 0;
    const assigns = [];
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) assigns.push(words[k++]);
    const w = words.slice(k);
    if (!w.length) continue;
    const head = baseName(w[0]);
    if (head === "cd" || head === "pushd") {
      const arg = w.slice(1).find((x) => !x.startsWith("-"));
      if (arg && arg !== "-") state.cwd = path.resolve(state.cwd, expandHome(arg));
      continue;
    }
    let found = false;
    for (let i = 0; i < Math.min(w.length, 14); i += 1) {
      const b = baseName(w[i]);
      if (b === "git") { out.push({ argv: w.slice(i + 1), cwd: state.cwd, assigns, pre: w.slice(0, i) }); found = true; break; }
      if (SHELLS.has(b)) {
        const j = w.findIndex((x, idx) => idx > i && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
        if (j > 0 && w[j + 1] !== undefined) { recurse(w[j + 1]); found = true; break; }
      }
      if (b === "eval") { recurse(w.slice(i + 1).join(" ")); found = true; break; }
    }
    if (!found && !NON_EXEC.has(head)) for (const x of w) if (/\s/.test(x) && /git/.test(x)) recurse(x);
  }
  for (const s of subs) recurse(s);
  return out;
}

// ------------------------------------------------------------------ git argv parsing

/** Split `git [globals] <sub> <rest>`. Handles -C, -c, --git-dir, --work-tree and the other global options. */
export function parseGitArgv(argv) {
  const g = { C: [], cfg: [], gitDir: null, workTree: null };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-C") { g.C.push(argv[i + 1] ?? ""); i += 2; continue; }
    if (a === "-c") { g.cfg.push(argv[i + 1] ?? ""); i += 2; continue; }
    if (a === "--config-env") { g.cfg.push(argv[i + 1] ?? ""); i += 2; continue; }
    if (a.startsWith("--config-env=")) { g.cfg.push(a.slice(13)); i += 1; continue; }
    if (a === "--git-dir") { g.gitDir = argv[i + 1] ?? null; i += 2; continue; }
    if (a.startsWith("--git-dir=")) { g.gitDir = a.slice(10); i += 1; continue; }
    if (a === "--work-tree") { g.workTree = argv[i + 1] ?? null; i += 2; continue; }
    if (a.startsWith("--work-tree=")) { g.workTree = a.slice(12); i += 1; continue; }
    if (a === "--namespace" || a === "--super-prefix") { i += 2; continue; }
    if (a.startsWith("-")) { i += 1; continue; } // --no-pager, -p, --bare, --exec-path[=…], …
    break;
  }
  return { globals: g, sub: argv[i] ?? null, rest: argv.slice(i + 1) };
}

/** Options and positionals of one subcommand; `valueOpts` lists the options that consume the next word. */
function parseOpts(rest, valueOpts = []) {
  const long = [];
  const shorts = [];
  const pos = [];
  let afterDD = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (afterDD) { pos.push(a); continue; }
    if (a === "--") { afterDD = true; continue; }
    if (a.startsWith("--")) {
      const name = a.split("=")[0];
      long.push(name);
      if (valueOpts.includes(name) && !a.includes("=")) i += 1;
      continue;
    }
    if (a.length > 1 && a.startsWith("-")) {
      for (let j = 1; j < a.length; j += 1) {
        const ch = a[j];
        shorts.push(ch);
        if (valueOpts.includes(`-${ch}`)) { if (j === a.length - 1) i += 1; break; }
      }
      continue;
    }
    pos.push(a);
  }
  return { long, shorts, pos };
}

const pfx = (name, full, min) => name.length >= min && full.startsWith(name);
const hasLong = (long, full, min) => long.some((n) => pfx(n, full, min));

const MUTATE_CURRENT = new Set(["commit", "merge", "rebase", "cherry-pick", "am", "revert", "pull"]);
const ALWAYS_ALLOWED_WORDS = new Set(["--abort", "--quit"]);

// ------------------------------------------------------------------ evaluation of one git invocation

function deny(kind, reason) {
  return { kind, reason };
}

const onProtectedMsg = (what, branch) =>
  `refused: ${what} on protected branch '${branch}'; agents work on agent/<name> branches, ${LAND_HINT}.`;
const protectedTargetMsg = (what, ref) =>
  `refused: ${what} targets protected ref '${ref}'; ${LAND_HINT}.`;

/**
 * Judge one git invocation. `state.vbranch` remembers `git checkout main` earlier in the same command string.
 * Returns {kind: "protected"|"always", reason} or null. kind "protected" may be lifted by a land token;
 * kind "always" (force push, --no-verify, hooksPath) never is.
 */
export function evaluateGit(inv, state, env = process.env, depth = 0) {
  const parsed = parseGitArgv(inv.argv);
  const { globals, sub, rest } = parsed;
  const hay = [...inv.argv, ...inv.assigns, ...(inv.pre ?? [])].join(" ");

  // -c core.hooksPath=…, GIT_CONFIG_*=core.hooksPath, `git config core.hooksPath` — everywhere, any branch
  if (/core\.hookspath/i.test(hay)) return deny("always", "refused: overriding core.hooksPath bypasses the branch guard hooks.");
  if (!sub) return null;

  const gitDirAssign = inv.assigns.find((a) => a.startsWith("GIT_DIR="))?.slice(8);
  const workTreeAssign = inv.assigns.find((a) => a.startsWith("GIT_WORK_TREE="))?.slice(14);
  let dir = inv.cwd;
  for (const c of globals.C) dir = path.resolve(dir, expandHome(c));
  const lookup = { gitDir: globals.gitDir ?? gitDirAssign ?? undefined, workTree: globals.workTree ?? workTreeAssign ?? undefined, env };
  const key = `${dir}|${lookup.gitDir ?? ""}`;
  const info = repoInfo(dir, lookup);
  const branch = state.vbranch.get(key) ?? info.branch;
  const protectedNow = branch !== null && isProtectedRef(branch, info.protected);
  const isProt = (ref) => isProtectedRef(ref, info.protected);
  const commonDir = info.commonDir;
  const withDir = (d) => (d ? { ...d, commonDir } : d);

  // aliases cannot shadow builtins, so look up only names that are not interesting builtins
  if (!KNOWN.has(sub) && depth < 3) {
    const alias = info.config(`alias.${sub}`)[0];
    if (alias) {
      if (alias.startsWith("!")) {
        for (const inner of findGitInvocations(alias.slice(1), dir)) {
          const d = evaluateGit({ ...inner, assigns: [...inv.assigns, ...inner.assigns] }, state, env, depth + 1);
          if (d) return withDir(d);
        }
        return null;
      }
      const words = alias.split(/\s+/).filter(Boolean);
      return withDir(evaluateGit({ ...inv, argv: [...inv.argv.slice(0, inv.argv.indexOf(sub)), ...words, ...rest] }, state, env, depth + 1));
    }
  }

  const dd = rest.indexOf("--");
  const optsOnly = dd < 0 ? rest : rest.slice(0, dd);
  if (["commit", "push", "merge", "am", "cherry-pick", "revert"].includes(sub) && optsOnly.some((a) => /^--no-v/.test(a))) {
    return withDir(deny("always", `refused: --no-verify on git ${sub} skips the guard hooks.`));
  }

  switch (sub) {
    case "commit":
    case "push": {
      const o = parseOpts(rest, sub === "commit"
        ? ["-m", "-F", "-C", "-c", "-t", "--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--cleanup"]
        : ["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
      if (o.shorts.includes("n")) return withDir(deny("always", `refused: git ${sub} -n skips the guard hooks (--no-verify).`));
      if (sub === "commit") {
        if (protectedNow && !rest.some((a) => ALWAYS_ALLOWED_WORDS.has(a))) return withDir(deny("protected", onProtectedMsg("git commit", branch)));
        return null;
      }
      return withDir(evaluatePush(o, rest, { branch, protectedNow, info, isProt }));
    }
    case "merge":
    case "rebase":
    case "cherry-pick":
    case "am":
    case "revert":
    case "pull": {
      const o = parseOpts(rest, ["-m", "-s", "-X", "--strategy", "--strategy-option", "-C", "--onto", "-x"]);
      if (rest.some((a) => ALWAYS_ALLOWED_WORDS.has(a))) return null;
      if (sub === "pull") {
        const bad = o.pos.slice(1).map(refspecDst).find((d) => d && isProt(d));
        if (bad) return withDir(deny("protected", protectedTargetMsg("git pull", bad)));
      }
      if (protectedNow) return withDir(deny("protected", onProtectedMsg(`git ${sub}`, branch)));
      // `git rebase <upstream> main` switches to main and rewrites it
      if (sub === "rebase" && o.pos.length >= 2 && isProt(o.pos[1])) return withDir(deny("protected", protectedTargetMsg("git rebase", o.pos[1])));
      return null;
    }
    case "reset": {
      const modes = ["--hard", "--soft", "--mixed", "--keep", "--merge"];
      if (protectedNow && rest.some((a) => modes.includes(a))) return withDir(deny("protected", onProtectedMsg("git reset", branch)));
      return null;
    }
    case "checkout":
    case "switch": {
      const o = parseOpts(rest, ["-b", "-B", "-c", "-C", "--orphan", "--conflict", "-t", "--track"]);
      const force = [];
      for (let i = 0; i < rest.length; i += 1) {
        if (["-B", "--force-create"].includes(rest[i]) || (sub === "switch" && rest[i] === "-C") || rest[i] === "-b" || rest[i] === "-c" || rest[i] === "--orphan") force.push([rest[i], rest[i + 1]]);
      }
      for (const [flag, name] of force) {
        if (name && isProt(name) && (["-B", "-C", "--force-create"].includes(flag))) return withDir(deny("protected", protectedTargetMsg(`git ${sub} ${flag}`, name)));
      }
      const target = force[0]?.[1] ?? (sub === "switch" ? o.pos[0] : o.pos[0]);
      if (target && !rest.includes("--")) state.vbranch.set(key, target);
      return null;
    }
    case "branch": {
      const o = parseOpts(rest, ["-m", "-M", "-u", "--set-upstream-to", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);
      const listy = hasLong(o.long, "--list", 3) || o.shorts.some((c) => "lavr".includes(c)) || o.long.some((n) => ["--show-current", "--contains", "--merged", "--no-merged", "--points-at"].includes(n));
      const mutate = o.shorts.some((c) => "fMDdmC".includes(c)) || hasLong(o.long, "--force", 3) || hasLong(o.long, "--move", 3) || hasLong(o.long, "--delete", 3) || hasLong(o.long, "--copy", 3);
      const forced = o.shorts.includes("f") || o.shorts.includes("M") || o.shorts.includes("C") || hasLong(o.long, "--force", 3);
      if (mutate) {
        if (forced && protectedNow) return withDir(deny("protected", onProtectedMsg("git branch -f", branch)));
        const bad = o.pos.find((p) => isProt(p));
        if (bad) return withDir(deny("protected", protectedTargetMsg("git branch", bad)));
      } else if (!listy && o.pos[0] && isProt(o.pos[0])) {
        return withDir(deny("protected", protectedTargetMsg("git branch", o.pos[0])));
      }
      return null;
    }
    case "update-ref": {
      const o = parseOpts(rest, ["-m"]);
      const ref = o.pos[0];
      if (ref && (isProt(ref) || (ref === "HEAD" && protectedNow))) return withDir(deny("protected", protectedTargetMsg("git update-ref", ref === "HEAD" ? branch : ref)));
      if (o.long.includes("--stdin") && protectedNow) return withDir(deny("protected", onProtectedMsg("git update-ref --stdin", branch)));
      return null;
    }
    case "symbolic-ref": {
      const o = parseOpts(rest, ["-m"]);
      if (o.pos.length >= 2 && isProt(o.pos[0])) return withDir(deny("protected", protectedTargetMsg("git symbolic-ref", o.pos[0])));
      return null;
    }
    case "fetch": {
      const o = parseOpts(rest, ["--depth", "--deepen", "--shallow-since", "-j", "--jobs", "-o", "--upload-pack", "--refmap", "--recurse-submodules"]);
      const bad = o.pos.slice(1).map(refspecDst).find((d) => d && isProt(d));
      if (bad) return withDir(deny("protected", protectedTargetMsg("git fetch", bad)));
      return null;
    }
    default:
      return null;
  }
}

const KNOWN = new Set([
  "commit", "push", "merge", "rebase", "cherry-pick", "am", "revert", "pull", "reset", "checkout", "switch", "branch",
  "update-ref", "symbolic-ref", "fetch", "status", "log", "diff", "add", "show", "stash", "tag", "config", "clone", "init",
  "remote", "worktree", "rev-parse", "rev-list", "ls-files", "cat-file", "restore", "rm", "mv", "clean", "blame", "describe",
  "apply", "format-patch", "bisect", "reflog", "gc", "grep", "help", "version", "submodule", "ls-remote", "merge-base",
  "for-each-ref", "show-ref", "diff-tree", "write-tree", "commit-tree", "hash-object", "read-tree", "fsck", "prune",
  "shortlog", "notes", "archive", "bundle", "var", "symbolic-ref", "name-rev", "count-objects", "check-ignore",
]);

/** Destination branch of a fetch/pull refspec (`+src:dst` → dst), or null when it has no destination. */
function refspecDst(spec) {
  const s = String(spec).replace(/^\+/, "");
  const idx = s.indexOf(":");
  return idx < 0 ? null : s.slice(idx + 1) || null;
}

function evaluatePush(o, rest, { branch, protectedNow, info, isProt }) {
  const force = o.shorts.includes("f") || o.long.some((n) => pfx(n, "--force", 5) || n.startsWith("--force-"));
  if (force) return deny("always", "refused: force push is not allowed from agents.");
  if (hasLong(o.long, "--all", 4) || hasLong(o.long, "--mirror", 4)) {
    return deny("protected", `refused: git push --all/--mirror reaches protected refs; ${LAND_HINT}.`);
  }
  const repoOpt = (() => {
    const i = rest.findIndex((a) => a === "--repo" || a.startsWith("--repo="));
    return i < 0 ? null : rest[i].includes("=") ? rest[i].split("=")[1] : rest[i + 1];
  })();
  const remote = repoOpt ?? o.pos[0] ?? null;
  let specs = repoOpt ? o.pos : o.pos.slice(1);
  if (specs.length === 0) {
    // implicit push: remote.<name>.push, push.default=matching, or the current branch
    const cfg = info.config(`remote.${remote ?? "origin"}.push`, true);
    if (cfg.length) specs = cfg;
    else if (info.config("push.default")[0] === "matching") {
      return deny("protected", `refused: push.default=matching would push protected refs; ${LAND_HINT}.`);
    } else if (protectedNow) {
      return deny("protected", onProtectedMsg("git push", branch));
    } else return null;
  }
  for (const raw of specs) {
    if (raw.startsWith("+")) return deny("always", `refused: force push (+${raw.slice(1)}) is not allowed from agents.`);
    const idx = raw.indexOf(":");
    const src = idx < 0 ? raw : raw.slice(0, idx);
    let dst = idx < 0 ? raw : raw.slice(idx + 1) || raw.slice(0, idx);
    if (dst === "HEAD" || (idx < 0 && src === "HEAD")) dst = branch ?? "HEAD";
    if (dst.includes("*")) return deny("protected", `refused: wildcard push refspec '${raw}' can reach protected refs; ${LAND_HINT}.`);
    if (isProt(dst)) return deny("protected", protectedTargetMsg("git push", shortBranch(dst)));
  }
  return null;
}

// ------------------------------------------------------------------ evaluation of a whole command

/** First refusal in a shell command string (claude-hook) or an argv (shim). */
export function evaluateCommand(command, { cwd = process.cwd(), env = process.env } = {}) {
  const state = { vbranch: new Map() };
  for (const inv of findGitInvocations(command, cwd)) {
    const d = evaluateGit(inv, state, env);
    if (d) return d;
  }
  return null;
}

export function evaluateArgv(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const state = { vbranch: new Map() };
  return evaluateGit({ argv, cwd, assigns: [], pre: [] }, state, env);
}

// ------------------------------------------------------------------ git hook bodies

function currentInfo(env = process.env) {
  return repoInfo(process.cwd(), { env });
}

export function hookPreCommit(env = process.env) {
  const info = currentInfo(env);
  if (info.branch && isProtectedRef(info.branch, info.protected)) {
    if (consumeLandToken(info.commonDir, env)) return null;
    return onProtectedMsg("git commit", info.branch);
  }
  return null;
}

export function hookReferenceTransaction(state, lines, env = process.env) {
  if (state !== "prepared") return null;
  const info = currentInfo(env);
  for (const line of lines) {
    const [oldSha, newSha, ref] = line.trim().split(/\s+/);
    if (!ref || oldSha === newSha) continue;
    if (ref.startsWith("refs/heads/") && isProtectedRef(ref, info.protected)) {
      if (consumeLandToken(info.commonDir, env)) continue;
      return `refused: updating protected ref '${shortBranch(ref)}'; ${LAND_HINT}.`;
    }
  }
  return null;
}

export function hookPrePush(lines, env = process.env) {
  const info = currentInfo(env);
  for (const line of lines) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!remoteRef) continue;
    void localRef;
    if (remoteRef.startsWith("refs/heads/") && isProtectedRef(remoteRef, info.protected)) {
      if (consumeLandToken(info.commonDir, env)) continue;
      return protectedTargetMsg("git push", shortBranch(remoteRef));
    }
    if (localSha && remoteSha && !ZERO_SHA.test(localSha) && !ZERO_SHA.test(remoteSha)) {
      const anc = runGit(["merge-base", "--is-ancestor", remoteSha, localSha], { cwd: process.cwd(), env });
      if (anc.code !== 0) return `refused: non-fast-forward push to '${remoteRef}' is a force push; not allowed from agents.`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ modes

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

function claudeHook() {
  // Fail open: layer (a) git hooks and layer (c) GitHub branch protection back this up.
  try {
    const j = JSON.parse(readStdin() || "{}");
    if (j.tool_name !== "Bash") return;
    const command = j.tool_input?.command;
    if (typeof command !== "string" || !command) return;
    const d = evaluateCommand(command, { cwd: j.cwd || process.cwd(), env: process.env });
    if (!d) return;
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason },
    })}\n`);
  } catch { /* fail open */ }
}

function runShim(args) {
  const real = findRealGit(process.env);
  if (!real) { process.stderr.write("mola-guard: real git not found on PATH\n"); return 127; }
  let granted = null;
  try {
    const d = evaluateArgv(args, { cwd: process.cwd(), env: process.env });
    if (d) {
      if (d.kind === "protected" && consumeLandToken(d.commonDir, process.env)) granted = d.commonDir;
      else { process.stderr.write(`mola-guard: ${d.reason}\n`); return 1; }
    }
  } catch (e) {
    process.stderr.write(`mola-guard: internal error, falling through to the git hooks: ${e?.message ?? e}\n`);
  }
  const r = spawnSync(real, args, {
    stdio: "inherit",
    env: { ...process.env, PATH: stripShimDirs(process.env.PATH, process.env) },
  });
  if (granted) releaseGrant(granted);
  if (r.error) { process.stderr.write(`mola-guard: ${r.error.message}\n`); return 127; }
  if (r.status === null) return 128 + (os.constants.signals[r.signal] ?? 1);
  return r.status;
}

function gitHook(fn) {
  try {
    const msg = fn();
    if (msg) { process.stderr.write(`mola-guard: ${msg}\n`); return 1; }
    return 0;
  } catch (e) {
    process.stderr.write(`mola-guard: hook error (failing closed): ${e?.message ?? e}\n`);
    return 1;
  }
}

export function main(argv) {
  const [mode, ...rest] = argv;
  switch (mode) {
    case "claude-hook": claudeHook(); return 0;
    case "shim": return runShim(rest);
    case "pre-commit": return gitHook(() => hookPreCommit());
    case "pre-push": return gitHook(() => hookPrePush(readStdin().split("\n").filter(Boolean)));
    case "reference-transaction": return gitHook(() => hookReferenceTransaction(rest[0], rest[0] === "prepared" ? readStdin().split("\n").filter(Boolean) : []));
    default:
      process.stderr.write("usage: guard-git.mjs claude-hook | shim <git args> | pre-commit | pre-push | reference-transaction <state>\n");
      return 2;
  }
}

const entry = process.argv[1];
if (entry && realPathSafe(fileURLToPath(import.meta.url)) === realPathSafe(entry)) {
  process.exitCode = main(process.argv.slice(2));
}
