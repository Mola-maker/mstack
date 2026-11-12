#!/usr/bin/env node
// Verify receipts: which acceptance level (references/ladder.md) the CURRENT code has been proven at.
//
//   node receipt.mjs tree  [--timeout-ms <n>]
//   node receipt.mjs write --level <0-5> --cmd "<command>" --exit <n> [--log <path>] [--timeout-ms <n>]
//   node receipt.mjs check [--required <0-5>] [--timeout-ms <n>]
//
// A receipt lives in .mstack/verify/receipts/<tree>.json and is keyed by the working-tree hash,
// so any edit (tracked or untracked) leaves it behind. Exit: 0 ok, 1 check failed, 2 usage, no git repo,
// or the hash could not be computed (git error, or the deadline given by --timeout-ms /
// MSTACK_RECEIPT_TIMEOUT_MS ran out; the temp index is removed either way).
import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SETUP_TIMEOUT_MS = 10000; // rev-parse calls: cheap, never part of the hashing deadline

class Usage extends Error {}

const run = (args, cwd, { env, timeout, stderrFd } = {}) =>
  execFileSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", stderrFd ?? "pipe"],
  }).trim();

function toplevel() {
  try {
    return run(["rev-parse", "--show-toplevel"], process.cwd(), { timeout: SETUP_TIMEOUT_MS });
  } catch {
    throw new Usage("not inside a git repository");
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// Temp indexes live in <gitdir>/mstack-tmp/index.<pid>; ones left by a process that no longer exists are removed.
function sweep(dir) {
  try {
    for (const f of readdirSync(dir)) {
      const m = f.match(/^index\.(\d+)(\.err)?$/);
      if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) rmSync(join(dir, f), { force: true });
    }
  } catch { /* directory not there yet */ }
}

const lastLine = (path) => {
  try {
    const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !/^warning:/.test(l));
    return lines.at(-1) ?? "";
  } catch {
    return "";
  }
};

// Hash of the working tree: the real index is copied to a temp file, everything non-ignored is added there
// (uncommitted and untracked included), .mstack/ is dropped, and the temp index is written as a tree.
// The real index is only read. git's stderr goes to a file, not a pipe: with core.autocrlf it prints one
// warning per file, which overflowed a pipe buffer on large trees.
function treeHash(root, timeoutMs) {
  const real = run(["rev-parse", "--git-path", "index"], root, { timeout: SETUP_TIMEOUT_MS });
  const realPath = isAbsolute(real) ? real : resolve(root, real);
  const tmpRoot = resolve(root, run(["rev-parse", "--git-path", "mstack-tmp"], root, { timeout: SETUP_TIMEOUT_MS }));
  mkdirSync(tmpRoot, { recursive: true });
  sweep(tmpRoot);
  const idx = join(tmpRoot, `index.${process.pid}`);
  const errFile = `${idx}.err`;
  const deadline = Date.now() + timeoutMs;
  let fd;
  const step = (args) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Usage(`tree hash timed out after ${timeoutMs} ms`);
    try {
      return run(args, root, { env: { GIT_INDEX_FILE: idx }, timeout: left, stderrFd: fd });
    } catch (e) {
      if (e.code === "ETIMEDOUT") throw new Usage(`tree hash timed out after ${timeoutMs} ms`);
      const why = lastLine(errFile) || String(e.stderr ?? "").trim().split("\n").at(-1) || e.code || e.signal || "";
      throw new Usage(`git ${args.find((a) => /^[a-z]/.test(a) && !a.includes("=")) ?? args[0]} failed (exit ${e.status ?? "none"}${why ? `: ${why}` : ""})`);
    }
  };
  try {
    if (existsSync(realPath)) copyFileSync(realPath, idx);
    fd = openSync(errFile, "w");
    step(["-c", "core.safecrlf=false", "add", "-A", "--", ".", ":!.mstack"]);
    step(["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ".mstack"]);
    return step(["write-tree"]);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(idx, { force: true });
    rmSync(errFile, { force: true });
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

const deadlineMs = (f) => {
  const v = f["timeout-ms"] ?? process.env.MSTACK_RECEIPT_TIMEOUT_MS ?? "60000";
  if (!/^[1-9]\d*$/.test(String(v))) throw new Usage("--timeout-ms must be a positive integer");
  return Number(v);
};

// Highest level proven: the highest passing check, capped below the lowest failing one.
function levelOf(checks) {
  const passed = checks.filter((c) => c.exit === 0).map((c) => c.level);
  const failed = checks.filter((c) => c.exit !== 0).map((c) => c.level);
  const top = passed.length ? Math.max(...passed) : -1;
  return failed.length ? Math.min(top, Math.min(...failed) - 1) : top;
}

const validCheck = (c) =>
  c !== null && typeof c === "object" && Number.isInteger(c.level) && c.level >= 0 && c.level <= 5 &&
  typeof c.cmd === "string" && Number.isInteger(c.exit);

const receiptFile = (root, tree) => join(root, ".mstack", "verify", "receipts", `${tree}.json`);

// null: no usable file. { malformed: true }: parsed but fails validation. Otherwise the validated receipt.
function readReceipt(file, tree) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (doc?.tree !== tree || !Array.isArray(doc.checks) || !doc.checks.every(validCheck)) return { malformed: true };
  return doc;
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
    const f = flags(rest);
    console.log(treeHash(toplevel(), deadlineMs(f)));
    return 0;
  }
  if (cmd === "write") {
    const f = flags(rest);
    if (f.cmd === undefined) throw new Usage("--cmd is required");
    const lvl = level(f.level, "--level");
    if (!/^-?\d+$/.test(f.exit ?? "")) throw new Usage("--exit must be an integer");
    const root = toplevel();
    const tree = treeHash(root, deadlineMs(f));
    const file = receiptFile(root, tree);
    const prev = readReceipt(file, tree);
    // a re-run of the same command at the same level replaces its earlier result; a malformed receipt is replaced whole
    const checks = (prev && !prev.malformed ? prev.checks : []).filter((c) => !(c.level === lvl && c.cmd === f.cmd));
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
    const tree = treeHash(root, deadlineMs(f));
    const doc = readReceipt(receiptFile(root, tree), tree);
    const found = doc && !doc.malformed ? levelOf(doc.checks) : null; // recomputed: the stored `level` is not trusted
    if (found !== null && found >= required) return 0;
    const seen = doc?.malformed ? "no valid receipt (the stored one is malformed and ignored)" : found === null ? "no receipt" : found < 0 ? "no passing check" : `L${found}`;
    console.log(
      `verify gate: required L${required}, found ${seen} for the current code (tree ${tree.slice(0, 12)}); ` +
      `run the L${required} check, then: node "${SELF}" write --level ${required} --cmd "<command>" --exit <n>`,
    );
    return 1;
  }
  throw new Usage("usage: receipt.mjs tree | write --level <0-5> --cmd <command> --exit <n> [--log <path>] | check [--required <0-5>]  (all take [--timeout-ms <n>])");
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Usage ? `receipt: ${e.message}` : `receipt: ${String(e.stderr || e.message).split("\n")[0]}`);
  process.exitCode = 2;
}
