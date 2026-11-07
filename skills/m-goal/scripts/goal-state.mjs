#!/usr/bin/env node
// m-goal loop-state tracker. Zero dependencies, cross-platform.
//
// Usage (run at every checkpoint — see m-goal SKILL.md step 4):
//   node goal-state.mjs record <dir> <slug> [--round] [--fail <signature>] [--progress] [--tokens N] [--budget PCT] [--status active|done|failed]
//   node goal-state.mjs init   <dir> <slug> --start-commit <sha> [--min-rounds N]
//   node goal-state.mjs status <dir> <slug>
//
// <dir> is the directory holding <slug>.state.json (usually .mstack/goals).
// record/status print one line: `<ok|warn|stop> rounds=N tokens=N budget=N% status=<s> <reasons>`.
// Exit codes: 0 = ok/warn, 1 = stop, 2 = usage error, unreadable/corrupt state
// file, or a write failure. A corrupt state file is NEVER silently reset: fix or
// delete it by hand and rerun.
// Failure counting is CONSECUTIVE, matching principle 9 ("3 in a row"):
//   --fail <sig>  increments that signature's run-of-failures by 1;
//   --progress    means a sub-goal verifiably advanced, so every counter
//                 resets to 0 and lastProgressAt moves to now.
// A ROUND is one completed verify pass over the goal's acceptance criteria. `rounds`
// goes up only when the caller passes --round; a plain record (a failure note, a token
// update) never counts. `--status done` exits 1 and leaves the status unchanged while
// rounds < minRounds (set by init --min-rounds, default 3).
// stop = any signature at 3 consecutive failures, or budgetPct >= 100.
// warn = budgetPct >= 90.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MIN_ROUNDS = 3;
const STATUSES = new Set(["active", "done", "failed"]);
const [, , cmd, dir, slug, ...rest] = process.argv;
const usage = "usage: goal-state.mjs record <dir> <slug> [--round] [--fail sig] [--progress] [--tokens N] [--budget PCT] [--status active|done|failed]\n" +
  "       goal-state.mjs init <dir> <slug> --start-commit <sha> [--min-rounds N]\n" +
  "       goal-state.mjs status <dir> <slug>";
if (!["record", "init", "status"].includes(cmd ?? "") || !dir || !slug) {
  console.error(usage);
  process.exit(2);
}

const file = join(dir, `${slug}.state.json`);
const now = new Date().toISOString();
const fresh = () => ({ slug, status: "active", startCommit: null, minRounds: DEFAULT_MIN_ROUNDS, rounds: 0, tokensUsed: 0, budgetPct: 0, failures: {}, lastProgressAt: null, updatedAt: now });

// Corrupt state file = exit 2, never a silent reset. Parseable JSON with the
// wrong shape counts as corrupt too.
function load() {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    console.error(`goal-state: cannot read ${file}: ${e.message} — fix or delete it by hand; refusing to guess`);
    process.exit(2);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.error(`goal-state: ${file} is not valid JSON (${e.message}) — fix or delete it by hand; refusing to overwrite it`);
    process.exit(2);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || typeof raw.failures !== "object" || raw.failures === null
    || !Object.values(raw.failures).every((n) => Number.isFinite(n))
    || ![raw.rounds, raw.minRounds, raw.tokensUsed, raw.budgetPct].every((n) => n === undefined || Number.isFinite(n))) {
    console.error(`goal-state: ${file} has an unexpected shape (failures/rounds/tokens/budget) — fix it by hand; refusing to overwrite it`);
    process.exit(2);
  }
  return { ...fresh(), ...raw };
}

function save(state) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  } catch (e) {
    console.error(`cannot write ${file}: ${e.message}`);
    process.exit(2);
  }
}

if (cmd === "init") {
  const existing = load();
  let startCommit = null;
  let minRounds = DEFAULT_MIN_ROUNDS;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--start-commit") {
      startCommit = rest[++i] ?? null;
      continue;
    }
    if (rest[i] === "--min-rounds") {
      const v = rest[++i];
      if (!/^[1-9][0-9]*$/.test(v ?? "")) {
        console.error("--min-rounds needs a positive integer");
        process.exit(2);
      }
      minRounds = +v;
      continue;
    }
    console.error(`unknown or incomplete flag: ${rest[i]}`);
    process.exit(2);
  }
  if (!startCommit) {
    console.error("--start-commit <sha> is required (the commit m-verify's baseline was saved against)");
    process.exit(2);
  }
  if (existing && existing.status === "active") {
    console.error(`goal-state: ${file} already exists and is active — refusing to re-init`);
    process.exit(2);
  }
  const state = fresh();
  state.startCommit = startCommit;
  state.minRounds = minRounds;
  save(state);
  console.log(`ok rounds=0 min=${minRounds} tokens=0 budget=0% status=active baseline commit ${startCommit}`);
  process.exit(0);
}

const state = load() ?? fresh();
let rejected = null;

if (cmd === "record") {
  let progress = false;
  let round = false;
  let wantStatus = null;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--progress") { progress = true; continue; }
    if (flag === "--round") { round = true; continue; }
    const val = rest[++i];
    if (flag === "--fail" && val) state.failures[val] = (state.failures[val] ?? 0) + 1;
    else if (flag === "--tokens" && Number.isFinite(+val)) state.tokensUsed = +val;
    else if (flag === "--budget" && Number.isFinite(+val)) state.budgetPct = Math.max(0, Math.min(100, +val));
    else if (flag === "--status" && STATUSES.has(val)) wantStatus = val;
    else {
      console.error(`unknown or incomplete flag: ${flag}${flag === "--status" ? ` (want one of ${[...STATUSES].join("|")})` : ""}`);
      process.exit(2);
    }
  }
  if (progress) {
    // A verifiable step of progress breaks the failure run and moves the clock.
    state.failures = {};
    state.lastProgressAt = now;
  }
  if (round) state.rounds += 1;
  if (wantStatus === "done" && state.rounds < state.minRounds) {
    rejected = `status done rejected: rounds ${state.rounds} < min ${state.minRounds} (finish another verify pass and record it with --round)`;
  } else if (wantStatus) state.status = wantStatus;
  state.updatedAt = now;
  save(state);
}

const reasons = [];
for (const [sig, n] of Object.entries(state.failures)) if (n >= 3) reasons.push(`signature "${sig}" failed ${n} times in a row`);
if (rejected) reasons.push(rejected);
if (state.budgetPct >= 100) reasons.push(`budget ${state.budgetPct}% used`);
const verdict = reasons.length ? "stop" : state.budgetPct >= 90 ? "warn" : "ok";
if (verdict === "warn") reasons.push(`budget ${state.budgetPct}% used (warns at 90%)`);

console.log(`${verdict} rounds=${state.rounds} min=${state.minRounds} tokens=${state.tokensUsed} budget=${state.budgetPct}% status=${state.status}${reasons.length ? " " + reasons.join("; ") : ""}`);
process.exit(verdict === "stop" ? 1 : 0);
