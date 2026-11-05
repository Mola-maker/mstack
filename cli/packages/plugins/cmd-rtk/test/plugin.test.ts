/**
 * cmd-rtk passthrough tests. The real rtk is never invoked: a fake `rtk`
 * executable is placed on PATH and *records its argv into a file* (its stdout
 * is inherited by the test process, so the file is the observable), then exits
 * with a chosen code. This proves the three passthrough guarantees: verbatim
 * argv, preserved exit code, inherited stdio.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExitCode, Io, ParsedArgs, PluginContext } from "@mola/plugin-sdk";
import plugin from "@mola/plugin-cmd-rtk";

// Fake binaries are POSIX shell scripts: run on Linux (WSL, CI); skipped on a Windows host.
const linuxTest = process.platform === "win32" ? test.skip : test;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mola-cmd-rtk-"));
}

interface FakeRtk {
  dir: string;
  record: string;
  setExitCode: (code: number) => void;
  /** the argv the fake rtk received, read back from the record file */
  seenArgv: () => string[];
}

/** Put a recording fake `rtk` on PATH; returns the previous PATH value. */
function installFakeRtk(): FakeRtk {
  const dir = tmpDir();
  const record = path.join(dir, "argv.txt");
  const exitFile = path.join(dir, "exit.txt");
  fs.writeFileSync(exitFile, "0");
  const exe = path.join(dir, "rtk");
  fs.writeFileSync(
    exe,
    [
      "#!/bin/sh",
      // one token per line, NUL-free: each arg on its own line
      `for a in "$@"; do printf '%s\\n' "$a" >> "${record}"; done`,
      `exit "$(cat "${exitFile}")"`,
    ].join("\n"),
  );
  fs.chmodSync(exe, 0o755);
  return {
    dir,
    record,
    setExitCode: (code) => fs.writeFileSync(exitFile, String(code)),
    seenArgv: () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").split("\n").filter((l) => l !== "") : []),
  };
}

function withPathPrepended(dir: string, fn: () => void | Promise<void>): Promise<void> | void {
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev ?? ""}`;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
}

interface Handler {
  handler(args: ParsedArgs, io: Io): Promise<ExitCode>;
}

function loadHandler(): Handler {
  const registered: any[] = [];
  const ctx = {
    id: "mola-cmd-rtk",
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => ctx.log, level: "info" },
    permissions: { "process.exec": ["rtk", "rtk.exe"] },
    commands: { register: (c: any) => (registered.push(c), () => {}) },
  } as unknown as PluginContext;
  plugin.activate(ctx);
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].path, ["rtk"]);
  return registered[0];
}

function makeIo(overrides: Partial<Io> = {}): Io {
  const base: Io = {
    json: false,
    quiet: false,
    traceId: "trace-test",
    cwd: process.cwd(),
    yes: false,
    data() {},
    out() {},
    note() {},
    error() {},
  };
  return { ...base, ...overrides };
}

linuxTest("mola rtk passes its argv to rtk verbatim and preserves the exit code", async () => {
  const fake = installFakeRtk();
  fake.setExitCode(3);
  const handler = loadHandler();
  const prevArgv = process.argv;
  process.argv = [prevArgv[0], prevArgv[1], "rtk", "bypass", "git", "status", "--porcelain", "--", "two words"];
  try {
    await withPathPrepended(fake.dir, async () => {
      const code = await handler.handler(
        { positionals: ["bypass", "git", "status"], flags: { porcelain: true } },
        makeIo(),
      );
      assert.equal(code, 3, "rtk's exit code must become mola's exit code");
    });
    assert.deepEqual(fake.seenArgv(), ["bypass", "git", "status", "--porcelain", "--", "two words"]);
  } finally {
    process.argv = prevArgv;
  }
});

linuxTest("mola rtk keeps rtk's own -v instead of feeding it to the router", async () => {
  const fake = installFakeRtk();
  const handler = loadHandler();
  const prevArgv = process.argv;
  process.argv = [prevArgv[0], prevArgv[1], "rtk", "-v", "bypass", "git", "log"];
  try {
    await withPathPrepended(fake.dir, async () => {
      const code = await handler.handler(
        { positionals: ["bypass", "git", "log"], flags: { v: true } },
        makeIo(),
      );
      assert.equal(code, 0);
    });
    assert.deepEqual(fake.seenArgv(), ["-v", "bypass", "git", "log"]);
  } finally {
    process.argv = prevArgv;
  }
});

test("mola rtk with no args is a usage error (exit 64)", async () => {
  const fake = installFakeRtk();
  const handler = loadHandler();
  const prevArgv = process.argv;
  process.argv = [prevArgv[0], prevArgv[1], "rtk"];
  try {
    await withPathPrepended(fake.dir, async () => {
      await assert.rejects(
        handler.handler({ positionals: [], flags: {} }, makeIo()),
        (err: any) => err.code === "USAGE_ERROR" && err.exitCode === 64,
      );
    });
  } finally {
    process.argv = prevArgv;
  }
});

test("mola rtk without rtk installed exits 69 with an actionable message", async () => {
  const handler = loadHandler();
  const prev = process.env.PATH;
  const prevLocal = process.env.LOCALAPPDATA;
  delete process.env.PATH;
  delete process.env.LOCALAPPDATA;
  try {
    await assert.rejects(
      handler.handler({ positionals: ["gain"], flags: {} }, makeIo()),
      (err: any) => err.code === "UPSTREAM_UNAVAILABLE" && err.exitCode === 69,
    );
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocal;
  }
});

test("the exec allow-list is honoured: a ctx without rtk is denied (exit 77)", async () => {
  const fake = installFakeRtk();
  const registered: any[] = [];
  const ctx = {
    id: "mola-cmd-rtk",
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => ctx.log, level: "info" },
    permissions: { "process.exec": ["git"] },
    commands: { register: (c: any) => (registered.push(c), () => {}) },
  } as unknown as PluginContext;
  plugin.activate(ctx);
  const handler = registered[0];
  const prevArgv = process.argv;
  process.argv = [prevArgv[0], prevArgv[1], "rtk", "gain"];
  try {
    await withPathPrepended(fake.dir, async () => {
      await assert.rejects(
        handler.handler({ positionals: ["gain"], flags: {} }, makeIo()),
        (err: any) => err.code === "PERMISSION_DENIED" && err.exitCode === 77,
      );
    });
    assert.equal(fake.seenArgv().length, 0, "nothing may run when the allow-list denies it");
  } finally {
    process.argv = prevArgv;
  }
});

test("in --json mode the envelope goes to stderr, keeping stdout byte-clean", async () => {
  const fake = installFakeRtk();
  const handler = loadHandler();
  const prevArgv = process.argv;
  process.argv = [prevArgv[0], prevArgv[1], "rtk", "gain"];
  const seen: string[] = [];
  const io = makeIo({
    json: true,
    out: (line) => seen.push(line),
  });
  try {
    await withPathPrepended(fake.dir, async () => {
      const code = await handler.handler({ positionals: ["gain"], flags: {} }, io);
      assert.equal(code, 0);
    });
    assert.equal(seen.length, 1, "exactly one stderr line");
    const parsed = JSON.parse(seen[0]);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.command, "rtk");
    assert.deepEqual(parsed.data, { argv: ["gain"], exitCode: 0 });
  } finally {
    process.argv = prevArgv;
  }
});
