import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  pngToScreen,
  pngInImage,
  sizeMatchesBounds,
  boundsEqual,
  selectWindow,
  observeFromDriver,
  actFromDriver,
} from "./cua-visual.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "cua-visual.mjs");
const REAL_BOUNDS = { x: 635, y: 322, width: 650, height: 514 };
const REAL_PNG = { x: 243, y: 183 };
const REAL_SCREEN = { x: 878, y: 505 };

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "cua-visual-"));
  t.after(() => spawnSync("rm", ["-rf", dir], { windowsHide: true }));
  return dir;
}

function fakeDriver(dir, hooks = {}) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "agent-desktop");
  const statePath = join(dir, "fake-state.json");
  const initial = {
    windows: hooks.windows || [
      {
        accessible: true,
        app_name: "thunar",
        bounds: { ...REAL_BOUNDS },
        id: "w-1.50-org-a11y-atspi-accessible-76",
        is_focused: false,
        minimized: false,
        pid: 93183,
        process_instance: "7d252618:638288",
        title: "native-doc - Thunar",
        visible: true,
      },
    ],
    calls: [],
    clickXy: null,
    screenshotSize: hooks.screenshotSize || { width: 650, height: 514, scale_factor: 1.0 },
    screenshotFail: hooks.screenshotFail || null,
    listFail: hooks.listFail || null,
    focusFail: hooks.focusFail || null,
    clickFail: hooks.clickFail || null,
    boundsAfterFocus: hooks.boundsAfterFocus || null,
    boundsOnSecondList: hooks.boundsOnSecondList || null,
    screenshotBodies: (hooks.screenshotBodies || ["fake-png"]).slice(),
  };
  writeFileSync(statePath, JSON.stringify(initial));
  const script = `#!/usr/bin/env node
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
  if (st.listFail) { save(); out(st.listFail); process.exit(0); }
  if (st.boundsOnSecondList && st.calls.filter((a) => a.includes("list-windows")).length >= 2) {
    st.windows = st.windows.map((w) => ({ ...w, bounds: st.boundsOnSecondList }));
  }
  const app = flag("--app");
  const data = app ? st.windows.filter((w) => w.app_name === app) : st.windows;
  save();
  out({ version: "2.6", ok: true, command: "list-windows", data });
  process.exit(0);
} else if (cmd === "screenshot") {
  if (st.screenshotFail) { save(); out(st.screenshotFail); process.exit(0); }
  const path = args.filter((a) => !a.startsWith("--") && a !== "screenshot" && a !== flag("--app") && a !== flag("--window-id")).at(-1);
  const body = st.screenshotBodies.length > 1 ? st.screenshotBodies.shift() : st.screenshotBodies[0];
  writeFileSync(path, body);
  save();
  out({ version: "2.6", ok: true, command: "screenshot", data: { format: "png", path, ...st.screenshotSize } });
  process.exit(0);
} else if (cmd === "focus-window") {
  if (st.focusFail) { save(); out(st.focusFail); process.exit(0); }
  const id = flag("--window-id");
  const w = st.windows.find((x) => x.id === id) || st.windows[0];
  const focused = { ...w, is_focused: true, bounds: st.boundsAfterFocus || w.bounds };
  save();
  out({ version: "2.6", ok: true, command: "focus-window", data: { focused } });
  process.exit(0);
} else if (cmd === "mouse-click") {
  if (st.clickFail) { save(); out(st.clickFail); process.exit(0); }
  const xy = (flag("--xy") || "").split(",").map(Number);
  st.clickXy = { x: xy[0], y: xy[1] };
  save();
  out({ version: "2.6", ok: true, command: "mouse-click", data: { action: "mouse-click", count: 1, details: { delivered_events: 3 }, disposition: { delivery: "delivered_unverified", retry: "unsafe" }, steps: [{ label: "pointer_click", mechanism: "physical_synthetic", outcome: "succeeded" }], target: { kind: "pointer", point: { x: xy[0], y: xy[1] } }, x: xy[0], y: xy[1] } });
  process.exit(0);
} else {
  save();
  out({ version: "2.6", ok: false, error: { code: "UNKNOWN", message: "unexpected " + args.join(" ") } });
  process.exit(0);
}
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { bin, statePath, read: () => JSON.parse(readFileSync(statePath, "utf8")) };
}

test("real visual-run mapping 243,183 in a 650x514 window at 635,322 scale 1 is 878,505", () => {
  assert.deepEqual(pngToScreen(REAL_BOUNDS, 1, REAL_PNG.x, REAL_PNG.y), REAL_SCREEN);
  assert.equal(pngInImage(REAL_PNG.x, REAL_PNG.y, 650, 514), true);
  assert.equal(sizeMatchesBounds(REAL_BOUNDS, 650, 514, 1), true);
  assert.equal(boundsEqual(REAL_BOUNDS, { x: 635.0, y: 322.0, width: 650.0, height: 514.0 }), true);
});

test("png coordinates on the edge are rejected, and a scale mismatch is not mappable", () => {
  assert.equal(pngInImage(650, 100, 650, 514), false);
  assert.equal(pngInImage(-1, 0, 650, 514), false);
  assert.equal(pngInImage(0, 0, 650, 514), true);
  assert.equal(sizeMatchesBounds(REAL_BOUNDS, 1300, 1028, 1), false);
  assert.equal(sizeMatchesBounds(REAL_BOUNDS, 1300, 1028, 2), true);
  assert.deepEqual(pngToScreen(REAL_BOUNDS, 2, 486, 366), REAL_SCREEN);
});

test("selectWindow requires a unique window unless a window-id is given", () => {
  const a = { id: "w-a", app_name: "thunar", visible: true, bounds: REAL_BOUNDS };
  const b = { id: "w-b", app_name: "thunar", visible: true, bounds: REAL_BOUNDS };
  const term = { id: "w-t", app_name: "xfce4-terminal", visible: true };
  assert.equal(selectWindow([a, term], { app: "thunar" }).ok, true);
  assert.equal(selectWindow([a, b], { app: "thunar" }).ok, false);
  assert.equal(selectWindow([a, b], { app: "thunar", windowId: "w-b" }).window.id, "w-b");
  assert.equal(selectWindow([a, b], { app: "thunar", windowId: "w-missing" }).ok, false);
});

test("observe packs list-windows and a screenshot and does not click", (t) => {
  const dir = scratch(t);
  const fake = fakeDriver(dir);
  const outDir = join(dir, "out");
  const denied = observeFromDriver({ bin: fake.bin, app: "thunar", outDir, headedVisual: false });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "HEADED_VISUAL_REQUIRED");
  const result = observeFromDriver({ bin: fake.bin, app: "thunar", outDir, headedVisual: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.window.id, "w-1.50-org-a11y-atspi-accessible-76");
  assert.equal(result.data.screenshot.width, 650);
  assert.ok(result.data.screenshot.sha256);
  assert.match(result.data.model_must, /does not detect or click/);
  assert.equal(result.data.freshness.kind, "window_id_bounds_and_png_bytes");
  assert.doesNotMatch(result.data.freshness.reason, /80s/);
  const cmds = fake.read().calls.map((a) => (a[0] === "--headed" ? a[1] : a[0]));
  assert.deepEqual(cmds, ["list-windows", "focus-window", "screenshot"]);
  assert.equal(fake.read().clickXy, null);
});

test("observe refuses ambiguous windows and a size mismatch", (t) => {
  const dir = scratch(t);
  const twins = [
    { id: "w-1", app_name: "thunar", visible: true, bounds: { ...REAL_BOUNDS }, title: "native-doc - Thunar" },
    { id: "w-2", app_name: "thunar", visible: true, bounds: { ...REAL_BOUNDS }, title: "native-doc - Thunar" },
  ];
  const amb = fakeDriver(join(dir, "amb"), { windows: twins });
  const r1 = observeFromDriver({ bin: amb.bin, app: "thunar", outDir: join(dir, "a"), headedVisual: true });
  assert.equal(r1.ok, false);
  assert.match(r1.error.message, /ambiguous/);
  assert.equal(amb.read().calls.some((c) => c[0] === "screenshot"), false);

  const mismatch = fakeDriver(join(dir, "mis"), { screenshotSize: { width: 100, height: 100, scale_factor: 1.0 } });
  const r2 = observeFromDriver({ bin: mismatch.bin, app: "thunar", outDir: join(dir, "b"), headedVisual: true });
  assert.equal(r2.ok, false);
  assert.match(r2.error.message, /does not match window bounds/);
});

test("act requires --headed-visual and does not click without it", (t) => {
  const dir = scratch(t);
  const fake = fakeDriver(dir);
  const outDir = join(dir, "out");
  const obs = observeFromDriver({ bin: fake.bin, app: "thunar", outDir, headedVisual: true });
  const denied = actFromDriver({ bin: fake.bin, observe: obs.data, pngX: REAL_PNG.x, pngY: REAL_PNG.y, headedVisual: false });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "HEADED_VISUAL_REQUIRED");
  assert.equal(fake.read().clickXy, null);
});

test("act rejects an out-of-image point and stale bounds, and never marks task success", (t) => {
  const dir = scratch(t);
  const outDir = join(dir, "out");
  const fake = fakeDriver(dir);
  const obs = observeFromDriver({ bin: fake.bin, app: "thunar", outDir, headedVisual: true });
  const oob = actFromDriver({ bin: fake.bin, observe: obs.data, pngX: 900, pngY: 10, headedVisual: true });
  assert.equal(oob.ok, false);
  assert.match(oob.error.message, /outside/);
  assert.equal(fake.read().clickXy, null);

  const stale = fakeDriver(join(dir, "stale"), { boundsOnSecondList: { x: 10, y: 10, width: 650, height: 514 } });
  const obs2 = observeFromDriver({ bin: stale.bin, app: "thunar", outDir: join(dir, "out2"), headedVisual: true });
  const r = actFromDriver({ bin: stale.bin, observe: obs2.data, pngX: REAL_PNG.x, pngY: REAL_PNG.y, headedVisual: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "STALE_BOUNDS");
  assert.equal(stale.read().clickXy, null);
});

test("headed act focuses, clicks the mapped screen point, returns an after image, and leaves task_succeeded null pending review", (t) => {
  const dir = scratch(t);
  const fake = fakeDriver(dir);
  const outDir = join(dir, "out");
  const obs = observeFromDriver({ bin: fake.bin, app: "thunar", outDir, headedVisual: true });
  const r = actFromDriver({ bin: fake.bin, observe: obs.data, pngX: REAL_PNG.x, pngY: REAL_PNG.y, headedVisual: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.screen, REAL_SCREEN);
  assert.equal(r.data.delivery, "delivered_unverified");
  assert.equal(r.data.task_succeeded, null);
  assert.equal(r.data.verification.status, "pending");
  assert.ok(r.data.after_screenshot.path.endsWith("after.png"));
  assert.deepEqual(fake.read().clickXy, REAL_SCREEN);
  const cmds = fake.read().calls.map((a) => (a[0] === "--headed" ? a[1] : a[0]));
  assert.deepEqual(cmds, ["list-windows", "focus-window", "screenshot", "list-windows", "focus-window", "screenshot", "mouse-click", "screenshot"]);
});

test("CLI observe and act write envelopes; act without the flag exits 1", (t) => {
  const dir = scratch(t);
  const fake = fakeDriver(dir);
  const outDir = join(dir, "out");
  const noObsFlag = spawnSync(process.execPath, [cli, "observe", "--app", "thunar", "--out-dir", outDir, "--bin", fake.bin], { encoding: "utf8" });
  assert.equal(noObsFlag.status, 1);
  assert.match(noObsFlag.stdout, /HEADED_VISUAL_REQUIRED|headed-visual/);
  const obs = spawnSync(process.execPath, [cli, "observe", "--app", "thunar", "--out-dir", outDir, "--headed-visual", "--bin", fake.bin], { encoding: "utf8" });
  assert.equal(obs.status, 0, obs.stdout + obs.stderr);
  const env = JSON.parse(obs.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.command, "observe");
  const observeFile = join(outDir, "observe.json");
  const noFlag = spawnSync(process.execPath, [cli, "act", "--observe", observeFile, "--png-x", "243", "--png-y", "183", "--bin", fake.bin], { encoding: "utf8" });
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stdout, /HEADED_VISUAL_REQUIRED|headed-visual/);
  const act = spawnSync(process.execPath, [cli, "act", "--observe", observeFile, "--png-x", "243", "--png-y", "183", "--headed-visual", "--bin", fake.bin], { encoding: "utf8" });
  assert.equal(act.status, 0, act.stdout + act.stderr);
  const out = JSON.parse(act.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.data.task_succeeded, null);
  assert.equal(out.data.verification.status, "pending");
  assert.deepEqual(out.data.screen, REAL_SCREEN);
});

test("same window and bounds with changed pixels does not mouse-click and returns a new frame", (t) => {
  const dir = scratch(t);
  const fake = fakeDriver(dir, { screenshotBodies: ["frame-a", "frame-b"] });
  const outDir = join(dir, "out");
  const obs = observeFromDriver({ bin: fake.bin, app: "thunar", outDir, headedVisual: true });
  assert.equal(obs.ok, true);
  const r = actFromDriver({ bin: fake.bin, observe: obs.data, pngX: REAL_PNG.x, pngY: REAL_PNG.y, headedVisual: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "CONTENT_CHANGED");
  assert.ok(r.error.current_screenshot.path.endsWith("current.png"));
  assert.notEqual(r.error.observed_sha256, r.error.current_sha256);
  assert.equal(fake.read().clickXy, null);
  const clicked = fake.read().calls.some((a) => a.includes("mouse-click"));
  assert.equal(clicked, false);
});

test("rewriting before.png after observe is rejected and does not click", (t) => {
  const dir = scratch(t);
  const fake = fakeDriver(dir);
  const outDir = join(dir, "out");
  const obs = observeFromDriver({ bin: fake.bin, app: "thunar", outDir, headedVisual: true });
  writeFileSync(obs.data.screenshot.path, "tampered-before-bytes");
  const r = actFromDriver({ bin: fake.bin, observe: obs.data, pngX: REAL_PNG.x, pngY: REAL_PNG.y, headedVisual: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "BEFORE_EVIDENCE_CHANGED");
  assert.notEqual(r.error.recorded_sha256, r.error.file_sha256);
  assert.equal(fake.read().clickXy, null);
  const clicked = fake.read().calls.some((a) => a.includes("mouse-click"));
  assert.equal(clicked, false);
});
