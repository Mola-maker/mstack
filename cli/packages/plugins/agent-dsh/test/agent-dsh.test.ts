/**
 * agent-dsh tests (node:test). All external processes (dsh, wsl) are mocked
 * through the fake ExecService — no test touches WSL or the harness.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { probeBinHealth, probeDsh, winSafeArgv } from "../src/detect.js";
import { dshExecArgv, dshMachine, dshProbeScript } from "../src/platform.js";
import plugin from "../src/index.js";
import { makeFakeCtx, errOf } from "./fake.js";

// Cases that read /proc/version: they only hold inside WSL (not on a plain Linux CI runner, not on Windows).
import { readFileSync as __readProc } from "node:fs";
const insideWsl = (() => { try { return /microsoft/i.test(__readProc("/proc/version", "utf8")); } catch { return false; } })();
const wslTest = insideWsl ? test : test.skip;

// POSIX paths and WSL detection: these run on Linux (WSL, CI); skipped on a Windows host.
const linuxTest = process.platform === "win32" ? test.skip : test;

linuxTest("platform: probe script and argv follow the tested flow", () => {
  const linux = dshExecArgv("echo hi", false);
  assert.deepEqual(linux, ["bash", "-lc", "echo hi"]);
  assert.match(dshProbeScript(), /source ~\/src\/mola-dsh-stack\/scripts\/env\.sh/);

  const windows = dshExecArgv("echo hi", true);
  assert.deepEqual(windows, ["wsl", "-e", "bash", "-lc", "echo hi"]);
  // on Windows we are inside wsl already: the env script is not sourced again
  assert.doesNotMatch(windows[4], /env\.sh/);
  assert.deepEqual(winSafeArgv(["magpie", "ls"], true), ["cmd", "/d", "/c", "magpie", "ls"]);
  assert.deepEqual(winSafeArgv(["magpie", "ls"], false), ["magpie", "ls"]);
});

linuxTest("dshMachine: WSL distro from WSL_DISTRO_NAME, wsl:Ubuntu on Windows", () => {
  assert.equal(dshMachine({ WSL_DISTRO_NAME: "Ubuntu" }), "wsl:Ubuntu");
  assert.equal(dshMachine({}), "local");
});

linuxTest("probeDsh: happy path parses the version", async () => {
  const exec: any = {
    exec: async (argv: string[]) => {
      assert.equal(argv[0], process.platform === "win32" ? "wsl" : "bash");
      return { code: 0, stdout: "0.2.1-rc.5\n", stderr: "" };
    },
  };
  const d = await probeDsh(exec);
  assert.equal(d.available, true);
  assert.equal(d.version, "0.2.1-rc.5");
  assert.equal(d.health, "ok");
  assert.equal(d.profile, "mola-cli");
});

linuxTest("probeDsh: missing binary reports broken with detail", async () => {
  const exec: any = {
    exec: async () => ({ code: 1, stdout: "", stderr: "bash: dsh: command not found\n" }),
  };
  const d = await probeDsh(exec);
  assert.equal(d.available, false);
  assert.equal(d.health, "broken");
  assert.match(d.detail!, /command not found/);
});

linuxTest("probeBinHealth: a crashing binary (omp's Bun SyntaxError) is broken", async () => {
  const broken = await probeBinHealth(
    { exec: async () => ({ code: 1, stdout: "1 | ~", stderr: "SyntaxError: Unexpected token" }) } as never,
    "omp",
  );
  assert.equal(broken.health, "broken");
  assert.match(broken.detail!, /SyntaxError/);

  const ok = await probeBinHealth(
    { exec: async () => ({ code: 0, stdout: "git version 2.45\n", stderr: "" }) } as never,
    "git",
  );
  assert.equal(ok.health, "ok");
  assert.equal(ok.version, "git version 2.45");
});

linuxTest("activate: registers the dsh adapter and the agent.dsh doctor check", () => {
  const f = makeFakeCtx();
  plugin.activate(f.ctx);
  assert.deepEqual(f.agents.map((a) => a.id), ["dsh"]);
  assert.ok(f.checks.some((c) => c.id === "agent.dsh"));
  assert.deepEqual(f.commands, []); // discovery (`mola agents list`) lives in tool-magpie
});

wslTest("adapter.detect: available, managedByMagpie, machine wsl:Ubuntu", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "0.2.1-rc.5\n", stderr: "" }) });
  plugin.activate(f.ctx);
  const d = await f.agents[0].detect();
  assert.equal(d.available, true);
  assert.equal(d.managedByMagpie, true);
  assert.equal(d.machine, "wsl:Ubuntu"); // WSL_DISTRO_NAME=Ubuntu in this environment
  assert.equal(d.profile, "mola-cli");
});

wslTest("doctor check agent.dsh: ok names machine wsl:Ubuntu; failure maps to exit 69", async () => {
  const ok = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "0.2.1-rc.5\n", stderr: "" }) });
  plugin.activate(ok.ctx);
  const good = await ok.checks.find((c) => c.id === "agent.dsh")!.run();
  assert.equal(good.ok, true);
  assert.match(good.message, /wsl:Ubuntu/);

  const bad = makeFakeCtx({ exec: async () => ({ code: 1, stdout: "", stderr: "command not found" }) });
  plugin.activate(bad.ctx);
  const failing = await bad.checks.find((c) => c.id === "agent.dsh")!.run();
  assert.equal(failing.ok, false);
  assert.equal(failing.exitCode, 69);
});

linuxTest("error contract: AGENT_NOT_FOUND is exit 66 (what `mola agents show nope` maps to)", () => {
  const err = errOf(Object.assign(new Error("nope"), { code: "AGENT_NOT_FOUND", exitCode: 66 }));
  assert.equal(err.code, "AGENT_NOT_FOUND");
  assert.equal(err.exitCode, 66);
});
