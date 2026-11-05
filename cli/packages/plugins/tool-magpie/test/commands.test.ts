import test from "node:test";
import assert from "node:assert/strict";
import type { ExecOptions, ExecResult } from "@mola/plugin-sdk";
import plugin from "@mola/plugin-tool-magpie";
import { commandOf, fakeCtx, fakeIo, type FakeCtx } from "./helpers.js";
import { MAGPIE_DSH, MAGPIE_LS, MAGPIE_MODELS_DSH, MAGPIE_STDERR_NOISE, OMP_CRASH } from "./fixtures.js";

// Fake CLIs are POSIX shell scripts: these run on Linux (WSL, CI); skipped on a Windows host.
const linuxTest = process.platform === "win32" ? test.skip : test;

/** Scripted magpie + agent CLI responses; nothing external runs. */
function scriptedExec(): { exec: (argv: string[], opts?: ExecOptions) => Promise<ExecResult>; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async exec(argv: string[]): Promise<ExecResult> {
      calls.push(argv);
      // the runner may resolve magpie to an absolute path (WSL interop)
      const bin = argv[0].split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
      const sub = argv[1];
      if (bin === "magpie") {
        if (sub === "ls") return { code: 0, stdout: MAGPIE_LS, stderr: MAGPIE_STDERR_NOISE };
        if (sub === "healthcheck") return { code: 0, stdout: "", stderr: "" };
        if (sub === "models" && argv[2] === "dsh") return { code: 0, stdout: MAGPIE_MODELS_DSH, stderr: MAGPIE_STDERR_NOISE };
        if (sub === "models") return { code: 0, stdout: MAGPIE_MODELS_DSH, stderr: MAGPIE_STDERR_NOISE };
        if (sub === "dsh") return { code: 0, stdout: MAGPIE_DSH, stderr: MAGPIE_STDERR_NOISE };
        return { code: 1, stdout: "", stderr: `magpie: unknown agent "${sub}"` };
      }
      if (bin === "dsh") return { code: 0, stdout: "0.2.1-rc.5\n", stderr: "" };
      if (bin === "bash" && argv[1] === "-lc") return { code: 0, stdout: "0.2.1-rc.5\n", stderr: "" };
      if (bin === "omp") return { code: 1, stdout: "", stderr: OMP_CRASH };
      return { code: 127, stdout: "", stderr: `spawn ${bin} ENOENT` };
    },
  };
}

function activatedCtx(json = false): { ctx: FakeCtx; calls: string[][] } {
  const script = scriptedExec();
  const ctx = fakeCtx({ exec: { exec: script.exec } as never });
  (plugin as { activate(ctx: unknown): void }).activate(ctx);
  return { ctx, calls: script.calls };
}

test("activate registers the agents commands, the tool adapter and the doctor checks", () => {
  const { ctx } = activatedCtx();
  assert.deepEqual(
    ctx.commands.registered.map((c) => c.path.join(" ")),
    ["agents list", "agents show", "agents routes"],
  );
  assert.equal(ctx.tools.registered[0].id, "magpie");
  assert.equal(ctx.agents.registered[0].id, "magpie");
  const ids = ctx.doctor.checks.map((c) => c.id);
  assert.ok(ids.includes("magpie.healthcheck"));
  for (const id of ["agent.claude", "agent.omp"]) assert.ok(ids.includes(id), `missing ${id}`);
  assert.ok(!ids.includes("agent.dsh"), "agent.dsh belongs to the agent-dsh plugin");
});

linuxTest("agents list merges PATH probes with `magpie ls`", async () => {
  const { ctx } = activatedCtx();
  const handler = commandOf(ctx, ["agents", "list"]).handler;
  const io = fakeIo(true);
  const code = await handler({ positionals: [], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.datas[0] as { agents: Array<Record<string, unknown>> };
  const dsh = data.agents.find((a) => a.id === "dsh")!;
  assert.equal(dsh.managedByMagpie, true);
  assert.equal(dsh.health, "ok");
  assert.ok(data.agents.some((a) => a.id === "omp" && a.health === "broken"));
  assert.ok(data.agents.some((a) => a.id === "vscode"), "magpie-only agents are listed");
});

test("agents show dsh reports the WSL dispatch profile", async () => {
  const { ctx } = activatedCtx();
  const handler = commandOf(ctx, ["agents", "show"]).handler;
  const io = fakeIo(true);
  const code = await handler({ positionals: ["dsh"], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.datas[0] as Record<string, unknown>;
  assert.equal(data.machine, "wsl:Ubuntu");
  assert.equal(data.model, "magpie/group/smart-split");
  assert.equal(data.managedByMagpie, true);
});

test("agents show for an unknown id exits 66 with AGENT_NOT_FOUND", async () => {
  const { ctx } = activatedCtx();
  const handler = commandOf(ctx, ["agents", "show"]).handler;
  const io = fakeIo(true);
  await assert.rejects(
    handler({ positionals: ["nope"], flags: {} }, io),
    (err: { code: string; exitCode: number }) => {
      assert.equal(err.code, "AGENT_NOT_FOUND");
      assert.equal(err.exitCode, 66);
      return true;
    },
  );
  assert.deepEqual(io.datas, [], "stdout stays clean on the error path");
});

test("agents routes parses `magpie models <agent>`", async () => {
  const { ctx } = activatedCtx();
  const handler = commandOf(ctx, ["agents", "routes"]).handler;
  const io = fakeIo(true);
  const code = await handler({ positionals: ["dsh"], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.datas[0] as { agent: string; routes: string[]; visible: string[] };
  assert.equal(data.agent, "dsh");
  assert.ok(data.routes.includes("group/smart-split"));
  assert.ok(data.visible.includes("auto/kimi-k3"));
});

test("agents list skips magpie with a clear message when it is unreachable", async () => {
  const ctx = fakeCtx({
    exec: {
      async exec() {
        throw new Error("spawn magpie.exe ENOENT");
      },
    } as never,
  });
  (plugin as { activate(ctx: unknown): void }).activate(ctx);
  const handler = commandOf(ctx, ["agents", "list"]).handler;
  const io = fakeIo(true);
  const code = await handler({ positionals: [], flags: {} }, io);
  assert.equal(code, 0, "magpie is skipped, not fatal");
  assert.ok(io.notes.some((n) => n.includes("magpie skipped")), "the reason is stated");
  const data = io.datas[0] as { agents: unknown[]; magpieUnavailable: string | null };
  assert.match(data.magpieUnavailable!, /ENOENT/);
  assert.ok(data.agents.length > 0, "the PATH probes are still reported");
});

linuxTest("agents show still works from the PATH probes when magpie is unreachable", async () => {
  const ctx = fakeCtx({
    exec: {
      async exec(argv: string[]) {
        if (argv[0] === "magpie") throw new Error("spawn magpie.exe ENOENT");
        if (argv[0] === "bash") return { code: 0, stdout: "0.2.1-rc.5\n", stderr: "" };
        throw new Error("spawn ENOENT");
      },
    } as never,
  });
  (plugin as { activate(ctx: unknown): void }).activate(ctx);
  const handler = commandOf(ctx, ["agents", "show"]).handler;
  const io = fakeIo(true);
  const code = await handler({ positionals: ["dsh"], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.datas[0] as Record<string, unknown>;
  assert.equal(data.id, "dsh");
  assert.equal(data.health, "ok");
});

test("doctor: magpie.healthcheck passes when the gateway answers", async () => {
  const { ctx } = activatedCtx();
  const check = ctx.doctor.checks.find((c) => c.id === "magpie.healthcheck")!;
  const result = await check.run();
  assert.equal(result.ok, true);
});

test("doctor: magpie.healthcheck fails with exit 69 when magpie is down", async () => {
  const ctx = fakeCtx({
    exec: {
      async exec() {
        return { code: 1, stdout: "", stderr: "gateway unreachable" };
      },
    } as never,
  });
  (plugin as { activate(ctx: unknown): void }).activate(ctx);
  const check = ctx.doctor.checks.find((c) => c.id === "magpie.healthcheck")!;
  const result = await check.run();
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 69);
});

test("doctor: agent.omp reports broken without failing, agent.claude reports absent", async () => {
  const { ctx } = activatedCtx();
  const omp = await ctx.doctor.checks.find((c) => c.id === "agent.omp")!.run();
  assert.equal(omp.ok, true, "a known-broken optional binary is not a doctor failure");
  assert.match(omp.message!, /broken.*SyntaxError/s);
  const claude = await ctx.doctor.checks.find((c) => c.id === "agent.claude")!.run();
  assert.equal(claude.ok, true, "an absent optional CLI is not a doctor failure");
  assert.match(claude.message!, /claude(.exe)? ENOENT/);
});

test("the tool adapter probes `magpie healthcheck`", async () => {
  const { ctx } = activatedCtx();
  const probe = await ctx.tools.registered[0].probe();
  assert.equal(probe.ok, true);
  assert.match(probe.detail!, /answers/);
});

test("the agent adapter reports magpie health", async () => {
  const { ctx } = activatedCtx();
  const d = await ctx.agents.registered[0].detect();
  assert.equal(d.available, true);
  assert.equal(d.health, "ok");
});
