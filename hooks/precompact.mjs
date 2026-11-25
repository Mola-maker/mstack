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

// ---- mechanical excerpt (after T3 Code's portable handoffs): a budgeted selection of the transcript's own
// words, not a summary. The first user request stays verbatim; then the most recent user/assistant turns and
// command outcomes, newest kept first, until the budget is spent; what was left out is counted and the full
// transcript path is given so the next session can read more.
const EXCERPT_BUDGET = 16000; // bytes ≈ tokens, counted conservatively
const FIRST_MAX = 4000;
const TURN_MAX = 2000;

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
};
const cut = (t, max) => (Buffer.byteLength(t) <= max ? t : `${Buffer.from(t).subarray(0, max).toString("utf8").replace(/\uFFFD$/, "")} …(cut)`);

export function transcriptItems(text) {
  const items = [];
  const commands = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isMeta || d.isSidechain) continue;
    const content = d.message?.content;
    if (d.type === "user") {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_result" && commands.has(b.tool_use_id)) {
            items.push({ role: "command", text: `${commands.get(b.tool_use_id)} → ${b.is_error ? "FAILED" : "ok"}` });
          }
        }
      }
      const t = textOf(content).trim();
      if (t && !t.startsWith("<command-") && !t.startsWith("<local-command")) items.push({ role: "user", text: t });
    } else if (d.type === "assistant") {
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === "tool_use" && b.name === "Bash" && typeof b.input?.command === "string") commands.set(b.id, `$ ${b.input.command.split("\n")[0].slice(0, 200)}`);
      }
      const t = textOf(content).trim();
      if (t) items.push({ role: "assistant", text: t });
    }
  }
  return items;
}

export function selectExcerpt(items, budget = EXCERPT_BUDGET) {
  const firstIdx = items.findIndex((i) => i.role === "user");
  const out = [];
  let used = 0;
  if (firstIdx >= 0) {
    const t = cut(items[firstIdx].text, FIRST_MAX);
    out.push({ ...items[firstIdx], text: t, first: true });
    used += Buffer.byteLength(t);
  }
  const recent = [];
  for (let i = items.length - 1; i > firstIdx; i--) {
    const t = cut(items[i].text, TURN_MAX);
    const size = Buffer.byteLength(t) + 16;
    if (used + size > budget) break;
    used += size;
    recent.unshift({ ...items[i], text: t, index: i });
  }
  const omitted = items.length - recent.length - (firstIdx >= 0 ? 1 : 0);
  return { first: out[0], recent, omitted, bytes: used };
}

function writeExcerpt(dir, transcriptPath) {
  let text;
  try { text = readFileSync(transcriptPath, "utf8"); } catch { return null; }
  const sel = selectExcerpt(transcriptItems(text));
  if (!sel.first && sel.recent.length === 0) return null;
  const label = { user: "USER", assistant: "ASSISTANT", command: "COMMAND" };
  const body = [
    "# Handoff excerpt (mechanical)",
    "",
    `Verbatim words from the transcript, selected to fit ${EXCERPT_BUDGET} bytes; not a summary. ${sel.omitted} item(s) left out — read them in: ${transcriptPath}`,
    "",
    ...(sel.first ? ["## Original request", "", sel.first.text, ""] : []),
    "## Most recent, in order",
    "",
    ...sel.recent.map((i) => `**${label[i.role]}:** ${i.text}\n`),
  ].join("\n");
  const file = join(dir, "handoff-excerpt.md");
  writeFileSync(file, body + "\n");
  return { file: "handoff-excerpt.md", omitted: sel.omitted };
}

try {
  let cwd = process.cwd();
  let transcriptPath = "";
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  await new Promise((resolve) => process.stdin.on("end", resolve).on("error", resolve));
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof payload?.cwd === "string" && payload.cwd) cwd = payload.cwd;
    if (typeof payload?.transcript_path === "string") transcriptPath = payload.transcript_path;
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
  const excerpt = transcriptPath ? writeExcerpt(dir, transcriptPath) : null;

  const section = [
    `## Auto snapshot — ${new Date().toISOString()}`,
    "",
    `- branch: ${branch}`,
    `- goal: ${activeGoal(join(dir, "goals"))}`,
    "- `git status --short`:",
    "```",
    statusText,
    "```",
    ...(excerpt ? [`- excerpt: .mstack/${excerpt.file} (original request + recent turns verbatim; ${excerpt.omitted} left out)`] : []),
    "",
    "Mechanical snapshot only — decisions and next steps still need a hand-written m-handoff pass.",
    "",
  ].join("\n");

  writeFileSync(file, (kept && !kept.endsWith("\n") ? `${kept}\n` : kept) + section);
} catch {
  // Never block compaction.
}
process.exit(0);
