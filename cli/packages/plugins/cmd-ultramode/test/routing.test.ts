/**
 * Routing and state tests for ultramode (unit 2): one goal in, one routed
 * pass through prepareRun + executeRun, with the m-goal file, the state
 * file, and the closeout written on every exit path. The agents are
 * scripted fakes; the routing table is absent (MOLA_ROUTING_FILE points
 * nowhere), so routing is policy-only and deterministic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import plugin, { slugifyGoal } from "../src/index.js";
import { errOf, makeFakeCtx, makeIo, type FakeAgent } from "./fake.js";

function activate(agents: FakeAgent[] = []) {
  const f = makeFakeCtx({ agents });
  plugin.activate(f.ctx);
  const cmd = f.commands.find((c) => c.path.join(" ") === "ultramode")!;
  assert.ok(cmd, "ultramode command is registered");
  return { ...f, cmd };
}

function doneAgent(id: string): FakeAgent {
  return { id, results: [{ exitCode: 0, finalText: "done" }], calls: [] };
}

function goalFiles(f: ReturnType<typeof activate>, slug: string) {
  const goalPath = `/fake/ws/.mstack/goals/${slug}.md`;
  const statePath = `/fake/ws/.mstack/goals/${slug}.state.json`;
  return {
    goalPath,
    statePath,
    goal: f.files.get(goalPath),
    state: f.files.get(statePath),
  };
}

test("ultramode: fake agent returns done — exit 0, goal file + state file written, closeout present, decision recorded", async () => {
  const f = activate([doneAgent("dsh"), doneAgent("claude")]);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship the fix"], flags: {} }, io);
  assert.equal(code, 0);

  const slug = slugifyGoal("ship the fix");
  assert.equal(slug, "ship-the-fix");
  const { goal, state } = goalFiles(f, slug);
  assert.ok(goal, "goal file is written");
  assert.match(goal!, /# Goal: ship the fix/);
  assert.match(goal!, /## Closeout/);
  assert.match(goal!, /- status: done/);
  assert.ok(state, "state file is written");
  const parsed = JSON.parse(state!);
  assert.equal(parsed.slug, slug);
  assert.equal(parsed.status, "done");
  assert.equal(parsed.rounds, 1);

  const data = io.dataValue as Record<string, unknown>;
  const ultra = data.ultramode as Record<string, unknown>;
  assert.equal(ultra.slug, slug);
  assert.equal(ultra.outcome, "done");
  const routingDefault = ultra.routingDefault as Record<string, unknown>;
  assert.equal(routingDefault.agent, "dsh");
  assert.equal(routingDefault.applied, true);
  assert.deepEqual(routingDefault.overriddenBy, []);
  assert.match(String(routingDefault.basis), /DSH Creator/);
  assert.equal(data.agent, "dsh");
  assert.equal(data.modelRoute, "group/smart-split");

  const dsh = f.agents.find((a) => a.id === "dsh")!;
  assert.equal(dsh.calls.length, 1);
  assert.equal(f.agents.find((a) => a.id === "claude")!.calls.length, 0);
  assert.equal(f.kv.activeGoal, slug);
  const run = f.kv[`run:${io.traceId}`] as Record<string, unknown>;
  assert.ok(run, "run record is kept");
  assert.equal((run.ultramode as Record<string, unknown>).outcome, "done");
});

test("ultramode: agent failure propagates the exit and still writes the closeout", async () => {
  const f = activate([{ id: "dsh", results: [{ exitCode: 3, finalText: "boom" }], calls: [] }]);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship the fix"], flags: {} }, io);
  assert.equal(code, 3);
  const { goal, state } = goalFiles(f, "ship-the-fix");
  assert.match(goal!, /- status: failed/);
  assert.match(goal!, /agent exited 3/);
  assert.equal(JSON.parse(state!).status, "failed");
  assert.equal(JSON.parse(state!).failures["agent-exit-3"], 1);
  const lastOutcome = f.kv.lastOutcome as Record<string, unknown>;
  assert.equal(lastOutcome.outcome, "failed");
  assert.equal(lastOutcome.exitCode, 3);
});

test("ultramode: no runnable agent raises AGENT_NOT_FOUND and still writes the closeout", async () => {
  const f = activate([]);
  const io = makeIo();
  await assert.rejects(
    f.cmd.handler({ positionals: ["ship the fix"], flags: {} }, io),
    (e: unknown) => {
      const err = errOf(e);
      assert.equal(err.code, "AGENT_NOT_FOUND");
      assert.equal(err.exitCode, 66);
      return true;
    },
  );
  const { goal, state } = goalFiles(f, "ship-the-fix");
  assert.match(goal!, /- status: failed/);
  assert.match(goal!, /routing agent-not-found/);
  assert.equal(JSON.parse(state!).status, "failed");
  assert.equal((f.kv.lastOutcome as Record<string, unknown>).outcome, "agent-not-found");
});

test("ultramode: routing denial writes the closeout and throws ROUTE_BANNED", async () => {
  const f = activate([doneAgent("dsh")]);
  f.files.set(
    "/fake/home/policy.jsonc",
    JSON.stringify({ modelRoutes: { allowedHeadless: ["group/*"], bannedHeadless: ["group/*"] } }),
  );
  const io = makeIo();
  await assert.rejects(
    f.cmd.handler({ positionals: ["ship the fix"], flags: {} }, io),
    (e: unknown) => {
      const err = errOf(e);
      assert.equal(err.code, "ROUTE_BANNED");
      assert.equal(err.exitCode, 77);
      return true;
    },
  );
  const { goal, state } = goalFiles(f, "ship-the-fix");
  assert.match(goal!, /- status: failed/);
  assert.match(goal!, /routing denied/);
  assert.equal(JSON.parse(state!).status, "failed");
  assert.equal((f.kv.lastOutcome as Record<string, unknown>).outcome, "denied");
  assert.equal(f.agents[0].calls.length, 0);
});

test("ultramode: --agent overrides the dsh default and is recorded", async () => {
  const f = activate([doneAgent("dsh"), doneAgent("claude")]);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship the fix"], flags: { agent: "claude" } }, io);
  assert.equal(code, 0);
  const data = io.dataValue as Record<string, unknown>;
  assert.equal(data.agent, "claude");
  const routingDefault = (data.ultramode as Record<string, unknown>).routingDefault as Record<string, unknown>;
  assert.equal(routingDefault.applied, false);
  assert.deepEqual(routingDefault.overriddenBy, ["--agent"]);
});

test("ultramode: status shows the active goal and its last outcome after a run", async () => {
  const f = activate([doneAgent("dsh")]);
  const runIo = makeIo();
  await f.cmd.handler({ positionals: ["ship the fix"], flags: {} }, runIo);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: [], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.dataValue as Record<string, unknown>;
  assert.equal(data.activeGoal, "ship-the-fix");
  const lastOutcome = data.lastOutcome as Record<string, unknown>;
  assert.equal(lastOutcome.outcome, "done");
  assert.equal(lastOutcome.exitCode, 0);
  assert.match(io.outLines.join("\n"), /goal active: ship-the-fix/);
  assert.match(io.outLines.join("\n"), /last outcome: ship-the-fix — done \(exit 0\)/);
});

test("ultramode: slug is kebab-case and truncated", () => {
  assert.equal(slugifyGoal("Fix the flaky test in CI!!"), "fix-the-flaky-test-in-ci");
  // truncated slugs carry a hash of the full goal so distinct long goals stay distinct; the total stays within 48 chars
  const longA = slugifyGoal("a".repeat(100));
  assert.match(longA, /^a{39}-[0-9a-f]{8}$/);
  assert.equal(longA.length, 48);
  assert.notEqual(longA, slugifyGoal(`${"a".repeat(100)}b`));
  // an empty slug after cleaning carries a hash instead of collapsing to "goal"
  assert.match(slugifyGoal("!!!"), /^goal-[0-9a-f]{8}$/);
  assert.notEqual(slugifyGoal("!!!"), slugifyGoal("???"));
});

test("ultramode: Chinese goals keep their unicode and slug distinctly", () => {
  assert.equal(slugifyGoal("修复登录失败的问题"), "修复登录失败的问题");
  assert.equal(slugifyGoal("优化首页加载速度"), "优化首页加载速度");
  assert.notEqual(slugifyGoal("修复登录失败的问题"), slugifyGoal("优化首页加载速度"));
});

test("ultramode: long goals sharing a prefix slug distinctly", () => {
  const prefix = "x".repeat(60);
  const a = slugifyGoal(`${prefix} one`);
  const b = slugifyGoal(`${prefix} two`);
  assert.notEqual(a, b);
  assert.ok(a.startsWith("x".repeat(39)), "the shared prefix is kept, the hash differs");
  assert.equal(a.length, 48, "the hashed slug stays within 48 chars");
});

test("ultramode: quoted multi-word 'ship the docs' is a goal, not the ship subcommand", async () => {
  const f = activate([doneAgent("dsh")]);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship the docs"], flags: {} }, io);
  assert.equal(code, 0);
  assert.ok(f.files.get("/fake/ws/.mstack/goals/ship-the-docs.md"), "goal file is written");
  assert.match(f.files.get("/fake/ws/.mstack/goals/ship-the-docs.md")!, /# Goal: ship the docs/);
});

test("ultramode: bare single-word 'ship' is a goal named ship, not a usage error", async () => {
  const f = activate([doneAgent("dsh")]);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship"], flags: {} }, io);
  assert.equal(code, 0);
  assert.ok(f.files.get("/fake/ws/.mstack/goals/ship.md"), "goal file is written");
  assert.match(f.files.get("/fake/ws/.mstack/goals/ship.md")!, /# Goal: ship/);
});

test("ultramode: bare single-word 'grant' is a goal too", async () => {
  const f = activate([doneAgent("dsh")]);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["grant"], flags: {} }, io);
  assert.equal(code, 0);
  assert.ok(f.files.get("/fake/ws/.mstack/goals/grant.md"), "goal file is written");
});

test("ultramode: re-running a goal keeps its history — ship/rsi records survive and a second closeout is appended", async () => {
  const agent: FakeAgent = {
    id: "dsh",
    results: [
      { exitCode: 0, finalText: "done" },
      { exitCode: 0, finalText: "done" },
    ],
    calls: [],
  };
  const f = activate([agent]);
  const io = makeIo();
  assert.equal(await f.cmd.handler({ positionals: ["ship the fix"], flags: {} }, io), 0);
  const statePath = "/fake/ws/.mstack/goals/ship-the-fix.state.json";
  const state = JSON.parse(f.files.get(statePath)!);
  state.ship = { slug: "ship-the-fix", verdict: "prepared", branch: "ultramode/ship-the-fix", pushed: false, at: "2026-11-11T00:00:00.000Z" };
  state.rsi = { stopReason: "saturated", rounds: 2, findings: 2 };
  f.files.set(statePath, JSON.stringify(state, null, 2) + "\n");
  assert.equal(await f.cmd.handler({ positionals: ["ship the fix"], flags: {} }, makeIo()), 0);
  const kept = JSON.parse(f.files.get(statePath)!);
  assert.equal(kept.ship.verdict, "prepared", "the ship record survives the re-run");
  assert.equal(kept.rsi.stopReason, "saturated", "the rsi record survives the re-run");
  assert.equal(kept.rounds, 2, "rounds accumulate across runs");
  const goal = f.files.get("/fake/ws/.mstack/goals/ship-the-fix.md")!;
  assert.match(goal, /re-run: goal re-entered/, "the re-run appends a checkpoint row instead of rewriting");
  assert.equal((goal.match(/## Closeout/g) ?? []).length, 2, "the second closeout is appended, not dropped");
  assert.match(goal, /- status: done/);
});
