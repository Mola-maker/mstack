// Tests for goal-state.mjs. Run: node --test "skills/m-goal/scripts/*.test.mjs"
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("./goal-state.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const run = (args, opts = {}) => {
  try {
    return { out: execFileSync(process.execPath, [script, ...args], { encoding: "utf8", ...opts }).trim(), code: 0 };
  } catch (e) {
    return { out: String(e.stdout ?? "").trim(), err: String(e.stderr ?? "").trim(), code: e.status };
  }
};
const state = (dir) => JSON.parse(readFileSync(join(dir, "demo.state.json"), "utf8"));

test("record creates state file and reports ok", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-state-"));
  const r = run(["record", dir, "demo", "--progress", "--tokens", "1200", "--budget", "40"]);
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err}`);
  if (!r.out.startsWith("ok ")) throw new Error(`unexpected verdict: ${r.out}`);
  const s = state(dir);
  if (s.rounds !== 1 || s.tokensUsed !== 1200 || s.budgetPct !== 40 || !s.lastProgressAt) throw new Error(`bad state: ${r.out}`);
  if (s.status !== "active") throw new Error(`expected default status active, got ${s.status}`);
});

test("init records the start commit and refuses to re-init an active goal", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-state-"));
  const r = run(["init", dir, "demo", "--start-commit", "abc1234"]);
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err}`);
  const s = state(dir);
  if (s.startCommit !== "abc1234" || s.status !== "active" || s.rounds !== 0) throw new Error(`bad init state: ${JSON.stringify(s)}`);
  const again = run(["init", dir, "demo", "--start-commit", "def5678"]);
  if (again.code !== 2) throw new Error(`expected exit 2 on re-init, got ${again.code}: ${again.out}`);
  if (state(dir).startCommit !== "abc1234") throw new Error("re-init overwrote the start commit");
});

test("same signature 3 times -> stop with exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-state-"));
  run(["record", dir, "demo", "--fail", "E_TIMEOUT x"]);
  run(["record", dir, "demo", "--fail", "E_TIMEOUT x"]);
  const third = run(["record", dir, "demo", "--fail", "E_TIMEOUT x"]);
  if (third.code !== 1 || !third.out.startsWith("stop")) throw new Error(`expected stop/1, got ${third.code}: ${third.out}`);
  if (!third.out.includes("in a row")) throw new Error(`expected "in a row" wording: ${third.out}`);
});

test("failures are consecutive: --progress resets every counter (bug regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-state-"));
  run(["record", dir, "demo", "--fail", "E_TIMEOUT x"]);
  run(["record", dir, "demo", "--fail", "E_TIMEOUT x"]);
  const recovered = run(["record", dir, "demo", "--fail", "E_TIMEOUT x", "--progress"]);
  if (recovered.code !== 0 || !recovered.out.startsWith("ok")) throw new Error(`expected ok after progress, got ${recovered.code}: ${recovered.out}`);
  if (Object.keys(state(dir).failures).length !== 0) throw new Error("progress did not reset failure counters");
  // Two fresh failures afterwards must still be ok, not carry the old run.
  run(["record", dir, "demo", "--fail", "E_TIMEOUT x"]);
  const second = run(["record", dir, "demo", "--fail", "E_TIMEOUT x"]);
  if (second.code !== 0 || !second.out.startsWith("ok")) throw new Error(`expected ok on 2nd consecutive failure, got ${second.code}: ${second.out}`);
  const third = run(["record", dir, "demo", "--fail", "E_TIMEOUT x"]);
  if (third.code !== 1 || !third.out.startsWith("stop")) throw new Error(`expected stop on 3rd, got ${third.code}: ${third.out}`);
});

test("budget 90 warns, 100 stops", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-state-"));
  const warn = run(["record", dir, "demo", "--budget", "92"]);
  if (warn.code !== 0 || !warn.out.startsWith("warn")) throw new Error(`expected warn: ${warn.out}`);
  const stop = run(["record", dir, "demo", "--budget", "100"]);
  if (stop.code !== 1 || !stop.out.startsWith("stop")) throw new Error(`expected stop: ${stop.out}`);
});

test("record --status sets the status; status prints it without mutating", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-state-"));
  run(["record", dir, "demo"]);
  const done = run(["record", dir, "demo", "--status", "done"]);
  if (done.code !== 0 || !done.out.includes("status=done")) throw new Error(`expected status=done: ${done.out}`);
  if (state(dir).status !== "done") throw new Error("status flag not persisted");
  const before = readFileSync(join(dir, "demo.state.json"), "utf8");
  const s = run(["status", dir, "demo"]);
  if (s.code !== 0 || !s.out.includes("status=done")) throw new Error(`status cmd: ${s.out} ${s.err}`);
  if (readFileSync(join(dir, "demo.state.json"), "utf8") !== before) throw new Error("status mutated the file");
});

test("corrupt or malformed state file exits 2 and is never reset (bug regression)", () => {
  for (const body of ["not json", '{"rounds":"many"}', '{"failures":{"sig":"nope"}}', "[]", "null"]) {
    const dir = mkdtempSync(join(tmpdir(), "goal-state-"));
    writeFileSync(join(dir, "demo.state.json"), body);
    const rec = run(["record", dir, "demo", "--progress"]);
    if (rec.code !== 2) throw new Error(`expected exit 2 for ${body}, got ${rec.code}: ${rec.out}`);
    if (readFileSync(join(dir, "demo.state.json"), "utf8") !== body) throw new Error(`corrupt file ${body} was overwritten`);
    const st = run(["status", dir, "demo"]);
    if (st.code !== 2) throw new Error(`status expected exit 2 for ${body}, got ${st.code}: ${st.out}`);
  }
});

test("unknown flag or bad --status exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-state-"));
  if (run(["record", dir, "demo", "--wat"]).code !== 2) throw new Error("expected 2 for unknown flag");
  if (run(["record", dir, "demo", "--status", "paused"]).code !== 2) throw new Error("expected 2 for bad status");
  if (run(["record"]).code !== 2) throw new Error("expected 2 for missing args");
  if (run(["init", dir, "demo"]).code !== 2) throw new Error("init without --start-commit must exit 2");
});
