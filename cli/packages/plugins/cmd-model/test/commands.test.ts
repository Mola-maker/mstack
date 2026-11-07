import test from "node:test";
import assert from "node:assert/strict";
import type { ExecOptions, ExecResult } from "@mola/plugin-sdk";
import plugin from "@mola/plugin-cmd-model";
import { commandOf, fakeCtx, fakeIo, type FakeCtx } from "./helpers.js";
import { MAGPIE_DSH, MAGPIE_LS, MAGPIE_MODELS, MAGPIE_STDERR_NOISE } from "./fixtures.js";

interface Script {
  exec: (argv: string[], opts?: ExecOptions) => Promise<ExecResult>;
  calls: string[][];
}

function scriptedExec(): Script {
  const calls: string[][] = [];
  return {
    calls,
    async exec(argv: string[]): Promise<ExecResult> {
      calls.push(argv);
      // the runner may resolve magpie to an absolute path (WSL interop)
      const bin = argv[0].split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
      const sub = argv[1];
      if (bin !== "magpie") throw new Error(`unexpected exec: ${argv.join(" ")}`);
      if (sub === "ls") return { code: 0, stdout: MAGPIE_LS, stderr: MAGPIE_STDERR_NOISE };
      if (sub === "models") return { code: 0, stdout: MAGPIE_MODELS, stderr: MAGPIE_STDERR_NOISE };
      if (sub === "dsh" && argv[2]) return { code: 0, stdout: "", stderr: MAGPIE_STDERR_NOISE };
      if (sub === "dsh") return { code: 0, stdout: MAGPIE_DSH, stderr: MAGPIE_STDERR_NOISE };
      return { code: 1, stdout: "", stderr: `magpie: unknown agent "${sub}"` };
    },
  };
}

function activatedCtx(opts: { exec?: Script["exec"] } = {}): { ctx: FakeCtx; calls: string[][] } {
  const script = scriptedExec();
  const execFn = opts.exec ?? script.exec;
  const ctx = fakeCtx({ exec: { exec: execFn } as never });
  (plugin as { activate(ctx: unknown): void }).activate(ctx);
  return { ctx, calls: script.calls };
}

test("activate registers model show|set|routes and models rank", () => {
  const { ctx } = activatedCtx();
  assert.deepEqual(
    ctx.commands.registered.map((c) => c.path.join(" ")),
    ["model show", "model set", "models rank", "model routes"],
  );
});

test("model show dsh reads the WSL dispatch profile: group/smart-split (source: profile patch)", async () => {
  const { ctx, calls } = activatedCtx();
  const handler = commandOf(ctx, ["model", "show"]).handler;
  const io = fakeIo(false);
  const code = await handler({ positionals: ["dsh"], flags: {} }, io);
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.slice(1)),
    [["ls"]],
    "one live magpie read, nothing else",
  );
  assert.match(io.outs[0] ?? "", /group\/smart-split\s+\(source: profile patch\)/);
});

test("model show resolves other agents and strips the magpie/ prefix", async () => {
  const { ctx } = activatedCtx();
  const handler = commandOf(ctx, ["model", "show"]).handler;
  const io = fakeIo(false);
  const code = await handler({ positionals: ["codex"], flags: {} }, io);
  assert.equal(code, 0);
  assert.match(io.outs[0] ?? "", /kimi-code-cn\/k3\s+\(source: magpie\)/);
});

test("model show --json emits an envelope payload", async () => {
  const { ctx } = activatedCtx();
  const handler = commandOf(ctx, ["model", "show"]).handler;
  const io = fakeIo(true);
  const code = await handler({ positionals: ["dsh"], flags: {} }, io);
  assert.equal(code, 0);
  assert.deepEqual(io.outs, [], "human stdout stays empty in --json mode");
  assert.deepEqual(io.datas[0], {
    agent: "dsh",
    magpieId: "dsh@wsl:Ubuntu",
    route: "group/smart-split",
    source: "profile patch",
    configPath: "\\\\wsl.localhost\\Ubuntu\\root\\.dsh\\profiles\\mola\\cordis.patch.yml",
  });
});

test("model show for an unknown agent exits 66 with AGENT_NOT_FOUND", async () => {
  const { ctx } = activatedCtx();
  const handler = commandOf(ctx, ["model", "show"]).handler;
  const io = fakeIo(true);
  await assert.rejects(
    handler({ positionals: ["nope"], flags: {} }, io),
    (err: { code: string; exitCode: number }) => {
      assert.equal(err.code, "AGENT_NOT_FOUND");
      assert.equal(err.exitCode, 66);
      return true;
    },
  );
});

test("model show without an argument is a usage error (64)", async () => {
  const { ctx } = activatedCtx();
  const handler = commandOf(ctx, ["model", "show"]).handler;
  await assert.rejects(
    handler({ positionals: [], flags: {} }, fakeIo(true)),
    (err: { code: string; exitCode: number }) => {
      assert.equal(err.code, "USAGE_ERROR");
      assert.equal(err.exitCode, 64);
      return true;
    },
  );
});

test("model set dsh auto/kimi-k3 runs `magpie dsh auto/kimi-k3` and exits 0", async () => {
  const { ctx, calls } = activatedCtx();
  const handler = commandOf(ctx, ["model", "set"]).handler;
  const io = fakeIo(false);
  const code = await handler({ positionals: ["dsh", "auto/kimi-k3"], flags: {} }, io);
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.slice(1)),
    [["dsh", "auto/kimi-k3"]],
    "the route goes to magpie verbatim",
  );
  assert.match(io.outs[0]!, /dsh → auto\/kimi-k3/);
});

test("model set with a banned route exits 77 ROUTE_BANNED and never execs", async () => {
  const { ctx, calls } = activatedCtx();
  const handler = commandOf(ctx, ["model", "set"]).handler;
  const io = fakeIo(true);
  await assert.rejects(
    handler({ positionals: ["dsh", "deepseek/deepseek-chat"], flags: {} }, io),
    (err: { code: string; exitCode: number; details?: { route?: string } }) => {
      assert.equal(err.code, "ROUTE_BANNED");
      assert.equal(err.exitCode, 77);
      assert.equal(err.details?.route, "deepseek/deepseek-chat");
      return true;
    },
  );
  assert.deepEqual(calls, [], "a banned route never reaches magpie");
});

test("model set with a route outside the whitelist exits 77", async () => {
  const { ctx, calls } = activatedCtx();
  const handler = commandOf(ctx, ["model", "set"]).handler;
  await assert.rejects(
    handler({ positionals: ["claude", "claude/claude-sonnet-5-5"], flags: {} }, fakeIo(true)),
    (err: { code: string; exitCode: number }) => {
      assert.equal(err.code, "POLICY_DENIED");
      assert.equal(err.exitCode, 77);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test("model set without a route is a usage error (64)", async () => {
  const { ctx } = activatedCtx();
  const handler = commandOf(ctx, ["model", "set"]).handler;
  await assert.rejects(
    handler({ positionals: ["dsh"], flags: {} }, fakeIo(true)),
    (err: { code: string; exitCode: number }) => {
      assert.equal(err.code, "USAGE_ERROR");
      assert.equal(err.exitCode, 64);
      return true;
    },
  );
});

test("model set maps a magpie failure to exit 69", async () => {
  const { ctx } = activatedCtx({
    exec: async (argv: string[]) => {
      if (argv[1] === "dshx") return { code: 1, stdout: "", stderr: 'magpie: unknown agent "dshx"' };
      return { code: 0, stdout: MAGPIE_LS, stderr: "" };
    },
  });
  const handler = commandOf(ctx, ["model", "set"]).handler;
  await assert.rejects(
    handler({ positionals: ["dshx", "auto/kimi-k3"], flags: {} }, fakeIo(true)),
    (err: { code: string; exitCode: number }) => {
      assert.equal(err.code, "UPSTREAM_UNAVAILABLE");
      assert.equal(err.exitCode, 69);
      return true;
    },
  );
});

test("model routes lists magpie's route ids with whitelist verdicts", async () => {
  const { ctx } = activatedCtx();
  const handler = commandOf(ctx, ["model", "routes"]).handler;
  const io = fakeIo(true);
  const code = await handler({ positionals: [], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.datas[0] as {
    allowed: string[];
    banned: string[];
    routes: Array<{ id: string; allowed: boolean; reason?: string }>;
  };
  assert.deepEqual(data.allowed, ["group/*", "auto/*"]);
  assert.deepEqual(data.banned, ["deepseek/*"]);
  const smart = data.routes.find((r) => r.id === "group/smart-split")!;
  assert.equal(smart.allowed, true);
  const banned = data.routes.find((r) => r.id === "deepseek/deepseek-v4-pro[1M]")!;
  assert.equal(banned.allowed, false);
  assert.equal(banned.reason, "banned");
});

test("model commands exit 69 when magpie is unreachable", async () => {
  const { ctx } = activatedCtx({
    exec: async () => {
      throw new Error("spawn magpie ENOENT");
    },
  });
  for (const path of ["model show", "model routes"]) {
    const handler = commandOf(ctx, path.split(" ") as [string, string]).handler;
    await assert.rejects(
      handler({ positionals: path === "model show" ? ["dsh"] : [], flags: {} }, fakeIo(true)),
      (err: { code: string; exitCode: number }) => {
        assert.equal(err.code, "UPSTREAM_UNAVAILABLE");
        assert.equal(err.exitCode, 69);
        return true;
      },
      path,
    );
  }
});

// ---- models rank (FRAMEWORK §12.3) -------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function withRoutingFile<T>(json: unknown, fn: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-rank-"));
  const file = path.join(dir, "model-routing.json");
  fs.writeFileSync(file, JSON.stringify(json));
  const before = process.env.MOLA_ROUTING_FILE;
  process.env.MOLA_ROUTING_FILE = file;
  return fn().finally(() => {
    if (before === undefined) delete process.env.MOLA_ROUTING_FILE;
    else process.env.MOLA_ROUTING_FILE = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const RANK_FILE = {
  updated: "2026-11-06",
  tasks: {
    debug: { desc: "bugs", picks: ["auto/claude-opus-5-5", "deepseek/deepseek-chat"], evidence: "Coding #5" },
    explore: { picks: ["auto/gemini-3.8-flash"], unverified: true },
  },
};

test("models rank <kind> --json lists the picks in order with the whitelist verdict", async () => {
  await withRoutingFile(RANK_FILE, async () => {
    const { ctx } = activatedCtx();
    const io = fakeIo(true);
    const code = await commandOf(ctx, ["models", "rank"]).handler({ positionals: ["debug"], flags: {} }, io);
    assert.equal(code, 0);
    const data = io.datas[0] as any;
    assert.equal(data.tasks.length, 1);
    assert.deepEqual(
      data.tasks[0].picks.map((p: any) => [p.rank, p.route, p.allowed, p.reason]),
      [
        [1, "auto/claude-opus-5-5", true, undefined],
        [2, "deepseek/deepseek-chat", false, "banned"],
      ],
    );
  });
});

test("models rank without a kind prints every kind as a table", async () => {
  await withRoutingFile(RANK_FILE, async () => {
    const { ctx, calls } = activatedCtx();
    const io = fakeIo(false);
    await commandOf(ctx, ["models", "rank"]).handler({ positionals: [], flags: {} }, io);
    const text = io.outs.join("\n");
    assert.match(text, /debug\s+1\s+\S+\s+auto\/claude-opus-5-5\s+Coding #5/);
    assert.match(text, /explore\s+1\s+\S+\s+auto\/gemini-3\.8-flash\s+\(unverified\)/);
    assert.equal(calls.length, 0, "rank is offline: magpie is never called");
  });
});

test("models rank: an unknown kind is a usage error, a missing file is NO_INPUT", async () => {
  await withRoutingFile(RANK_FILE, async () => {
    const { ctx } = activatedCtx();
    await assert.rejects(
      () => commandOf(ctx, ["models", "rank"]).handler({ positionals: ["zzz"], flags: {} }, fakeIo()),
      /unknown task kind "zzz"/,
    );
  });
  const before = process.env.MOLA_ROUTING_FILE;
  process.env.MOLA_ROUTING_FILE = path.join(os.tmpdir(), "does-not-exist-routing.json");
  try {
    const { ctx } = activatedCtx();
    await assert.rejects(
      () => commandOf(ctx, ["models", "rank"]).handler({ positionals: [], flags: {} }, fakeIo()),
      /cannot read/,
    );
  } finally {
    if (before === undefined) delete process.env.MOLA_ROUTING_FILE;
    else process.env.MOLA_ROUTING_FILE = before;
  }
});
