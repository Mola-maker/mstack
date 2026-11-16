import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const ab = join(here, "cua-visual-ab.sh");
const REAL_BOUNDS = { x: 635, y: 322, width: 650, height: 514 };

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "cua-visual-ab-"));
  t.after(() => spawnSync("rm", ["-rf", dir], { windowsHide: true }));
  return dir;
}

function fakeDriver(dir, bodies = ["fake-png"]) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "agent-desktop");
  const statePath = join(dir, "fake-state.json");
  writeFileSync(statePath, JSON.stringify({
    windows: [{
      accessible: true,
      app_name: "thunar",
      bounds: { ...REAL_BOUNDS },
      id: "w-1.50-org-a11y-atspi-accessible-76",
      is_focused: false,
      minimized: false,
      pid: 93183,
      title: "native-doc - Thunar",
      visible: true,
    }],
    calls: [],
    clickXy: null,
    screenshotSize: { width: 650, height: 514, scale_factor: 1.0 },
    screenshotBodies: bodies.slice(),
  }));
  writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const st = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
st.calls.push(args);
const headed = args[0] === "--headed" ? args.slice(1) : args;
const cmd = headed[0];
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : null; };
function save() { writeFileSync(statePath, JSON.stringify(st)); }
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
if (cmd === "list-windows") {
  const app = flag("--app");
  const data = app ? st.windows.filter((w) => w.app_name === app) : st.windows;
  save(); out({ version: "2.6", ok: true, command: "list-windows", data }); process.exit(0);
}
if (cmd === "screenshot") {
  const path = args.filter((a) => !a.startsWith("--") && a !== "screenshot" && a !== flag("--app") && a !== flag("--window-id")).at(-1);
  const body = st.screenshotBodies.length > 1 ? st.screenshotBodies.shift() : st.screenshotBodies[0];
  writeFileSync(path, body);
  save();
  out({ version: "2.6", ok: true, command: "screenshot", data: { format: "png", path, ...st.screenshotSize } });
  process.exit(0);
}
if (cmd === "focus-window") {
  const id = flag("--window-id");
  const w = st.windows.find((x) => x.id === id) || st.windows[0];
  save();
  out({ version: "2.6", ok: true, command: "focus-window", data: { focused: { ...w, is_focused: true } } });
  process.exit(0);
}
if (cmd === "mouse-click") {
  const xy = (flag("--xy") || "").split(",").map(Number);
  st.clickXy = { x: xy[0], y: xy[1] };
  save();
  out({ version: "2.6", ok: true, command: "mouse-click", data: { action: "mouse-click", count: 1, disposition: { delivery: "delivered_unverified", retry: "unsafe" }, target: { kind: "pointer", point: { x: xy[0], y: xy[1] } }, x: xy[0], y: xy[1] } });
  process.exit(0);
}
save(); out({ version: "2.6", ok: false, error: { code: "UNKNOWN", message: args.join(" ") } }); process.exit(0);
`);
  chmodSync(bin, 0o755);
  return { bin, statePath, read: () => JSON.parse(readFileSync(statePath, "utf8")) };
}

function run(args, extra = {}) {
  return spawnSync("bash", [ab, ...args], { encoding: "utf8", ...extra });
}

test("prepare and trial entry points are refused so an old point cannot be replayed on a new frame", () => {
  const prep = run(["prepare", "--app", "thunar", "--out-dir", "/tmp/x", "--bin", "agent-desktop"]);
  assert.equal(prep.status, 2);
  assert.match(prep.stderr, /observe/);
  const trial = run(["trial", "--app", "thunar", "--out-dir", "/tmp/x", "--bin", "agent-desktop", "--png-x", "243", "--png-y", "183", "--side", "B", "--label", "t1"]);
  assert.equal(trial.status, 2);
});

test("observe, act, verify, and summary keep verification pending until the model records a result", (t) => {
  const dir = scratch(t);
  const fake = fakeDriver(dir);
  const out = join(dir, "out");
  const obs = run(["observe", "--app", "thunar", "--out-dir", out, "--bin", fake.bin, "--side", "B", "--label", "t1"]);
  assert.equal(obs.status, 0, obs.stdout + obs.stderr);
  assert.match(obs.stdout, /driver_wall_ms=/);
  const rec1 = JSON.parse(readFileSync(join(out, "B-t1/record.json"), "utf8"));
  assert.equal(rec1.verify.status, "pending");
  assert.equal(rec1.task_succeeded, null);
  assert.equal(rec1.act, null);

  const act = run(["act", "--out-dir", out, "--bin", fake.bin, "--side", "B", "--label", "t1", "--png-x", "243", "--png-y", "183"]);
  assert.equal(act.status, 0, act.stdout + act.stderr);
  const rec2 = JSON.parse(readFileSync(join(out, "B-t1/record.json"), "utf8"));
  assert.equal(rec2.act.status, "ok");
  assert.equal(rec2.act.task_succeeded, null);
  assert.equal(rec2.verify.status, "pending");
  assert.equal(rec2.task_succeeded, null);
  assert.deepEqual(fake.read().clickXy, { x: 878, y: 505 });

  const sumPending = run(["summary", "--out-dir", out]);
  assert.equal(sumPending.status, 0, sumPending.stdout + sumPending.stderr);
  assert.match(sumPending.stdout, /counts pending=1 pass=0 fail=0/);
  assert.match(sumPending.stdout, /excludes model locate/);
  assert.match(sumPending.stdout, /No performance winner/);
  assert.doesNotMatch(sumPending.stdout, /t1 B[^\n]*true/);

  const ver = run(["verify", "--out-dir", out, "--side", "B", "--label", "t1", "--verify", "pass"]);
  assert.equal(ver.status, 0, ver.stdout + ver.stderr);
  const rec3 = JSON.parse(readFileSync(join(out, "B-t1/record.json"), "utf8"));
  assert.equal(rec3.verify.status, "pass");
  assert.equal(rec3.task_succeeded, true);
  const sum = run(["summary", "--out-dir", out]);
  assert.match(sum.stdout, /counts pending=0 pass=1 fail=0/);
});

test("a content change during act is recorded as refuse and is not a task failure by default", (t) => {
  const dir = scratch(t);
  const fake = fakeDriver(dir, ["frame-a", "frame-b"]);
  const out = join(dir, "out");
  const obs = run(["observe", "--app", "thunar", "--out-dir", out, "--bin", fake.bin, "--side", "A", "--label", "t2"]);
  assert.equal(obs.status, 0, obs.stdout + obs.stderr);
  const act = run(["act", "--out-dir", out, "--bin", fake.bin, "--side", "A", "--label", "t2", "--png-x", "243", "--png-y", "183"]);
  assert.notEqual(act.status, 0);
  const rec = JSON.parse(readFileSync(join(out, "A-t2/record.json"), "utf8"));
  assert.equal(rec.act.status, "refuse");
  assert.equal(rec.act.code, "CONTENT_CHANGED");
  assert.equal(rec.verify.status, "refuse");
  assert.equal(rec.task_succeeded, null);
  assert.equal(fake.read().clickXy, null);
  const sum = run(["summary", "--out-dir", out]);
  assert.match(sum.stdout, /refuse=1/);
});
