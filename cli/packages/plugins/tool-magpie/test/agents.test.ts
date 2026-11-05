import test from "node:test";
import assert from "node:assert/strict";
import type { ExecService } from "@mola/plugin-sdk";
import { AGENT_PROBES, mergeAgents, parseMagpieLs, probeAgent } from "@mola/plugin-tool-magpie";
import { MAGPIE_LS, OMP_CRASH } from "./fixtures.js";

// Fake CLIs are POSIX shell scripts: these run on Linux (WSL, CI); skipped on a Windows host.
const linuxTest = process.platform === "win32" ? test.skip : test;

function execOf(handlers: Record<string, () => { code: number; stdout?: string; stderr?: string }>): ExecService {
  return {
    async exec(argv: string[]) {
      const h = handlers[argv[0]];
      if (!h) throw new Error(`spawn ${argv[0]} ENOENT`);
      const r = h();
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
}

linuxTest("probeAgent reads the version of a healthy CLI", async () => {
  // on WSL/Linux the dsh probe runs `bash -lc 'command -v dsh && dsh --version'`
  const exec = execOf({ bash: () => ({ code: 0, stdout: "0.2.1-rc.5\n" }) });
  const dsh = AGENT_PROBES.find((p) => p.id === "dsh")!;
  const d = await probeAgent(dsh, exec);
  assert.equal(d.available, true);
  assert.equal(d.version, "0.2.1-rc.5");
  assert.equal(d.health, "ok");
});

test("probeAgent reports a crashing binary as broken (omp)", async () => {
  const exec = execOf({ omp: () => ({ code: 1, stderr: OMP_CRASH }) });
  const omp = AGENT_PROBES.find((p) => p.id === "omp")!;
  const d = await probeAgent(omp, exec);
  assert.equal(d.available, false);
  assert.equal(d.health, "broken");
  assert.match(d.detail!, /SyntaxError/);
});

test("probeAgent stays unknown when the binary is absent", async () => {
  const exec = execOf({}); // everything throws ENOENT
  const claude = AGENT_PROBES.find((p) => p.id === "claude")!;
  const d = await probeAgent(claude, exec);
  assert.equal(d.available, false);
  assert.equal(d.health, "unknown");
  assert.match(d.detail!, /ENOENT/);
});

test("probeAgent falls back to the .exe spelling", async () => {
  const exec = execOf({ "kimi.exe": () => ({ code: 0, stdout: "1.5.0" }) });
  const kimi = AGENT_PROBES.find((p) => p.id === "kimi")!;
  const d = await probeAgent(kimi, exec);
  assert.equal(d.available, true);
  assert.equal(d.version, "1.5.0");
});

test("AGENT_PROBES covers the CLIs captured in cli/design/inputs", () => {
  assert.deepEqual(
    AGENT_PROBES.map((p) => p.id),
    ["claude", "codex", "kimi", "grok", "agy", "devin", "pi", "opencode", "omp", "dsh"],
  );
});

function probesWith(exec: ExecService) {
  return AGENT_PROBES.map((spec) => ({ spec, detection: { available: false, health: "unknown" as const } }));
}

test("mergeAgents unions PATH probes with `magpie ls`", () => {
  const rows = parseFixtureLs();
  const probes = AGENT_PROBES.map((spec) => ({
    spec,
    detection: { available: spec.id === "dsh", health: spec.id === "dsh" ? ("ok" as const) : ("unknown" as const) },
  }));
  const merged = mergeAgents(probes, rows);

  const dsh = merged.find((a) => a.id === "dsh")!;
  assert.equal(dsh.available, true);
  assert.equal(dsh.health, "ok", "the probed (WSL) dsh is healthy");
  assert.equal(dsh.managedByMagpie, true);
  assert.equal(dsh.machine, "wsl:Ubuntu");
  assert.equal(dsh.magpieId, "dsh@wsl:Ubuntu", "the WSL profile row merged into the probed dsh");
  assert.equal(dsh.model, "magpie/group/smart-split");
  assert.equal(dsh.source, "both");

  const winDsh = merged.find((a) => a.id === "dsh@local")!;
  assert.equal(winDsh.magpieId, "dsh", "the Windows web profile is kept apart");
  assert.equal(winDsh.model, "magpie/group/claude-cheap");
  assert.equal(winDsh.machine, "local");

  const kimi = merged.find((a) => a.id === "kimi")!;
  assert.equal(kimi.managedByMagpie, true);
  assert.equal(kimi.model, "kimi-code/k3.1-pro");

  // magpie-only agents stay in the list
  assert.ok(merged.find((a) => a.id === "vscode"));
  assert.ok(merged.find((a) => a.id === "alma"));

  // every probed CLI is present even when absent from magpie
  assert.ok(merged.find((a) => a.id === "devin"));
});

test("mergeAgents never upgrades a broken binary because magpie knows it", () => {
  const probes = AGENT_PROBES.map((spec) => ({
    spec,
    detection:
      spec.id === "omp"
        ? { available: false, health: "broken" as const, detail: "Bun SyntaxError" }
        : { available: false, health: "unknown" as const },
  }));
  const merged = mergeAgents(probes, parseFixtureLs());
  const omp = merged.find((a) => a.id === "omp")!;
  assert.equal(omp.health, "broken");
  assert.equal(omp.managedByMagpie, true, "magpie still manages it — it just never gets routed");
});

test("mergeAgents with no magpie rows still lists the probed CLIs", () => {
  const merged = mergeAgents(probesWith({} as ExecService), []);
  assert.equal(merged.length, AGENT_PROBES.length);
  assert.ok(merged.every((a) => !a.managedByMagpie));
});

function parseFixtureLs() {
  return parseMagpieLs(MAGPIE_LS);
}
