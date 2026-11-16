import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { main, probeDesktop } from "./cua-doctor.mjs";

const WIN = process.platform === "win32";
const SCRIPT = fileURLToPath(new URL("./cua-doctor.mjs", import.meta.url));

// A fake tool that prints fixed lines and exits with `code`, as a .cmd on Windows and a shell script elsewhere.
function fake(dir, name, lines, code = 0) {
  mkdirSync(dir, { recursive: true });
  if (WIN) writeFileSync(join(dir, name + ".cmd"), ["@echo off", ...lines.map((l) => "echo " + l), `exit /b ${code}`].join("\r\n") + "\r\n");
  else {
    const p = join(dir, name);
    writeFileSync(p, ["#!/bin/sh", ...lines.map((l) => `printf '%s\\n' '${l.replaceAll("'", "'\\''")}'`), `exit ${code}`].join("\n") + "\n");
    chmodSync(p, 0o755);
  }
}

// Desktop probe calls `status` then `list-apps`. A one-shot fake that always prints status would make every ready case look like a broken list-apps envelope.
function fakeDesktop(dir, { status = STATUS(), apps = [{ "name": "TextEditor" }], statusCode = 0, listCode = 0, listBody } = {}) {
  mkdirSync(dir, { recursive: true });
  const listed = listBody ?? JSON.stringify({ version: "2.6", ok: listCode === 0, command: "list-apps", data: { apps } });
  if (WIN) {
    writeFileSync(join(dir, "agent-desktop.cmd"), [
      "@echo off",
      "if /i \"%~1\"==\"status\" (",
      `  echo ${status}`,
      `  exit /b ${statusCode}`,
      ")",
      "if /i \"%~1\"==\"list-apps\" (",
      `  echo ${listed.replaceAll("%", "%%")}`,
      `  exit /b ${listCode}`,
      ")",
      "exit /b 2",
    ].join("\r\n") + "\r\n");
  } else {
    const p = join(dir, "agent-desktop");
    const q = (s) => s.replaceAll("'", "'\\''");
    writeFileSync(p, [
      "#!/bin/sh",
      'if [ "$1" = status ]; then',
      `  printf '%s\\n' '${q(status)}'`,
      `  exit ${statusCode}`,
      "fi",
      'if [ "$1" = list-apps ]; then',
      `  printf '%s\\n' '${q(listed)}'`,
      `  exit ${listCode}`,
      "fi",
      "exit 2",
    ].join("\n") + "\n");
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

test("agent-desktop on PATH with permissions granted and a registered app is ready", (t) => {
  const d = scratch(t);
  fakeDesktop(d);
  const r = main(["--need", "desktop", "--json"], env([d]), d);
  assert.equal(r.code, 0);
  assert.equal(drivers(r).desktop.state, "ready");
  assert.equal(drivers(r).desktop.version, "9.9.9");
  assert.deepEqual(drivers(r).desktop.apps, ["TextEditor"]);
});

test("agent-desktop installed where npm puts it but not on PATH is not-on-path, usable, and names the file", (t) => {
  const d = scratch(t);
  const off = WIN ? join(d, "appdata", "npm") : join(d, "home", ".npm-global", "bin");
  fakeDesktop(off);
  const r = main(["--need", "desktop", "--json"], env([d], WIN ? { APPDATA: join(d, "appdata") } : { HOME: join(d, "home") }), d);
  assert.equal(r.code, 0);
  const x = drivers(r).desktop;
  assert.equal(x.state, "not-on-path");
  assert.ok(x.fix.includes(off), x.fix);
});

test("agent-desktop without the accessibility permission is broken, not ready", (t) => {
  const d = scratch(t);
  fakeDesktop(d, { status: STATUS("denied") });
  const r = main(["--need", "desktop", "--json"], env([d]), d);
  assert.equal(r.code, 1);
  assert.equal(drivers(r).desktop.state, "broken");
  assert.match(drivers(r).desktop.detail, /accessibility permission is denied/);
});

test("a denied screen-recording permission alone does not make the desktop driver unusable", (t) => {
  const d = scratch(t);
  fakeDesktop(d, { status: '{"ok":true,"command":"status","data":{"permissions":{"accessibility":{"state":"granted"},"screen_recording":{"state":"denied"}},"version":"9.9.9"}}' });
  assert.equal(drivers(main(["--need", "desktop", "--json"], env([d]), d)).desktop.state, "ready");
});

test("a status envelope without data is broken, not a crash", (t) => {
  const d = scratch(t);
  fakeDesktop(d, { status: '{"ok":true,"command":"status"}' });
  const r = main(["--need", "desktop", "--json"], env([d]), d);
  assert.equal(r.code, 1);
  assert.equal(drivers(r).desktop.state, "broken");
});

test("adb with no device, and with only an unauthorized device, is no-device", (t) => {
  const d = scratch(t);
  fake(d, "adb", ["List of devices attached"]);
  let r = main(["--need", "android", "--json"], env([d]), d);
  assert.equal(r.code, 1);
  assert.equal(drivers(r).android.state, "no-device");
  fake(d, "adb", ["List of devices attached", "R58M123\tunauthorized"]);
  r = main(["--need", "android", "--json"], env([d]), d);
  assert.equal(drivers(r).android.state, "no-device");
  assert.match(drivers(r).android.detail, /unauthorized/);
});

test("a Linux `no permissions` row is reported, not dropped; daemon notices are not devices", (t) => {
  const d = scratch(t);
  fake(d, "adb", ["* daemon not running; starting now at tcp:5037", "* daemon started successfully", "List of devices attached", "adb server version (41) doesn't match this client (39); killing...", "0123456789ABCDEF\tno permissions (user in plugdev group)"]);
  const x = drivers(main(["--need", "android", "--json"], env([d]), d)).android;
  assert.equal(x.state, "no-device");
  assert.match(x.detail, /0123456789ABCDEF no permissions/);
  assert.doesNotMatch(x.detail, /daemon|server version/);
});

test("no-device names the emulator by full path when the SDK has one", (t) => {
  const d = scratch(t);
  fake(join(d, "sdk", "platform-tools"), "adb", ["List of devices attached"]);
  fake(join(d, "sdk", "emulator"), "emulator", ["x"]);
  const x = drivers(main(["--need", "android", "--json"], env([d], { ANDROID_HOME: join(d, "sdk") }), d)).android;
  assert.equal(x.state, "no-device");
  assert.ok(x.fix.includes(join(d, "sdk", "emulator")), x.fix);
});

test("a tool whose directory name contains %VAR% still runs", (t) => {
  const d = join(scratch(t), "p%PATH%q");
  fake(d, "adb", ["List of devices attached", "emulator-5554\tdevice"]);
  assert.equal(drivers(main(["--need", "android", "--json"], env([d]), d)).android.state, "ready");
});

test("adb with an online device is ready and lists it", (t) => {
  const d = scratch(t);
  fake(d, "adb", ["List of devices attached", "emulator-5554\tdevice"]);
  const r = main(["--need", "android", "--json"], env([d]), d);
  assert.equal(r.code, 0);
  assert.deepEqual(drivers(r).android.devices, ["emulator-5554"]);
});

test("adb only under ANDROID_HOME/platform-tools with a device is not-on-path and usable", (t) => {
  const d = scratch(t);
  fake(join(d, "sdk", "platform-tools"), "adb", ["List of devices attached", "emulator-5554\tdevice"]);
  const r = main(["--need", "android", "--json"], env([d], { ANDROID_HOME: join(d, "sdk") }), d);
  assert.equal(r.code, 0);
  assert.ok(drivers(r).android.bin.includes("platform-tools"));
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
  fakeDesktop(d);
  assert.equal(main(["--json"], env([d]), d).code, 0);
});

test("an unknown argument or driver name exits 2", () => {
  assert.equal(main(["--need", "ios"]).code, 2);
  assert.equal(main(["--wat"]).code, 2);
  assert.equal(main(["--need"]).code, 2);
  // names that exist on Object.prototype are not drivers
  for (const n of ["constructor", "__proto__", "toString"]) assert.equal(main(["--need", n, "--json"], { PATH: "", SECRET: "s3cr3t" }).code, 2, n);
});


test("status granted with an empty list-apps is no-app, not ready, and --need desktop exits 1", (t) => {
  const d = scratch(t);
  fakeDesktop(d, { apps: [] });
  const r = main(["--need", "desktop", "--json"], env([d], { DISPLAY: ":3", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/example/bus", XDG_RUNTIME_DIR: "/tmp/example-runtime" }), d);
  assert.equal(r.code, 1);
  const x = drivers(r).desktop;
  assert.equal(x.state, "no-app");
  assert.deepEqual(x.apps, []);
  assert.equal(x.display, ":3");
  assert.equal(x.bus, "unix:path=/tmp/example/bus");
  assert.equal(x.runtime_dir, "/tmp/example-runtime");
  assert.match(x.detail, /list-apps returned no applications/);
  assert.match(x.fix, /Start a new desktop app after the accessibility bus is up/);
  assert.match(x.fix, /do not kill a shared browser or restart the accessibility bus/);
  assert.match(x.fix, /references\/drivers\.md/);
  const text = main(["--need", "desktop"], env([d]), d).text;
  assert.match(text, /desktop: no-app/);
  assert.match(text, /fix: Start a new desktop app/);
});

test("without --need, a desktop no-app alone is not a usable driver", (t) => {
  const d = scratch(t);
  fakeDesktop(d, { apps: [] });
  assert.equal(main(["--json"], env([d]), d).code, 1);
});

test("list-apps that is not a list-apps envelope is broken, not ready or no-app", (t) => {
  const d = scratch(t);
  fakeDesktop(d, { listBody: '{"ok":false,"command":"list-apps","error":{"message":"boom"}}', listCode: 1 });
  const r = main(["--need", "desktop", "--json"], env([d]), d);
  assert.equal(r.code, 1);
  assert.equal(drivers(r).desktop.state, "broken");
  assert.match(drivers(r).desktop.detail, /boom/);
});

test("list-apps with no envelope is broken and says so, not ready or no-app", (t) => {
  const d = scratch(t);
  fakeDesktop(d, { listBody: "", listCode: 0 });
  const r = main(["--need", "desktop", "--json"], env([d]), d);
  assert.equal(r.code, 1);
  assert.equal(drivers(r).desktop.state, "broken");
  assert.match(drivers(r).desktop.detail, /produced no list-apps envelope/);
});

test("truncated list-apps JSON is broken and includes the raw text", (t) => {
  const d = scratch(t);
  fakeDesktop(d, { listBody: '{"ok":true,"command":"list-apps"', listCode: 0 });
  const r = main(["--need", "desktop", "--json"], env([d]), d);
  assert.equal(r.code, 1);
  assert.equal(drivers(r).desktop.state, "broken");
  assert.match(drivers(r).desktop.detail, /list-apps/);
});

test("an empty apps list with skipped or complete=false is broken, not no-app", (t) => {
  const d = scratch(t);
  fakeDesktop(d, { listBody: JSON.stringify({ version: "2.6", ok: true, command: "list-apps", data: { apps: [], complete: false, skipped: [{ pid: 99, reason: "the window inventory could not be fully read" }] } }) });
  const r = main(["--need", "desktop", "--json"], env([d]), d);
  assert.equal(r.code, 1);
  const x = drivers(r).desktop;
  assert.equal(x.state, "broken");
  assert.match(x.detail, /incomplete inventory/);
  assert.match(x.detail, /skipped/);
  assert.doesNotMatch(x.state, /no-app|ready/);
});

test("no-app off PATH stays no-app (not usable) and still names the full path", (t) => {
  const d = scratch(t);
  const off = WIN ? join(d, "appdata", "npm") : join(d, "home", ".npm-global", "bin");
  fakeDesktop(off, { apps: [] });
  const r = main(["--need", "desktop", "--json"], env([d], WIN ? { APPDATA: join(d, "appdata") } : { HOME: join(d, "home") }), d);
  assert.equal(r.code, 1);
  const x = drivers(r).desktop;
  assert.equal(x.state, "no-app");
  assert.equal(x.onPath, false);
  assert.ok(x.bin.includes(off), x.bin);
  assert.match(x.detail, /not on PATH/);
  assert.match(x.fix, /full path/);
  assert.ok(x.fix.includes(off), x.fix);
});

test("list-apps that times out is broken and names ETIMEDOUT, not a missing envelope or a bare signal", (t) => {
  const d = scratch(t);
  fakeDesktop(d);
  const x = probeDesktop(env([d]), d, (bin, args, e) => {
    if (args[0] === "list-apps") {
      const r = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { encoding: "utf8", env: e, timeout: 50, windowsHide: true });
      return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), error: r.error?.message, code: r.error?.code, signal: r.signal };
    }
    const r = spawnSync(bin, args, { encoding: "utf8", env: e, timeout: 15000, windowsHide: true });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), error: r.error?.message, code: r.error?.code, signal: r.signal };
  });
  assert.equal(x.state, "broken");
  assert.match(x.detail, /ETIMEDOUT/);
  assert.match(x.detail, /did not finish within 15s/);
  assert.doesNotMatch(x.detail, /produced no list-apps envelope/);
  assert.doesNotMatch(x.detail, /killed by signal/);
});

test("list-apps that cannot be started is broken and is not called a timeout", (t) => {
  const d = scratch(t);
  fakeDesktop(d);
  const missing = join(d, "no-such-agent-desktop");
  const x = probeDesktop(env([d]), d, (bin, args, e) => {
    const target = args[0] === "list-apps" ? missing : bin;
    const r = spawnSync(target, args, { encoding: "utf8", env: e, timeout: 15000, windowsHide: true });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), error: r.error?.message, code: r.error?.code, signal: r.signal };
  });
  assert.equal(x.state, "broken");
  assert.match(x.detail, /ENOENT/);
  assert.doesNotMatch(x.detail, /did not finish within/);
});

test("list-apps killed by SIGTERM without ETIMEDOUT is broken and names the signal, not a timeout", (t) => {
  const d = scratch(t);
  fakeDesktop(d);
  const x = probeDesktop(env([d]), d, (bin, args, e) => {
    if (args[0] === "status") {
      const r = spawnSync(bin, args, { encoding: "utf8", env: e, timeout: 15000, windowsHide: true });
      return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), error: r.error?.message, code: r.error?.code, signal: r.signal };
    }
    return { status: null, out: "", signal: "SIGTERM" };
  });
  assert.equal(x.state, "broken");
  assert.match(x.detail, /killed by signal SIGTERM/);
  assert.doesNotMatch(x.detail, /did not finish within/);
});

test("run as a command it prints one block per driver with the fix line", (t) => {
  const d = scratch(t);
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: d, env: env([d]), encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /desktop: missing \(agent-desktop\)\n {2}fix: npm install -g agent-desktop/);
  assert.match(r.stdout, /android: missing/);
  assert.match(r.stdout, /web: missing/);
});
