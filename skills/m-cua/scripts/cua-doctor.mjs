#!/usr/bin/env node
// Probes the GUI drivers m-cua can use and says what is missing and how to connect it.
// Usage: node cua-doctor.mjs [--need desktop|android|web] [--json]
// Exit 0: every needed driver is usable (no --need: at least one is). Exit 1: a needed driver is not usable. Exit 2: bad arguments.
// A driver is one of: ready | not-on-path (installed and working, but only by the full path printed) | no-device | missing | broken.
// ready and not-on-path are both usable.
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

const run = (bin, args, env) => {
  const opts = { encoding: "utf8", env, timeout: 15000, windowsHide: true };
  // Windows .cmd/.bat launchers need a shell. cmd expands %VAR% even inside quotes, so the directory never goes
  // into the command string: the file is run as .\<name> from its directory (the .\ stops cmd from taking a same-named file on PATH). Arguments are fixed strings, never user input.
  const viaShell = WIN && !/\.(exe|com)$/i.test(bin);
  const r = viaShell ? spawnSync(`".\\${basename(bin)}" ${args.join(" ")}`, { ...opts, cwd: dirname(bin), shell: true }) : spawnSync(bin, args, opts);
  return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), error: r.error?.message };
};

function locate(name, extraDirs, env) {
  const onPath = findIn((env.PATH || env.Path || "").split(delimiter), name, env);
  if (onPath) return { bin: onPath, onPath: true };
  const off = findIn(extraDirs, name, env);
  return off ? { bin: off, onPath: false } : null;
}

export function probeDesktop(env = process.env) {
  const extra = [env.APPDATA && join(env.APPDATA, "npm"), env.npm_config_prefix && join(env.npm_config_prefix, WIN ? "" : "bin"), env.HOME && join(env.HOME, ".npm-global", "bin")];
  const hit = locate("agent-desktop", extra, env);
  if (!hit) return { driver: "desktop", tool: "agent-desktop", state: "missing", fix: "npm install -g agent-desktop" };
  const r = run(hit.bin, ["status"], env);
  let st = null;
  for (const line of r.out.split("\n")) { try { const j = JSON.parse(line); if (j.command === "status") st = j; } catch { /* launcher notices are not JSON */ } }
  if (!st?.ok || !st.data) return { driver: "desktop", tool: "agent-desktop", state: "broken", bin: hit.bin, fix: "run `agent-desktop status` and read the error", detail: (r.error || r.out).slice(0, 200) };
  // Reading the accessibility tree needs only this permission; screen recording matters for screenshots alone.
  const acc = st.data.permissions?.accessibility?.state;
  if (acc && !["granted", "not_required"].includes(acc))
    return { driver: "desktop", tool: "agent-desktop", state: "broken", bin: hit.bin, fix: process.platform === "darwin" ? "agent-desktop permissions --guide" : "agent-desktop permissions --request, then read `agent-desktop skills get platform`", detail: "accessibility permission is " + acc };
  return hit.onPath
    ? { driver: "desktop", tool: "agent-desktop", state: "ready", bin: hit.bin, version: st.data.version }
    : { driver: "desktop", tool: "agent-desktop", state: "not-on-path", bin: hit.bin, fix: `call it by full path, or add its directory to PATH: ${hit.bin}` };
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
