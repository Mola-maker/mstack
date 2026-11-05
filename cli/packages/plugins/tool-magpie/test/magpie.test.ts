import test from "node:test";
import assert from "node:assert/strict";
import { createMagpieRunner, magpieCandidates, stripLogNoise } from "@mola/plugin-tool-magpie";
import type { ExecService } from "@mola/plugin-sdk";
import { MAGPIE_STDERR_NOISE } from "./fixtures.js";

// Fake CLIs are POSIX shell scripts: these run on Linux (WSL, CI); skipped on a Windows host.
const linuxTest = process.platform === "win32" ? test.skip : test;

test("stripLogNoise drops magpie's dated log lines and keeps real errors", () => {
  const mixed = `${MAGPIE_STDERR_NOISE}magpie: unknown agent "nope" (try: claude, codex)\n`;
  const { stderr, noise } = stripLogNoise(mixed);
  assert.equal(stderr, 'magpie: unknown agent "nope" (try: claude, codex)');
  assert.equal(noise.length, 2);
  assert.match(noise[0], /^2026\/11\/05 /);
});

test("stripLogNoise keeps stderr that has no log noise at all", () => {
  const { stderr, noise } = stripLogNoise("connection refused\n");
  assert.equal(stderr, "connection refused");
  assert.deepEqual(noise, []);
});

test("the runner strips noise from exec results and reports unavailability", async () => {
  const calls: string[][] = [];
  const exec: ExecService = {
    async exec(argv: string[]) {
      calls.push(argv);
      return { code: 0, stdout: "ok\n", stderr: MAGPIE_STDERR_NOISE };
    },
  };
  const runner = createMagpieRunner({ exec, binary: "magpie.exe" });
  const res = await runner.run(["healthcheck"]);
  assert.deepEqual(calls, [["magpie.exe", "healthcheck"]]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, "ok\n");
  assert.equal(res.stderr, "");
  assert.equal(res.noise.length, 2);
});

test("the runner turns exec failures into an unavailable result, not a throw", async () => {
  const exec: ExecService = {
    async exec() {
      throw new Error("spawn magpie.exe ENOENT");
    },
  };
  const runner = createMagpieRunner({ exec, binary: "magpie.exe" });
  const res = await runner.run(["ls"]);
  assert.equal(res.code, 127);
  assert.match(res.unavailable!, /ENOENT/);
});

linuxTest("magpieCandidates prefers PATH names and adds the Windows install path", () => {
  const candidates = magpieCandidates();
  const expected = process.platform === "win32" ? ["magpie.exe", "magpie"] : ["magpie", "magpie.exe"];
  assert.deepEqual(candidates.slice(0, 2), expected);
  assert.ok(
    candidates.some((c) => c.endsWith("AppData/Local/Programs/magpie/magpie.exe")),
    "the WSL fallback reaches magpie.exe through /mnt/c",
  );
});
