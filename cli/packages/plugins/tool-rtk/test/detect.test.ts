/**
 * tool-rtk detection unit tests (core §9): fixture directories and env objects
 * stand in for the real machine, so nothing here touches the real rtk.
 * Windows behaviour (PATHEXT, WinGet layout) is simulated with `platform`
 * arguments — no Windows host is needed to exercise the branch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findInWinget, findOnPath, locateRtk, parseVersion } from "@mola/plugin-tool-rtk";

// POSIX PATH / WSL-only cases: run on Linux (WSL, CI); skipped on a Windows host.
const linuxTest = process.platform === "win32" ? test.skip : test;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mola-tool-rtk-"));
}

function touch(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "");
  fs.chmodSync(p, 0o755);
  return p;
}

test("parseVersion reads 'rtk 1.1.0'", () => {
  assert.equal(parseVersion("rtk 1.1.0\n"), "1.1.0");
});

test("parseVersion keeps an unexpected first line instead of swallowing it", () => {
  assert.equal(parseVersion("some-future-format\n"), "some-future-format");
  assert.equal(parseVersion("\n"), null);
});

linuxTest("findOnPath scans PATH on POSIX", () => {
  const dir = tmpDir();
  const exe = touch(dir, "rtk");
  const found = findOnPath({ PATH: `/usr/bin:${dir}` }, "linux", "rtk");
  assert.equal(found, exe);
  assert.equal(findOnPath({ PATH: "/usr/bin" }, "linux", "rtk"), null);
});

test("findOnPath applies PATHEXT on Windows (simulated)", () => {
  const dir = tmpDir();
  // the fixture spells the extension the way PATHEXT lists it; a real
  // Windows filesystem is case-insensitive, the Linux test host is not
  const exe = touch(dir, "rtk.EXE");
  // PATH uses the host delimiter (path.delimiter is resolved by the host, not
  // by the `platform` argument); the PATHEXT loop is what differs on win32
  const found = findOnPath({ PATH: dir, PATHEXT: ".COM;.EXE" }, "win32", "rtk");
  assert.equal(found, exe);
  assert.equal(findOnPath({ PATH: dir, PATHEXT: ".COM" }, "win32", "rtk"), null);
});

test("findInWinget is Windows-only", () => {
  const dir = tmpDir();
  assert.equal(findInWinget({ LOCALAPPDATA: dir }, "linux"), null);
});

test("findInWinget finds rtk.exe under the WinGet package dir (simulated)", () => {
  const local = tmpDir();
  // path.join keeps the fixture layout host-consistent; only the `platform`
  // argument and the package-dir naming are Windows-specific
  const old = path.join(local, "Microsoft", "WinGet", "Packages", "rtk-ai.rtk_1.0.0_x64__abcde");
  const newer = path.join(local, "Microsoft", "WinGet", "Packages", "rtk-ai.rtk_1.1.0_x64__abcde");
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  touch(newer, "rtk.exe"); // the older dir has no exe → skipped
  const found = findInWinget({ LOCALAPPDATA: local }, "win32");
  assert.ok(found, "expected the WinGet rtk.exe to be found");
  assert.match(found!, /rtk\.exe$/);
  assert.match(found!, /rtk_1\.1\.0/);
});

test("findInWinget picks the lexicographically newest package dir", () => {
  const local = tmpDir();
  const v1 = path.join(local, "Microsoft", "WinGet", "Packages", "rtk-ai.rtk_1.0.0_x64__abcde");
  const v2 = path.join(local, "Microsoft", "WinGet", "Packages", "rtk-ai.rtk_1.1.0_x64__abcde");
  fs.mkdirSync(v1, { recursive: true });
  fs.mkdirSync(v2, { recursive: true });
  touch(v1, "rtk.exe");
  touch(v2, "rtk.exe");
  const found = findInWinget({ LOCALAPPDATA: local }, "win32");
  assert.ok(found!.includes("1.1.0"));
});

test("locateRtk prefers PATH over the WinGet dir", () => {
  const dir = tmpDir();
  const exe = touch(dir, "rtk");
  const local = tmpDir();
  const pkg = path.join(local, "Microsoft", "WinGet", "Packages", "rtk-ai.rtk_1.1.0_x64__abcde");
  fs.mkdirSync(pkg, { recursive: true });
  touch(pkg, "rtk.exe");
  const loc = locateRtk({ PATH: dir, LOCALAPPDATA: local }, "win32");
  assert.equal(loc.source, "path");
  assert.equal(loc.path, exe);
});

test("locateRtk falls back to the WinGet dir, then reports none", () => {
  const local = tmpDir();
  const pkg = path.join(local, "Microsoft", "WinGet", "Packages", "rtk-ai.rtk_1.1.0_x64__abcde");
  fs.mkdirSync(pkg, { recursive: true });
  const exe = touch(pkg, "rtk.exe");
  const viaWinget = locateRtk({ PATH: "/nonexistent", LOCALAPPDATA: local }, "win32");
  assert.equal(viaWinget.source, "winget");
  assert.equal(viaWinget.path, exe);

  const none = locateRtk({ PATH: "/nonexistent", LOCALAPPDATA: "/nonexistent" }, "win32");
  assert.deepEqual(none, { path: null, source: "none" });
});
