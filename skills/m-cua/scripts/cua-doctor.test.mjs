import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cua-doctor.mjs";

const WIN = process.platform === "win32";
const SCRIPT = fileURLToPath(new URL("./cua-doctor.mjs", import.meta.url));

// A fake tool that prints fixed lines and exits with `code`, as a .cmd on Windows and a shell script elsewhere.
function fake(dir, name, lines, code = 0) {
  mkdirSync(dir, { recursive: true });
  if (WIN) writeFileSync(join(dir, name + ".cmd"), ["@echo off", ...lines.map((l) => "echo " + l), `exit /b ${code}`].join("\r\n") + "\r\n");
  else {
    const p = join(dir, name);
    writeFileSync(p, ["#!/bin/sh", ...lines.map((l) => `echo '${l}'`), `exit ${code}`].join("\n") + "\n");
    chmodSync(p, 0o755);
  }
}
// Only what a shell needs to start: no HOME, APPDATA or ANDROID_* leaks in from the machine running the tests.
const env = (pathDirs, extra = {}) => ({ PATH: pathDirs.join(delimiter), PATHEXT: ".CMD;.EXE", ComSpec: process.env.ComSpec ?? "", SystemRoot: process.env.SystemRoot ?? "", ...extra });
const STATUS = (acc = "granted") => `{"version":"2.6","ok":true,"command":"status","data":{"permissions":{"accessibility":{"state":"${acc}"},"automation":{"state":"not_required"}},"platform":"test","version":"9.9.9"}}`;
const scratch = (t) => { const d = mkdtempSync(join(tmpdir(), "cua-doctor-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const drivers = (r) => Object.fromEntries(JSON.parse(r.text).drivers.map((d) => [d.driver, d]));

test("nothing installed: every driver is missing, each with a fix, exit 1", (t) => {
  const d = scratch(t);
  const r = main(["--json"], env([d]), d);
  assert.equal(r.code, 1);
  for (const x of Object.values(drivers(r))) { assert.equal(x.state, "missing"); assert.ok(x.fix.length > 10); }
});

test("agent-desktop on PATH with permissions granted is ready", (t) => {
  const d = scratch(t);
  fake(d, "agent-desktop", ["launcher notice that is not JSON", STATUS()]);
  const r = main(["--need", "desktop", "--json"], env([d]), d);
  assert.equal(r.code, 0);
  assert.equal(drivers(r).desktop.state, "ready");
  assert.equal(drivers(r).desktop.version, "9.9.9");
});

test("agent-desktop installed where npm puts it but not on PATH is not-on-path and names the file", (t) => {
  const d = scratch(t);
  const off = WIN ? join(d, "appdata", "npm") : join(d, "home", ".npm-global", "bin");
  fake(off, "agent-desktop", [STATUS()]);
  const r = main(["--need", "desktop", "--json"], env([d], WIN ? { APPDATA: join(d, "appdata") } : { HOME: join(d, "home") }), d);
  assert.equal(r.code, 1);
  const x = drivers(r).desktop;
  assert.equal(x.state, "not-on-path");
  assert.ok(x.fix.includes(off), x.fix);
});

test("agent-desktop without the accessibility permission is broken, not ready", (t) => {
  const d = scratch(t);
  fake(d, "agent-desktop", [STATUS("denied")]);
  const x = drivers(main(["--need", "desktop", "--json"], env([d]), d)).desktop;
  assert.equal(x.state, "broken");
  assert.match(x.detail, /accessibility/);
});

test("adb with no device, and with only an unauthorized device, is no-device", (t) => {
  const d = scratch(t);
  fake(d, "adb", ["List of devices attached"]);
  let r = main(["--need", "android", "--json"], env([d]), d);
  assert.equal(r.code, 1);
  assert.equal(drivers(r).android.state, "no-device");
  fake(d, "adb", ["List of devices attached", "R58M123 unauthorized"]);
  r = main(["--need", "android", "--json"], env([d]), d);
  assert.equal(drivers(r).android.state, "no-device");
  assert.match(drivers(r).android.detail, /unauthorized/);
});

test("adb with an online device is ready and lists it", (t) => {
  const d = scratch(t);
  fake(d, "adb", ["List of devices attached", "emulator-5554 device"]);
  const r = main(["--need", "android", "--json"], env([d]), d);
  assert.equal(r.code, 0);
  assert.deepEqual(drivers(r).android.devices, ["emulator-5554"]);
});

test("adb only under ANDROID_HOME/platform-tools is not-on-path", (t) => {
  const d = scratch(t);
  fake(join(d, "sdk", "platform-tools"), "adb", ["List of devices attached", "emulator-5554 device"]);
  const r = main(["--need", "android", "--json"], env([d], { ANDROID_HOME: join(d, "sdk") }), d);
  assert.equal(r.code, 1);
  assert.equal(drivers(r).android.state, "not-on-path");
});

test("a project-local playwright is ready; a failing one is broken", (t) => {
  const d = scratch(t);
  fake(join(d, "node_modules", ".bin"), "playwright", ["Version 1.2.3"]);
  let r = main(["--need", "web", "--json"], env([d]), d);
  assert.equal(r.code, 0);
  assert.equal(drivers(r).web.version, "Version 1.2.3");
  fake(join(d, "node_modules", ".bin"), "playwright", ["boom"], 3);
  r = main(["--need", "web", "--json"], env([d]), d);
  assert.equal(drivers(r).web.state, "broken");
});

test("without --need, one ready driver is enough for exit 0", (t) => {
  const d = scratch(t);
  fake(d, "agent-desktop", [STATUS()]);
  assert.equal(main(["--json"], env([d]), d).code, 0);
});

test("an unknown argument or driver name exits 2", () => {
  assert.equal(main(["--need", "ios"]).code, 2);
  assert.equal(main(["--wat"]).code, 2);
});

test("run as a command it prints one block per driver with the fix line", (t) => {
  const d = scratch(t);
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: d, env: env([d]), encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /desktop: missing \(agent-desktop\)\n {2}fix: npm install -g agent-desktop/);
  assert.match(r.stdout, /android: missing/);
  assert.match(r.stdout, /web: missing/);
});
