#!/usr/bin/env node
// PreCompact hook (m-handoff safety net). Writes one "## Auto snapshot" section
// into .mstack/handoff.md — branch, `git status --short`, current goal path,
// timestamp — replacing any earlier auto-snapshot section instead of appending
// another one. Never uses the network. Exits 0 on any error and prints nothing
// to stdout, so a failure can never block the compaction.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_STATUS_CHARS = 4000;
// Two git calls per run; each must be short so the hook stays well under 1 s.
const TIMEOUT_MS = 300;

const git = (args, cwd, timeout = TIMEOUT_MS) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

// Branch name: symbolic-ref works even when the repo has no commits yet
// (rev-parse --abbrev-ref HEAD fails with "ambiguous argument 'HEAD'" there).
const branchOf = (cwd) => {
  if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") return "(not a git repo)";
  const name = git(["symbolic-ref", "--short", "HEAD"], cwd);
  if (!name) return "(detached HEAD)";
  return git(["rev-parse", "--verify", "-q", "HEAD"], cwd) === null ? `${name} (no commits yet)` : name;
};

// The goal currently being worked on: the newest .md under goals/ whose
// sibling <slug>.state.json says `"status": "active"`. A goal with no state
// file, or a closed one (done/failed), is not the active goal.
const activeGoal = (dir) => {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    let best = null;
    for (const f of files) {
      let state;
      try { state = JSON.parse(readFileSync(join(dir, f.replace(/\.md$/, ".state.json")), "utf8")); } catch { continue; }
      if (state?.status !== "active") continue;
      const mtime = statSync(join(dir, f)).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: join(dir, f), mtime };
    }
    return best ? best.path : "none";
  } catch {
    return "none";
  }
};

const SNAPSHOT_HEAD = /^## Auto snapshot/;

// Keep everything before the first auto-snapshot section and drop that section
// plus every later one, so repeated compactions replace instead of growing.
const withoutSnapshots = (text) => {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => SNAPSHOT_HEAD.test(l));
  if (first < 0) return text;
  return lines.slice(0, first).join("\n").replace(/\n+$/, "\n");
};

try {
  let cwd = process.cwd();
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  await new Promise((resolve) => process.stdin.on("end", resolve).on("error", resolve));
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof payload?.cwd === "string" && payload.cwd) cwd = payload.cwd;
  } catch { /* stdin was empty or not JSON — fall back to process.cwd() */ }

  // only projects that already use mstack get a snapshot: never create .mstack/ in other repos
  if (!existsSync(join(cwd, ".mstack"))) process.exit(0);

  const branch = branchOf(cwd);
  // git status runs while compaction loads the machine: 300 ms was too tight in real use (snapshot said "git status failed")
  const status = git(["status", "--short"], cwd, 800);
  const statusText = status === null ? "(git status failed)" : status.slice(0, MAX_STATUS_CHARS);

  const dir = join(cwd, ".mstack");
  const file = join(dir, "handoff.md");
  mkdirSync(dir, { recursive: true });
  let existing = "";
  try { existing = readFileSync(file, "utf8"); } catch { /* new file */ }
  const kept = withoutSnapshots(existing);

  const section = [
    `## Auto snapshot — ${new Date().toISOString()}`,
    "",
    `- branch: ${branch}`,
    `- goal: ${activeGoal(join(dir, "goals"))}`,
    "- `git status --short`:",
    "```",
    statusText,
    "```",
    "",
    "Mechanical snapshot only — decisions and next steps still need a hand-written m-handoff pass.",
    "",
  ].join("\n");

  writeFileSync(file, (kept && !kept.endsWith("\n") ? `${kept}\n` : kept) + section);
} catch {
  // Never block compaction.
}
process.exit(0);
