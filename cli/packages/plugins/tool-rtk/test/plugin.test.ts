/**
 * tool-rtk plugin-level tests (core §9): the plugin is activated against a
 * stub PluginContext whose exec service is mocked, so `rtk --version` is never
 * really executed — the fake binary on PATH is only there to make *detection*
 * (a filesystem scan) succeed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CheckResult, DoctorCheck, ExecResult, PluginContext, ToolAdapter } from "@mola/plugin-sdk";
import plugin from "@mola/plugin-tool-rtk";

// POSIX PATH / WSL-only cases: run on Linux (WSL, CI); skipped on a Windows host.
const linuxTest = process.platform === "win32" ? test.skip : test;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mola-tool-rtk-ctx-"));
}

/** Create a fake `rtk` file on PATH and return the previous PATH value. */
function fakeRtkOnPath(): string {
  const dir = tmpDir();
  const exe = path.join(dir, "rtk");
  fs.writeFileSync(exe, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(exe, 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev ?? ""}`;
  return prev ?? "";
}

function restorePath(prev: string): void {
  if (prev === "") delete process.env.PATH;
  else process.env.PATH = prev;
}

interface Ctx {
  ctx: PluginContext;
  tools: ToolAdapter[];
  checks: DoctorCheck[];
}

function makeCtx(execImpl: (argv: string[]) => Promise<ExecResult>): Ctx {
  const tools: ToolAdapter[] = [];
  const checks: DoctorCheck[] = [];
  const ctx = {
    id: "mola-tool-rtk",
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => ctx.log, level: "info" },
    tools: { register: (a: ToolAdapter) => (tools.push(a), () => {}) },
    doctor: { registerCheck: (c: DoctorCheck) => (checks.push(c), () => {}) },
    process: { exec: execImpl },
  } as unknown as PluginContext;
  return { ctx, tools, checks };
}

test("activate registers the rtk tool adapter and the tool.rtk doctor check", () => {
  const { ctx, tools, checks } = makeCtx(async () => ({ code: 0, stdout: "", stderr: "" }));
  plugin.activate(ctx);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, "rtk");
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, "tool.rtk");
});

test("doctor tool.rtk is ok when rtk is present and --version answers", async () => {
  const { ctx, checks } = makeCtx(async (argv) => {
    assert.equal(argv[1], "--version", "the probe must use the documented --version flag");
    return { code: 0, stdout: "rtk 9.9.9\n", stderr: "" };
  });
  plugin.activate(ctx);
  const prev = fakeRtkOnPath();
  try {
    const res: CheckResult = await checks[0].run();
    assert.equal(res.ok, true);
    assert.match(res.message!, /rtk 9\.9\.9/);
  } finally {
    restorePath(prev);
  }
});

linuxTest("doctor tool.rtk reports (not fails) when rtk is absent — the WSL case", async () => {
  const { ctx, checks } = makeCtx(async () => ({ code: 0, stdout: "", stderr: "" }));
  plugin.activate(ctx);
  const prev = process.env.PATH;
  delete process.env.PATH;
  try {
    const res: CheckResult = await checks[0].run();
    assert.equal(res.ok, true, "absent rtk must not fail the check");
    assert.match(res.message!, /rtk not found/);
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
});

test("doctor tool.rtk fails with exit 69 when rtk is present but unusable", async () => {
  const { ctx, checks } = makeCtx(async () => ({ code: 1, stdout: "", stderr: "boom" }));
  plugin.activate(ctx);
  const prev = fakeRtkOnPath();
  try {
    const res: CheckResult = await checks[0].run();
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 69);
  } finally {
    restorePath(prev);
  }
});

test("the registered adapter probes rtk for the tool registry", async () => {
  const { ctx, tools } = makeCtx(async () => ({ code: 0, stdout: "rtk 3.2.1\n", stderr: "" }));
  plugin.activate(ctx);
  const prev = fakeRtkOnPath();
  try {
    const probe = await tools[0].probe();
    assert.equal(probe.ok, true);
    assert.match(probe.detail!, /rtk 3\.2\.1/);
  } finally {
    restorePath(prev);
  }
});
