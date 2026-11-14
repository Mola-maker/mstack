import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envLine, renderStatusline } from "../src/statusline.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();

function project(status?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-hud-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, ".mstack", "verify"), { recursive: true });
  if (status !== undefined) fs.writeFileSync(path.join(dir, ".mstack", "verify", "status.json"), typeof status === "string" ? status : JSON.stringify(status));
  return dir;
}
function home(doctor?: unknown): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-hud-home-"));
  if (doctor !== undefined) fs.writeFileSync(path.join(dir, "doctor-last.json"), JSON.stringify(doctor));
  return { MOLA_HOME: dir } as NodeJS.ProcessEnv;
}

test("env line: nothing recorded, nothing shown", () => {
  assert.equal(envLine(project(), NOW, home()), "");
  assert.equal(envLine(fs.mkdtempSync(path.join(os.tmpdir(), "mola-hud-none-")), NOW, home()), "");
});

test("env line: verify below the required level shows found and required, with the age of the verdict", () => {
  const cwd = project({ ts: ago(7), ok: false, message: "verify gate: required L3, found L1 for the current code (tree abc123def456); run the L3 check, then: …" });
  assert.equal(envLine(cwd, NOW, home()), "verify ✗ L1 of L3 (last stop 7m ago)");
  const none = project({ ts: ago(0), ok: false, message: "verify gate: required L3, found no receipt for the current code (tree abc); run …" });
  assert.equal(envLine(none, NOW, home()), "verify ✗ no receipt of L3 (last stop just now)");
});

test("env line: verify ok, and a check that could not run is not shown as a pass", () => {
  assert.equal(envLine(project({ ts: ago(130), ok: true, message: "receipt at the required level" }), NOW, home()), "verify ✓ (last stop 2h ago)");
  assert.equal(envLine(project({ ts: ago(1), ok: null, message: "tree hash timed out" }), NOW, home()), "verify ? check could not run (last stop 1m ago)");
});

test("env line: doctor gaps are listed by id, at most three, with where to look", () => {
  const env = home({ ts: ago(45), total: 19, gaps: [{ id: "superagent.layerfs", ok: false }, { id: "superagent.cad2gis", ok: false }, { id: "skills.installed", ok: true }, { id: "tool.rtk", ok: false }] });
  assert.equal(envLine(project(), NOW, env), "gaps 4: superagent.layerfs, superagent.cad2gis, skills.installed, … (mola doctor 45m ago)");
  assert.equal(envLine(project(), NOW, home({ ts: ago(3), total: 19, gaps: [] })), "env ✓ (mola doctor 3m ago)");
});

test("env line: both parts, found from a subdirectory of the project; broken files are ignored", () => {
  const cwd = project({ ts: ago(2), ok: true, message: "x" });
  const sub = path.join(cwd, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(envLine(sub, NOW, home({ ts: ago(2), total: 3, gaps: [{ id: "tool.git", ok: false }] })), "verify ✓ (last stop 2m ago) · gaps 1: tool.git (mola doctor 2m ago)");
  assert.equal(envLine(project("{not json"), NOW, home()), "");
  assert.equal(envLine(project([1, 2]), NOW, home()), "");
});

test("env line: a verdict file shipped in a repo cannot put control characters or extra lines on the terminal", () => {
  const evil = "verify gate: required L3, found \u001b]0;pwn\u0007\u001b[2J\nFAKE for the current code";
  const line = envLine(project({ ts: "\u001b[31m2026", ok: false, message: evil }), NOW, home());
  assert.equal(line, "verify ✗ below the required level (last stop)");
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(line), false);
  const ids = envLine(project(), NOW, home({ ts: ago(1), gaps: [{ id: "x\u001b[2J", ok: false }, { id: "a".repeat(200), ok: false }, { id: "tool.git", ok: false }] }));
  assert.equal(ids, "gaps 3: ?, ?, tool.git (mola doctor 1m ago)");
});

test("env line: a doctor result with an unreadable time still reads as a sentence", () => {
  assert.equal(envLine(project(), NOW, home({ ts: "x", gaps: [{ id: "tool.git", ok: false }] })), "gaps 1: tool.git (mola doctor)");
  assert.equal(envLine(project(), NOW, home({ ts: "x", gaps: [] })), "env ✓ (mola doctor)");
});

test("env line: the malformed-receipt message keeps its required level", () => {
  const msg = "verify gate: required L3, found no valid receipt (the stored one is malformed and ignored) for the current code (tree abc)";
  assert.equal(envLine(project({ ts: ago(1), ok: false, message: msg }), NOW, home()), "verify ✗ no valid receipt of L3 (last stop 1m ago)");
});

test("env line: the verdict is read at the git checkout, not from a .mstack above or below it", () => {
  const outer = project({ ts: ago(1), ok: true, message: "x" });
  const inner = path.join(outer, "cloned-repo");
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
  assert.equal(envLine(inner, NOW, home()), "", "an outer project's verdict was shown for a nested checkout");
  const pkg = path.join(outer, "pkg");
  fs.mkdirSync(path.join(pkg, ".mstack", "runs"), { recursive: true });
  assert.equal(envLine(pkg, NOW, home()), "verify ✓ (last stop 1m ago)", "a package's own .mstack hid the checkout's verdict");
});

test("statusline output carries the env line after the run line", () => {
  const cwd = project({ ts: new Date().toISOString(), ok: true, message: "x" });
  const prev = process.env.MOLA_HOME;
  process.env.MOLA_HOME = home().MOLA_HOME;
  try {
    assert.equal(renderStatusline({ stdin: JSON.stringify({ cwd }), cwd: os.tmpdir() }), "verify ✓ (last stop just now)");
  } finally {
    if (prev === undefined) delete process.env.MOLA_HOME; else process.env.MOLA_HOME = prev;
  }
});
