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
  assert.equal(envLine(cwd, NOW, home()), "verify ✗ L1 of L3 (7m ago)");
  const none = project({ ts: ago(0), ok: false, message: "verify gate: required L3, found no receipt for the current code (tree abc); run …" });
  assert.equal(envLine(none, NOW, home()), "verify ✗ no receipt of L3 (just now)");
});

test("env line: verify ok, and a check that could not run is not shown as a pass", () => {
  assert.equal(envLine(project({ ts: ago(130), ok: true, message: "receipt at the required level" }), NOW, home()), "verify ✓ (2h ago)");
  assert.equal(envLine(project({ ts: ago(1), ok: null, message: "tree hash timed out" }), NOW, home()), "verify ? check could not run (1m ago)");
});

test("env line: doctor gaps are listed by id, at most three, with where to look", () => {
  const env = home({ ts: ago(45), total: 19, gaps: [{ id: "superagent.layerfs", ok: false }, { id: "superagent.cad2gis", ok: false }, { id: "skills.installed", ok: true }, { id: "tool.rtk", ok: false }] });
  assert.equal(envLine(project(), NOW, env), "gaps 4: superagent.layerfs, superagent.cad2gis, skills.installed, … (45m ago; mola doctor)");
  assert.equal(envLine(project(), NOW, home({ ts: ago(3), total: 19, gaps: [] })), "env ✓ (3m ago)");
});

test("env line: both parts, found from a subdirectory of the project; broken files are ignored", () => {
  const cwd = project({ ts: ago(2), ok: true, message: "x" });
  const sub = path.join(cwd, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(envLine(sub, NOW, home({ ts: ago(2), total: 3, gaps: [{ id: "tool.git", ok: false }] })), "verify ✓ (2m ago) · gaps 1: tool.git (2m ago; mola doctor)");
  assert.equal(envLine(project("{not json"), NOW, home()), "");
  assert.equal(envLine(project([1, 2]), NOW, home()), "");
});

test("statusline output carries the env line after the run line", () => {
  const cwd = project({ ts: new Date().toISOString(), ok: true, message: "x" });
  const prev = process.env.MOLA_HOME;
  process.env.MOLA_HOME = home().MOLA_HOME;
  try {
    assert.equal(renderStatusline({ stdin: JSON.stringify({ cwd }), cwd: os.tmpdir() }), "verify ✓ (just now)");
  } finally {
    if (prev === undefined) delete process.env.MOLA_HOME; else process.env.MOLA_HOME = prev;
  }
});
