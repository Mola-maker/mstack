/**
 * Command tests for `mola run` and the six skill commands. The agents are
 * scripted fakes and the bus is a fake waterfall — no process is ever spawned.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import plugin from "../src/index.js";
import { makeFakeCtx, makeIo, type FakeAgent } from "./fake.js";

// dsh is "wsl:Ubuntu" only on Windows or inside WSL; a plain Linux CI runner has it local.
import { readFileSync as __readProc } from "node:fs";
const insideWsl = (() => { try { return /microsoft/i.test(__readProc("/proc/version", "utf8")); } catch { return false; } })();
const wslOrWindowsTest = process.platform === "win32" || insideWsl ? test : test.skip;

// The policy layer is read from $MOLA_HOME/policy.jsonc — point it at a fake
// home so the machine's real policy never leaks into the tests.
const HOME = path.resolve("/fake/home"); // MOLA_HOME is resolved (E:\fake\home on Windows)
process.env.MOLA_HOME = HOME;

function activate(opts: { agents?: FakeAgent[]; policy?: string; config?: Record<string, unknown> } = {}) {
  const f = makeFakeCtx({ agents: opts.agents ?? [], config: opts.config });
  if (opts.policy) {
    // the user layer of the policy (MOLA_HOME points at the fake home)
    f.files.set(path.join(HOME, "policy.jsonc"), opts.policy);
  }
  plugin.activate(f.ctx);
  const find = (name: string) => f.commands.find((c) => c.path.join(" ") === name)!;
  return { ...f, cmd: find("run"), skill: (n: string) => find(n) };
}

/** dsh-like agent that answers "done". */
function okAgent(id = "dsh"): FakeAgent {
  return { id, results: [{ exitCode: 0, finalText: "done" }], calls: [] };
}

test("run: the happy path routes, runs and reports the decision", async () => {
  const f = activate({ agents: [okAgent()] });
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["count TODOs"], flags: {} }, io);

  assert.equal(code, 0);
  const data = io.dataValue as any;
  assert.equal(data.agent, "dsh");
  assert.equal(data.modelRoute, "group/smart-split");
  assert.equal(data.exitCode, 0);
  assert.equal(data.finalText, "done");
  assert.match(data.reason, /implement → dsh on /);
  // the run is recorded in the state namespace
  assert.ok(f.kv["run:trace-test-0000-0000"]);
});

test("run: the prompt reaches the adapter verbatim, with the route and the cwd", async () => {
  const agent = okAgent();
  const f = activate({ agents: [agent] });
  const io = makeIo();
  await f.cmd.handler({ positionals: ["count TODOs"], flags: {} }, io);

  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0].prompt, "count TODOs");
  assert.equal(agent.calls[0].cwd, "/fake/ws");
  assert.equal(agent.calls[0].modelRoute, "group/smart-split");
  assert.equal(agent.calls[0].runId, "trace-test-0000-0000");
});

test("run: --agent pins the agent", async () => {
  const f = activate({ agents: [okAgent("dsh"), okAgent("claude")] });
  const io = makeIo();
  await f.cmd.handler({ positionals: ["task"], flags: { agent: "claude" } }, io);

  const data = io.dataValue as any;
  assert.equal(data.agent, "claude");
  assert.equal(f.agents.find((a) => a.id === "claude")!.calls.length, 1);
  assert.equal(f.agents.find((a) => a.id === "dsh")!.calls.length, 0);
});

test("run: an unknown --agent is AGENT_NOT_FOUND (exit 66)", async () => {
  const f = activate({ agents: [okAgent()] });
  const io = makeIo();
  await assert.rejects(
    () => f.cmd.handler({ positionals: ["task"], flags: { agent: "nope" } }, io),
    (err: any) => err.code === "AGENT_NOT_FOUND" && err.exitCode === 66,
  );
});

test("run: --route pins the model route", async () => {
  const agent = okAgent();
  const f = activate({ agents: [agent] });
  const io = makeIo();
  await f.cmd.handler({ positionals: ["task"], flags: { route: "auto/kimi-k3" } }, io);

  assert.equal(agent.calls[0].modelRoute, "auto/kimi-k3");
  assert.equal((io.dataValue as any).modelRoute, "auto/kimi-k3");
});

test("run: a banned route is refused before any agent runs (exit 77)", async () => {
  const agent = okAgent();
  const f = activate({ agents: [agent] });
  const io = makeIo();
  await assert.rejects(
    () => f.cmd.handler({ positionals: ["task"], flags: { route: "deepseek/deepseek-chat" } }, io),
    (err: any) => err.code === "ROUTE_BANNED" && err.exitCode === 77,
  );
  assert.equal(agent.calls.length, 0);
});

wslOrWindowsTest("run: --on pins the machine (dsh lives in WSL on Windows)", async () => {
  const f = activate({ agents: [okAgent("dsh"), okAgent("claude")] });
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["task"], flags: { on: "wsl" } }, io);
  assert.equal(code, 0);
  const data = io.dataValue as any;
  assert.equal(data.agent, "dsh");
  assert.match(data.machine, /^wsl:/);
});

test("run: the pre-dispatch gate can deny the run (exit 77 through the waterfall)", async () => {
  const agent = okAgent();
  const f = activate({ agents: [agent] });
  f.hooks.set("mola.task.pre-dispatch", [
    () => {
      throw Object.assign(new Error("denied by policy"), { name: "PolicyDenial" });
    },
  ]);
  const io = makeIo();
  await assert.rejects(() => f.cmd.handler({ positionals: ["task"], flags: {} }, io));
  assert.equal(agent.calls.length, 0);
});

test("run: the gate sees the route and the agent (the policy plugin's input)", async () => {
  const agent = okAgent();
  const f = activate({ agents: [agent] });
  const seen: any[] = [];
  f.hooks.set("mola.task.pre-dispatch", [
    (value: any) => {
      seen.push(value);
      return value;
    },
  ]);
  const io = makeIo();
  await f.cmd.handler({ positionals: ["task"], flags: { route: "auto/kimi-k3" } }, io);
  assert.equal(seen[0].modelRoute, "auto/kimi-k3");
  assert.equal(seen[0].agent, "dsh");
  assert.equal(seen[0].runId, "trace-test-0000-0000");
});

test("run: a 402 walks the ladder — the same route once, then an alternate route", async () => {
  const agent: FakeAgent = {
    id: "dsh",
    results: [
      { exitCode: 1, finalText: "QUOTA 402", quotaFailure: { provider: "magpie", route: "group/smart-split", status: 402 } },
      { exitCode: 1, finalText: "QUOTA 402", quotaFailure: { provider: "magpie", route: "group/smart-split", status: 402 } },
      { exitCode: 0, finalText: "recovered" },
    ],
    calls: [],
  };
  const f = activate({
    agents: [agent],
    policy: JSON.stringify({
      fallback: {
        onQuotaFailure: ["retry-same-route-once", "switch-route", "report"],
        alternateRoutes: ["auto/kimi-k3"],
      },
    }),
  });
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["task"], flags: {} }, io);

  assert.equal(code, 0);
  assert.equal(agent.calls.length, 3);
  assert.equal(agent.calls[0].modelRoute, "group/smart-split");
  assert.equal(agent.calls[1].modelRoute, "group/smart-split");
  assert.equal(agent.calls[2].modelRoute, "auto/kimi-k3");
  const data = io.dataValue as any;
  assert.equal(data.finalText, "recovered");
  assert.ok(Array.isArray(data.ladder));
  assert.equal(data.ladder.length, 2);
});

test("run: an exhausted ladder reports the failure (non-zero exit)", async () => {
  const agent: FakeAgent = {
    id: "dsh",
    results: [
      { exitCode: 1, finalText: "QUOTA 402", quotaFailure: { provider: "magpie", route: "group/smart-split", status: 402 } },
    ],
    calls: [],
  };
  const f = activate({
    agents: [agent],
    policy: JSON.stringify({ fallback: { onQuotaFailure: ["retry-same-route-once", "report"] } }),
  });
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["task"], flags: {} }, io);
  assert.notEqual(code, 0);
  assert.equal(agent.calls.length, 2); // the first attempt + the retry
  assert.ok((io.dataValue as any).quotaFailure);
});

test("run: without a task the usage error is exit 64", async () => {
  const f = activate({ agents: [okAgent()] });
  const io = makeIo();
  await assert.rejects(
    () => f.cmd.handler({ positionals: [], flags: {} }, io),
    (err: any) => err.code === "USAGE_ERROR" && err.exitCode === 64,
  );
});

test("run: with no runnable adapter the error is AGENT_NOT_FOUND (exit 66)", async () => {
  const f = activate({ agents: [] });
  const io = makeIo();
  await assert.rejects(
    () => f.cmd.handler({ positionals: ["task"], flags: {} }, io),
    (err: any) => err.code === "AGENT_NOT_FOUND" && err.exitCode === 66,
  );
});

test("run: the router puts the decision on the bus (agent + machine + modelRoute)", async () => {
  const f = activate({ agents: [okAgent()] });
  const io = makeIo();
  await f.cmd.handler({ positionals: ["task"], flags: { route: "auto/kimi-k3" } }, io);

  const started = f.emitted.filter((e) => e.event === "mola.session.started");
  assert.ok(started.length >= 1);
  const data = started[0].data as any;
  assert.equal(data.agent, "dsh");
  assert.equal(data.modelRoute, "auto/kimi-k3");
  assert.equal(data.cwd, "/fake/ws");
  assert.equal(data.runId, "trace-test-0000-0000");
  assert.match(data.machine, /^wsl:|local/);
});

test("run: full-auto needs an approval — without one it is downgraded to workspace-write", async () => {
  const agent = okAgent();
  const f = activate({
    agents: [agent],
    policy: JSON.stringify({ defaults: { permissionProfile: "full-auto" } }),
  });
  const io = makeIo();
  await f.cmd.handler({ positionals: ["task"], flags: {} }, io);

  assert.equal(agent.calls[0].permissionProfile, "workspace-write");
  assert.equal((io.dataValue as any).permissionProfile, "workspace-write");
  assert.ok(io.notes.some((n) => n.includes("full-auto needs an approval")));
});

test("run: full-auto passes when the policy approves it (batch-approved)", async () => {
  const agent = okAgent();
  const f = activate({
    agents: [agent],
    policy: JSON.stringify({
      defaults: { permissionProfile: "full-auto", approval: "batch-approved" },
    }),
  });
  const io = makeIo();
  await f.cmd.handler({ positionals: ["task"], flags: {} }, io);

  assert.equal(agent.calls[0].permissionProfile, "full-auto");
  assert.equal((io.dataValue as any).permissionProfile, "full-auto");
});

test("run: full-auto passes with --yes", async () => {
  const agent = okAgent();
  const f = activate({
    agents: [agent],
    policy: JSON.stringify({ defaults: { permissionProfile: "full-auto" } }),
  });
  const io = makeIo({ yes: true });
  await f.cmd.handler({ positionals: ["task"], flags: {} }, io);

  assert.equal(agent.calls[0].permissionProfile, "full-auto");
});

test("run: in --json mode the envelope carries the decision and the events stay on stderr", async () => {
  const agent = okAgent();
  const f = activate({ agents: [agent] });
  const io = makeIo({ json: true });
  await f.cmd.handler({ positionals: ["task"], flags: {} }, io);

  const data = io.dataValue as any;
  assert.equal(data.agent, "dsh");
  assert.ok(Array.isArray(data.ranked));
  assert.ok(Array.isArray(data.fallbacks));
  assert.equal(data.permissionProfile, "workspace-write");
  // nothing human on stdout in --json mode
  assert.deepEqual(io.outLines, []);
});

test("skills: each skill command runs its skill through the routed agent", async () => {
  for (const command of ["think", "plan", "goal", "team", "review", "ship"]) {
    const agent = okAgent();
    const f = activate({ agents: [agent] });
    const io = makeIo();
    const code = await f.skill(command).handler({ positionals: ["the topic"], flags: {} }, io);
    assert.equal(code, 0, `${command} failed`);
    assert.equal(agent.calls.length, 1, `${command} did not run the agent`);
    const prompt = agent.calls[0].prompt;
    assert.match(prompt, new RegExp(`m-${command}`), `${command}: the prompt does not name the skill`);
    assert.match(prompt, /the topic/, `${command}: the topic is missing`);
    // every skill that owns state names it; m-ship owns none (a PR is not a
    // state file) and the prompt must not invent one
    if (command === "ship") {
      assert.doesNotMatch(prompt, /\.mstack\//, "ship: the prompt invents a state path");
    } else {
      assert.match(prompt, /\.mstack\//, `${command}: the prompt names no .mstack state path`);
    }
    const data = io.dataValue as any;
    assert.equal(data.skill, `m-${command}`);
    assert.equal(data.command, command);
  }
});

test("skills: the skill command without a topic is a usage error (exit 64)", async () => {
  const f = activate({ agents: [okAgent()] });
  const io = makeIo();
  await assert.rejects(
    () => f.skill("think").handler({ positionals: [], flags: {} }, io),
    (err: any) => err.code === "USAGE_ERROR" && err.exitCode === 64,
  );
});

test("skills: the review command routes as a review task kind", async () => {
  const f = activate({
    agents: [okAgent("dsh"), okAgent("codex")],
    policy: JSON.stringify({ routes: { byTaskKind: { review: { agents: ["codex"] } } } }),
  });
  const io = makeIo();
  await f.skill("review").handler({ positionals: ["this diff"], flags: {} }, io);
  assert.equal((io.dataValue as any).agent, "codex");
});
