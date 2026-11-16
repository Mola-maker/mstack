#!/usr/bin/env node
// Probes the GUI drivers m-cua can use and says what is missing and how to connect it.
// Usage: node cua-doctor.mjs [--need desktop|android|web] [--json]
// Exit 0: every needed driver is usable (no --need: at least one is). Exit 1: a needed driver is not usable. Exit 2: bad arguments.
// A driver is one of: ready | not-on-path (installed and working, but only by the full path printed) | no-app | no-device | missing | broken.
// ready and not-on-path mean the loop can operate a real UI. no-app means the desktop tool and accessibility bus answered but no application has registered.
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, delimiter, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";

const WIN = process.platform === "win32";

/** First existing file named `name` (with a PATHEXT suffix on Windows) in `dirs`. */
export function findIn(dirs, name, env = process.env) {
  // On Windows an extensionless file beside the .cmd is npm's POSIX shim, so real launchers are tried first.
  const exts = WIN ? [...(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()), ""] : [""];
  for (const d of dirs.filter(Boolean))
    for (const e of exts) {
      const p = join(d, name + e);
      try { if (existsSync(p) && statSync(p).isFile()) return p; } catch { /* unreadable dir: keep looking */ }
    }
  return null;
}

const RUN_TIMEOUT_MS = 15000;

const run = (bin, args, env) => {
  const opts = { encoding: "utf8", env, timeout: RUN_TIMEOUT_MS, windowsHide: true };
  // Windows .cmd/.bat launchers need a shell. cmd expands %VAR% even inside quotes, so the directory never goes
  // into the command string: the file is run as .\<name> from its directory (the .\ stops cmd from taking a same-named file on PATH). Arguments are fixed strings, never user input.
  const viaShell = WIN && !/\.(exe|com)$/i.test(bin);
  const r = viaShell ? spawnSync(`".\\${basename(bin)}" ${args.join(" ")}`, { ...opts, cwd: dirname(bin), shell: true }) : spawnSync(bin, args, opts);
  return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), error: r.error?.message, code: r.error?.code, signal: r.signal };
};

/** Detail when a driver command did not produce a usable JSON envelope. */
function describeCommandFailure(r, command, timeoutMs = RUN_TIMEOUT_MS) {
  const parts = [];
  if (r.error) parts.push(r.error);
  const out = (r.out || "").trim();
  if (out) parts.push(out.slice(0, 200));
  const code = r.code || ((r.error || "").match(/(ETIMEDOUT|ENOENT)/) || [])[1];
  if (code === "ETIMEDOUT") parts.push(`${command} did not finish within ${timeoutMs / 1000}s`);
  else if (code === "ENOENT") { if (!r.error) parts.push(`${command} could not be started (ENOENT)`); }
  else if (r.status === null && r.signal) parts.push(`${command} was killed by signal ${r.signal}`);
  else if (typeof r.status === "number" && r.status !== 0) parts.push(`${command} exited ${r.status}`);
  return (parts.join("; ") || `${command} produced no ${command} envelope`).slice(0, 200);
}

/** First JSON envelope whose `command` field matches. Launcher notices on other lines are ignored. */
function envelope(out, command) {
  for (const line of out.split("\n")) {
    try { const j = JSON.parse(line); if (j.command === command) return j; } catch { /* not JSON */ }
  }
  return null;
}

/** The session this probe actually used, so a later run can compare it with the graphical terminal. */
function sessionOf(env) {
  const session = {};
  if (env.DISPLAY) session.display = env.DISPLAY;
  if (env.WAYLAND_DISPLAY) session.wayland = env.WAYLAND_DISPLAY;
  if (env.DBUS_SESSION_BUS_ADDRESS) session.bus = env.DBUS_SESSION_BUS_ADDRESS;
  if (env.XDG_RUNTIME_DIR) session.runtime_dir = env.XDG_RUNTIME_DIR;
  return session;
}

const NO_APP_FIX = "Start a new desktop app after the accessibility bus is up, from the same graphical session. Apps that started before the bus do not register; do not kill a shared browser or restart the accessibility bus. Prefer a preinstalled native app (file manager or text editor) over a first-run browser. How to copy the session environment is in references/drivers.md (desktop, Linux session).";

function locate(name, extraDirs, env) {
  const onPath = findIn((env.PATH || env.Path || "").split(delimiter), name, env);
  if (onPath) return { bin: onPath, onPath: true };
  const off = findIn(extraDirs, name, env);
  return off ? { bin: off, onPath: false } : null;
}

export function probeDesktop(env = process.env, _cwd, runner = run) {
  const extra = [env.APPDATA && join(env.APPDATA, "npm"), env.npm_config_prefix && join(env.npm_config_prefix, WIN ? "" : "bin"), env.HOME && join(env.HOME, ".npm-global", "bin")];
  const hit = locate("agent-desktop", extra, env);
  if (!hit) return { driver: "desktop", tool: "agent-desktop", state: "missing", fix: "npm install -g agent-desktop" };
  const session = sessionOf(env);
  const r = runner(hit.bin, ["status"], env);
  const st = envelope(r.out, "status");
  if (!st?.ok || !st.data) return { driver: "desktop", tool: "agent-desktop", state: "broken", bin: hit.bin, ...session, fix: "run `agent-desktop status` and read the error", detail: describeCommandFailure(r, "status") };
  // Reading the accessibility tree needs only this permission; screen recording matters for screenshots alone.
  const acc = st.data.permissions?.accessibility?.state;
  if (acc && !["granted", "not_required"].includes(acc))
    return { driver: "desktop", tool: "agent-desktop", state: "broken", bin: hit.bin, ...session, fix: process.platform === "darwin" ? "agent-desktop permissions --guide" : "agent-desktop permissions --request, then read `agent-desktop skills get platform`", detail: "accessibility permission is " + acc };
  // status can be granted with an empty tree: the bus answered, but no app has registered (agent-desktop: "answered, empty").
  const listed = runner(hit.bin, ["list-apps"], env);
  const appsEnv = envelope(listed.out, "list-apps");
  if (!appsEnv?.ok || !appsEnv.data || !Array.isArray(appsEnv.data.apps))
    return { driver: "desktop", tool: "agent-desktop", state: "broken", bin: hit.bin, ...session, fix: "run `agent-desktop list-apps` and read the error", detail: describeCommandFailure(listed, "list-apps") };
  const names = appsEnv.data.apps.map((a) => a && typeof a.name === "string" ? a.name : null).filter(Boolean);
  const base = { driver: "desktop", tool: "agent-desktop", bin: hit.bin, version: st.data.version, ...session, apps: names };
  if (st.data.supported_surfaces) base.surfaces = st.data.supported_surfaces;
  const skipped = Array.isArray(appsEnv.data.skipped) ? appsEnv.data.skipped : [];
  const incomplete = appsEnv.data.complete === false || skipped.length > 0;
  // An empty apps array with skipped or complete=false means the inventory was not fully read, not that nothing registered.
  if (!appsEnv.data.apps.length && incomplete) {
    const why = skipped.length ? `skipped: ${JSON.stringify(skipped).slice(0, 160)}` : "complete=false";
    return { ...base, state: "broken", detail: `list-apps returned no applications and an incomplete inventory (${why})`, fix: "run `agent-desktop list-apps` and read the skipped entries; retry after those applications have answered, or start a new app if they never register" };
  }
  if (!appsEnv.data.apps.length) {
    const row = { ...base, state: "no-app", onPath: hit.onPath, detail: "the accessibility bus answered but list-apps returned no applications", fix: NO_APP_FIX };
    if (!hit.onPath) {
      row.detail += `; agent-desktop is also not on PATH (${hit.bin})`;
      row.fix += ` Call it by full path, or add its directory to PATH: ${hit.bin}`;
    }
    return row;
  }
  return hit.onPath
    ? { ...base, state: "ready" }
    : { ...base, state: "not-on-path", fix: `call it by full path, or add its directory to PATH: ${hit.bin}` };
}

export function probeAndroid(env = process.env) {
  const sdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Android", "Sdk"), env.HOME && join(env.HOME, "Android", "Sdk"), env.HOME && join(env.HOME, "Library", "Android", "sdk")];
  const hit = locate("adb", sdks.filter(Boolean).map((s) => join(s, "platform-tools")), env);
  if (!hit) return { driver: "android", tool: "adb", state: "missing", fix: "install Android SDK Platform-Tools (https://developer.android.com/tools/releases/platform-tools) and put platform-tools on PATH" };
  const r = run(hit.bin, ["devices"], env);
  if (r.status !== 0) return { driver: "android", tool: "adb", state: "broken", bin: hit.bin, fix: "run `adb devices` and read the error", detail: (r.error || r.out).slice(0, 200) };
  // A device row is `<serial><TAB><state>`; the state can hold spaces ("no permissions (...)"). Notices such as
  // "* daemon started" or "adb server version (41) doesn't match this client" have no tab and are not devices.
  const rows = r.out.split("\n").map((l) => l.trim().match(/^(\S+)\t+(.+)$/)).filter(Boolean).map((m) => [m[1], m[2]]);
  const online = rows.filter((c) => c[1] === "device").map((c) => c[0]);
  if (!online.length) {
    // `emulator` is rarely on PATH; it sits beside platform-tools in the SDK.
    const emu = findIn([join(dirname(dirname(hit.bin)), "emulator")], "emulator", env) ?? "<Android SDK>/emulator/emulator";
    const why =(rows.length ? `devices present but not usable: ${rows.map((c) => c.join(" ")).join(", ")}` : "no device or emulator attached") + (hit.onPath ? "" : "; adb is also not on PATH");
    return { driver: "android", tool: "adb", state: "no-device", bin: hit.bin, onPath: hit.onPath, fix: `start an emulator ("${emu}" -list-avds, then "${emu}" -avd <name>; in PowerShell put & before the quoted path) or plug in a device with USB debugging authorised`, detail: why };
  }
  return hit.onPath
    ? { driver: "android", tool: "adb", state: "ready", bin: hit.bin, devices: online }
    : { driver: "android", tool: "adb", state: "not-on-path", bin: hit.bin, devices: online, fix: `call it by full path, or add its directory to PATH: ${hit.bin}` };
}

export function probeWeb(env = process.env, cwd = process.cwd()) {
  const hit = findIn([join(cwd, "node_modules", ".bin")], "playwright", env) || locate("playwright", [], env)?.bin;
  if (!hit) return { driver: "web", tool: "playwright", state: "missing", fix: "npm install -D @playwright/test && npx playwright install chromium" };
  const r = run(hit, ["--version"], env);
  if (r.status !== 0) return { driver: "web", tool: "playwright", state: "broken", bin: hit, fix: "run `npx playwright --version` and read the error", detail: (r.error || r.out).slice(0, 200) };
  return { driver: "web", tool: "playwright", state: "ready", bin: hit, version: r.out.trim().split("\n").pop() };
}

const PROBES = { desktop: probeDesktop, android: probeAndroid, web: probeWeb };

export function main(argv, env = process.env, cwd = process.cwd()) {
  const need = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--need" && Object.hasOwn(PROBES, argv[i + 1] ?? "")) need.push(argv[++i]);
    else return { code: 2, text: `usage: cua-doctor.mjs [--need desktop|android|web] [--json]  (bad argument: ${argv[i]})` };
  }
  const results = (need.length ? need : Object.keys(PROBES)).map((d) => PROBES[d](env, cwd));
  const usable = results.filter((r) => r.state === "ready" || r.state === "not-on-path");
  const ok = need.length ? usable.length === results.length : usable.length > 0;
  const text = json
    ? JSON.stringify({ ok, drivers: results })
    : results.map((r) => `${r.driver}: ${r.state} (${r.tool}${r.bin ? " at " + r.bin : ""})${r.detail ? " - " + r.detail : ""}${r.fix ? "\n  fix: " + r.fix : ""}`).join("\n");
  return { code: ok ? 0 : 1, text };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { code, text } = main(process.argv.slice(2));
  console.log(text);
  process.exit(code);
}
