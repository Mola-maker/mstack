#!/usr/bin/env node
// Verify receipts: which acceptance level (references/ladder.md) the CURRENT code has been proven at.
//
//   node receipt.mjs tree
//   node receipt.mjs write --level <0-5> --cmd "<command>" --exit <n> [--log <path>]
//   node receipt.mjs check [--required <0-5>]
//
// A receipt lives in .mstack/verify/receipts/<tree>.json and is keyed by the working-tree hash,
// so any edit (tracked or untracked) leaves it behind. Exit: 0 ok, 1 check failed, 2 usage or no git repo.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

class Usage extends Error {}

const git = (args, cwd, env) =>
  execFileSync("git", args, { cwd, env: env ? { ...process.env, ...env } : process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function toplevel() {
  try {
    return git(["rev-parse", "--show-toplevel"], process.cwd());
  } catch {
    throw new Usage("not inside a git repository");
  }
}

// Hash of the working tree: the real index is copied to a temp file, everything non-ignored is added there
// (uncommitted and untracked included), .mstack/ is dropped, and the temp index is written as a tree.
// The real index is only read.
function treeHash(root) {
  const dir = mkdtempSync(join(tmpdir(), "mstack-tree-"));
  const idx = join(dir, "index");
  try {
    const real = git(["rev-parse", "--git-path", "index"], root);
    const realPath = isAbsolute(real) ? real : resolve(root, real);
    if (existsSync(realPath)) copyFileSync(realPath, idx);
    const env = { GIT_INDEX_FILE: idx };
    git(["add", "-A", "--", ".", ":!.mstack"], root, env);
    git(["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ".mstack"], root, env);
    return git(["write-tree"], root, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Usage(`unexpected argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined) throw new Usage(`${a} needs a value`);
    out[a.slice(2)] = v;
    i++;
  }
  return out;
}

const level = (v, name) => {
  if (!/^[0-5]$/.test(String(v))) throw new Usage(`${name} must be 0-5`);
  return Number(v);
};

// Highest level proven: the highest passing check, capped below the lowest failing one.
function levelOf(checks) {
  const passed = checks.filter((c) => c.exit === 0).map((c) => c.level);
  const failed = checks.filter((c) => c.exit !== 0).map((c) => c.level);
  const top = passed.length ? Math.max(...passed) : -1;
  return failed.length ? Math.min(top, Math.min(...failed) - 1) : top;
}

const receiptFile = (root, tree) => join(root, ".mstack", "verify", "receipts", `${tree}.json`);

function readReceipt(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function requiredLevel(root, given) {
  if (given !== undefined) return level(given, "--required");
  try {
    const m = readFileSync(join(root, ".claude", "skills", "verify", "SKILL.md"), "utf8").match(/^\s*Required level:\s*L([0-5])\b/m);
    if (m) return Number(m[1]);
  } catch { /* no project verify skill */ }
  return 1;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "tree") {
    console.log(treeHash(toplevel()));
    return 0;
  }
  if (cmd === "write") {
    const f = flags(rest);
    if (f.cmd === undefined) throw new Usage("--cmd is required");
    const lvl = level(f.level, "--level");
    if (!/^-?\d+$/.test(f.exit ?? "")) throw new Usage("--exit must be an integer");
    const root = toplevel();
    const tree = treeHash(root);
    const file = receiptFile(root, tree);
    const prev = readReceipt(file);
    // a re-run of the same command at the same level replaces its earlier result
    const checks = (prev?.tree === tree ? prev.checks : []).filter((c) => !(c.level === lvl && c.cmd === f.cmd));
    checks.push({ level: lvl, cmd: f.cmd, exit: Number(f.exit), log: f.log ?? null });
    const doc = { tree, level: levelOf(checks), checks, ts: new Date().toISOString() };
    mkdirSync(join(root, ".mstack", "verify", "receipts"), { recursive: true });
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`receipt L${doc.level} for tree ${tree.slice(0, 12)}`);
    return 0;
  }
  if (cmd === "check") {
    const f = flags(rest);
    const root = toplevel();
    const required = requiredLevel(root, f.required);
    const tree = treeHash(root);
    const doc = readReceipt(receiptFile(root, tree));
    const found = doc && doc.tree === tree && Number.isInteger(doc.level) ? doc.level : null;
    if (found !== null && found >= required) return 0;
    console.log(
      `verify gate: required L${required}, found ${found === null ? "no receipt" : found < 0 ? "no passing check" : `L${found}`} for the current code (tree ${tree.slice(0, 12)}); ` +
      `run the L${required} check, then: node "${SELF}" write --level ${required} --cmd "<command>" --exit <n>`,
    );
    return 1;
  }
  throw new Usage("usage: receipt.mjs tree | write --level <0-5> --cmd <command> --exit <n> [--log <path>] | check [--required <0-5>]");
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Usage ? `receipt: ${e.message}` : `receipt: ${String(e.stderr || e.message).split("\n")[0]}`);
  process.exitCode = 2;
}
