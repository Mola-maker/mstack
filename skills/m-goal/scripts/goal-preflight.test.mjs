// Tests for the goal-file preflight in `goal-state.mjs init`. Run: node --test "skills/m-goal/scripts/*.test.mjs"
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("./goal-state.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const run = (args) => {
  try {
    return { out: execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(), err: "", code: 0 };
  } catch (e) {
    return { out: String(e.stdout ?? "").trim(), err: String(e.stderr ?? "").trim(), code: e.status };
  }
};

const BOUNDARIES = "- Boundaries: <worktree or branch, what it may write, what it must not run>";
const OUTPUT = "- Output & approver: <where the result lands, who signs off on irreversible actions>";
const goalFile = (boundaries, output) =>
  ["# Goal: demo", "", "- Created: 2026-11-12T00:00:00Z", "- Budget: attempt cap 3 per task", "- Stop conditions: none", boundaries, output, "", "## Sub-goals", ""]
    .filter((l) => l !== null)
    .join("\n");
const setup = (content) => {
  const dir = mkdtempSync(join(tmpdir(), "goal-preflight-"));
  if (content !== undefined) writeFileSync(join(dir, "demo.md"), content);
  return dir;
};
const init = (dir) => run(["init", dir, "demo", "--start-commit", "abc1234"]);
const stateFile = (dir) => join(dir, "demo.state.json");

test("init fails when the Boundaries line is missing", () => {
  const dir = setup(goalFile(null, "- Output & approver: PR to main, owner approves merges"));
  const r = init(dir);
  if (r.code === 0) throw new Error(`expected non-zero exit, got ${r.out}`);
  if (!/Boundaries/.test(r.err)) throw new Error(`error should name Boundaries: ${r.err}`);
  if (existsSync(stateFile(dir))) throw new Error("state file written despite failure");
});

test("init fails when the Output & approver line is missing", () => {
  const dir = setup(goalFile("- Boundaries: worktree wt-a, may write skills/, must not push", null));
  const r = init(dir);
  if (r.code === 0) throw new Error(`expected non-zero exit, got ${r.out}`);
  if (!/Output & approver/.test(r.err)) throw new Error(`error should name Output & approver: ${r.err}`);
  if (existsSync(stateFile(dir))) throw new Error("state file written despite failure");
});

test("init fails when a placeholder is left unchanged, naming that line", () => {
  const dir = setup(goalFile(BOUNDARIES, "- Output & approver: PR to main, owner approves merges"));
  const r = init(dir);
  if (r.code === 0) throw new Error(`expected non-zero exit, got ${r.out}`);
  if (!/Boundaries/.test(r.err) || /Output & approver/.test(r.err)) throw new Error(`error should name only Boundaries: ${r.err}`);
  const dir2 = setup(goalFile("- Boundaries: worktree wt-a, may write skills/, must not push", OUTPUT));
  const r2 = init(dir2);
  if (r2.code === 0 || !/Output & approver/.test(r2.err)) throw new Error(`placeholder Output & approver not rejected: ${r2.err}`);
  if (existsSync(stateFile(dir)) || existsSync(stateFile(dir2))) throw new Error("state file written despite failure");
});

test("a complete goal file inits and writes state as before", () => {
  const dir = setup(goalFile("- Boundaries: worktree wt-a, may write skills/, must not push", "- Output & approver: PR to main, owner approves merges"));
  const r = init(dir);
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err}`);
  const s = JSON.parse(readFileSync(stateFile(dir), "utf8"));
  if (s.startCommit !== "abc1234" || s.status !== "active" || s.rounds !== 0 || s.minRounds !== 3) throw new Error(`bad state: ${JSON.stringify(s)}`);
});

test("no goal file: init behaves as before", () => {
  const dir = setup();
  const r = init(dir);
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err}`);
  if (JSON.parse(readFileSync(stateFile(dir), "utf8")).startCommit !== "abc1234") throw new Error("state not written");
});
