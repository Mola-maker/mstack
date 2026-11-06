#!/usr/bin/env node
// m-verify mechanical scan: flag fake-green markers in ADDED lines.
// Usage: node "<this skill dir>/scripts/diff-blockers.mjs" [base-ref]
//   no ref  → uncommitted changes vs HEAD, plus untracked files
//   with ref → working tree vs that commit (commits since the ref included), plus untracked files
//   m-goal passes the startCommit it recorded before the first edit.
// Exit codes: 0 = no blockers, 1 = blockers found (not done), 2 = could not run.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// The two spellings of "not implemented" from the spec collapse into one case-insensitive regex.
const PATTERNS = [
  [".only(", /\.only\(/],
  [".skip(", /\.skip\(/],
  ["TODO", /\bTODO\b/],
  ["FIXME", /\bFIXME\b/],
  ["NotImplemented", /not[ _-]?implemented/i],
  ["debugger", /\bdebugger\b/],
];

const usage = 'Usage: node "<this skill dir>/scripts/diff-blockers.mjs" [base-ref]\n' +
  "  no ref: uncommitted changes vs HEAD, plus untracked files\n" +
  "  ref:    working tree vs that commit, plus untracked files\n" +
  "  m-goal passes .mstack/goals/<slug>.state.json startCommit";

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] ?? "").startsWith("-")) {
  console.error(usage);
  process.exit(2);
}
const base = args[0] ?? "HEAD";

function git(gitArgs) {
  return spawnSync("git", gitArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const run = git(["diff", "--no-color", "--no-ext-diff", base]);
if (run.error) {
  console.error(`diff-blockers: cannot run git: ${run.error.message}`);
  process.exit(2);
}
if ((run.status ?? 1) > 1) {
  console.error(`diff-blockers: git diff ${base} failed:\n${(run.stderr || "").trim()}`);
  process.exit(2);
}

const hits = [];
function consider(file, lineNo, text) {
  for (const [name, re] of PATTERNS) if (re.test(text)) hits.push({ file, line: lineNo, name, text: text.trim() });
}

// Walk the unified diff: track the new-side file, the new-side line cursor, and test only `+` lines.
let file = null;
let line = 0;
for (const raw of (run.stdout || "").split("\n")) {
  const l = raw.replace(/\r$/, "");
  const head = l.match(/^\+\+\+ (.+)$/);
  if (head) { file = head[1] === "/dev/null" ? null : head[1].replace(/^b\//, ""); continue; }
  const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (hunk) { line = parseInt(hunk[1], 10); continue; }
  if (file === null) continue;
  if (l.startsWith("+")) {
    consider(file, line, l.slice(1));
    line++;
  } else if (l.startsWith(" ") || l === "") {
    line++; // context lines advance the new-side cursor; deletions do not
  }
}

// Untracked files are not in `git diff`. Scan each as all-added.
const listed = git(["ls-files", "--others", "--exclude-standard", "-z"]);
if (listed.error) {
  console.error(`diff-blockers: cannot list untracked files: ${listed.error.message}`);
  process.exit(2);
}
if ((listed.status ?? 1) !== 0) {
  console.error(`diff-blockers: git ls-files failed:\n${(listed.stderr || "").trim()}`);
  process.exit(2);
}
const untracked = (listed.stdout || "").split("\0").filter(Boolean);
for (const rel of untracked) {
  let buf;
  try {
    buf = readFileSync(join(process.cwd(), rel));
  } catch (error) {
    console.error(`diff-blockers: cannot read untracked ${rel}: ${error.message}`);
    process.exit(2);
  }
  if (buf.includes(0)) continue; // binary; git would not show added lines either
  const lines = buf.toString("utf8").split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.forEach((text, i) => consider(rel, i + 1, text));
}

const where = `git diff ${base} (${untracked.length} untracked file(s))`;
if (hits.length === 0) {
  console.log(`diff-blockers: OK — no blockers in added lines of ${where}`);
  process.exit(0);
}
console.log(`diff-blockers: FAIL — ${hits.length} blocker(s) in added lines of ${where}`);
for (const h of hits) console.log(`  ${h.file}:${h.line}: ${h.name} | ${h.text}`);
process.exit(1);
