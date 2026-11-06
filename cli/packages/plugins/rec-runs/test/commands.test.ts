/**
 * Command tests for `mola runs list|show` and `mola hooks list`, plus one
 * integration test through the real @mola/core CoreEventBus (describe() /
 * describeActiveBus() inventory). No external processes are touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { MolaEvents } from "@mola/plugin-sdk";
import { CoreEventBus, describeActiveBus } from "@mola/core";
import { RECORDER_EVENTS, RunRecorder } from "../src/recorder.js";
import { hooksListCommand, runsListCommand, runsShowCommand } from "../src/commands.js";
import { makeRecCtx, makeIo, errOf, nullLog, type FakeRec } from "./fake.js";

const WS = "/fake/ws";
const runDirOf = (run: string) => path.join(WS, ".mstack", "runs", run);

function readFileOrUndefined(fake: FakeRec, f: string): string | undefined {
  try {
    return fake.ctx.fs.readFile(f);
  } catch {
    return undefined;
  }
}

function setup(): FakeRec & { recorder: RunRecorder } {
  const fake = makeRecCtx({ traceId: "trace-a" });
  const recorder = new RunRecorder({
    state: fake.ctx.state,
    fs: fake.ctx.fs,
    log: fake.ctx.log,
    cwd: WS,
  });
  for (const e of RECORDER_EVENTS) fake.ctx.events.on(e, (env) => recorder.handle(env));
  return { ...fake, recorder };
}

function seedDispatchRun(fake: FakeRec & { recorder: RunRecorder }, run: string, exitCode = 0): void {
  fake.bus.dispatch(MolaEvents.CommandStarted, { traceId: run, path: "dispatch", argv: ["tasks/t.md"] }, { runId: run });
  fake.bus.dispatch(
    MolaEvents.SessionStarted,
    {
      agent: "dsh",
      sessionId: run,
      cwd: WS,
      machine: "wsl:Ubuntu",
      modelRoute: "group/smart-split",
    },
    { runId: run },
  );
  fake.bus.dispatch(MolaEvents.SessionEnded, { sessionId: run, exitCode }, { runId: run });
}

test("runs list: newest first, --json data is an array of summaries", async () => {
  const fake = setup();
  seedDispatchRun(fake, "trace-a");
  const cmd = runsListCommand(() => fake.recorder.entries());
  const io = makeIo({ json: true });
  const code = await cmd.handler({ positionals: [], flags: {} }, io);
  assert.equal(code, 0);
  const rows = io.dataValue as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, "trace-a");
  assert.equal(rows[0].agent, "dsh");
  assert.equal(rows[0].modelRoute, "group/smart-split");
  assert.equal(rows[0].exitCode, 0);
});

test("runs list: --limit and --agent filter; human mode prints a table", async () => {
  const fake = setup();
  seedDispatchRun(fake, "trace-a");
  seedDispatchRun(fake, "trace-b", 3);
  const cmd = runsListCommand(() => fake.recorder.entries());

  const io = makeIo();
  await cmd.handler({ positionals: [], flags: { limit: "1" } }, io);
  assert.match(io.outLines[0], /started\s+state/);
  assert.equal(io.outLines.length, 2); // header + newest row (trace-b)

  const io2 = makeIo();
  await cmd.handler({ positionals: [], flags: { agent: "dsh", limit: "10" } }, io2);
  assert.equal(io2.outLines.length, 3);

  const io3 = makeIo();
  await cmd.handler({ positionals: [], flags: { agent: "claude" } }, io3);
  assert.deepEqual(io3.outLines[1], "(no recorded runs — dispatch or run a task first)");
});

test("runs show: missing traceId is usage (64); unknown run is no-input (66)", async () => {
  const fake = setup();
  const cmd = runsShowCommand(
    (t) => fake.recorder.get(t),
    (f) => readFileOrUndefined(fake, f),
    (t) => runDirOf(t),
  );
  await assert.rejects(
    cmd.handler({ positionals: [], flags: {} }, makeIo()),
    (e: unknown) => errOf(e).exitCode === 64,
  );
  await assert.rejects(
    cmd.handler({ positionals: ["nope"], flags: {} }, makeIo()),
    (e: unknown) => {
      const err = errOf(e);
      return err.exitCode === 66 && err.code === "NO_INPUT";
    },
  );
});

test("runs show: decision, event kinds and artifacts; human output lists them", async () => {
  const fake = setup();
  seedDispatchRun(fake, "trace-a");
  fake.bus.dispatch(MolaEvents.AgentMessage, { sessionId: "trace-a", text: "x" });
  fake.bus.dispatch(MolaEvents.AgentMessage, { sessionId: "trace-a", text: "y" });
  fake.bus.dispatch(MolaEvents.TurnCompleted, { sessionId: "trace-a" });

  const cmd = runsShowCommand(
    (t) => fake.recorder.get(t),
    (f) => readFileOrUndefined(fake, f),
    (t) => runDirOf(t),
  );
  const io = makeIo({ json: true });
  const code = await cmd.handler({ positionals: ["trace-a"], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.dataValue as { run: Record<string, unknown>; decision: Record<string, unknown>; events: Array<{ kind: string; count: number }> };
  assert.equal(data.decision.modelRoute, "group/smart-split");
  assert.deepEqual(
    data.events.map((e) => [e.kind, e.count]),
    [
      ["mola.agent.message", 2],
      ["mola.command.started", 1],
      ["mola.session.ended", 1],
      ["mola.session.started", 1],
      ["mola.turn.completed", 1],
    ],
  );

  const ioHuman = makeIo();
  await cmd.handler({ positionals: ["trace-a"], flags: {} }, ioHuman);
  assert.ok(ioHuman.outLines.some((l) => /route\s+group\/smart-split/.test(l)));
  assert.ok(ioHuman.outLines.some((l) => l.includes("mola.agent.message ×2")));
});

test("runs show: pruned artifacts degrade gracefully (run entry only)", async () => {
  const fake = setup();
  seedDispatchRun(fake, "trace-a");
  for (const f of fake.files.keys()) if (f.startsWith(runDirOf("trace-a"))) fake.files.delete(f);

  const cmd = runsShowCommand((t) => fake.recorder.get(t), () => undefined, (t) => runDirOf(t));
  const io = makeIo({ json: true });
  const code = await cmd.handler({ positionals: ["trace-a"], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.dataValue as { decision?: unknown; events: unknown[] };
  assert.equal(data.decision, undefined);
  assert.deepEqual(data.events, []);
});

test("runs show: index miss falls back to the run's decision.json artifacts", async () => {
  const fake = setup();
  seedDispatchRun(fake, "trace-a");
  // the index loses the entry (pruned / other workspace), the artifacts remain
  fake.ctx.state.delete(`run:trace-a`);

  const cmd = runsShowCommand(
    (t) => fake.recorder.get(t),
    (f) => readFileOrUndefined(fake, f),
    (t) => runDirOf(t),
  );
  const io = makeIo({ json: true });
  const code = await cmd.handler({ positionals: ["trace-a"], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.dataValue as { run: Record<string, unknown>; decision: Record<string, unknown> };
  assert.equal(data.run.agent, "dsh");
  assert.equal(data.decision.modelRoute, "group/smart-split");

  // no index entry AND no artifacts → still NO_INPUT (66)
  for (const f of [...fake.files.keys()]) fake.files.delete(f);
  await assert.rejects(
    cmd.handler({ positionals: ["trace-a"], flags: {} }, makeIo()),
    (e: unknown) => errOf(e).exitCode === 66,
  );
});

test("hooks list: sorted inventory, human table has owner column", async () => {
  const cmd = hooksListCommand(() => [
    { event: MolaEvents.ToolBefore, kind: "waterfall", owner: "mola-policy-approval" },
    { event: MolaEvents.SessionStarted, kind: "broadcast", owner: "mola-rec-runs" },
    { event: MolaEvents.ToolBefore, kind: "waterfall", owner: "mola-core" },
  ]);
  const io = makeIo({ json: true });
  const code = await cmd.handler({ positionals: [], flags: {} }, io);
  assert.equal(code, 0);
  assert.deepEqual(io.dataValue, [
    { event: "mola.session.started", kind: "broadcast", owner: "mola-rec-runs" },
    { event: "mola.tool.before", kind: "waterfall", owner: "mola-core" },
    { event: "mola.tool.before", kind: "waterfall", owner: "mola-policy-approval" },
  ]);

  const ioHuman = makeIo();
  await cmd.handler({ positionals: [], flags: {} }, ioHuman);
  assert.match(ioHuman.outLines[0], /^event {2,}kind {2,}owner/);
  assert.ok(ioHuman.outLines.some((l) => l.includes("mola-policy-approval")));
});

test("hooks list: empty registry is an empty array, exit 0", async () => {
  const cmd = hooksListCommand(() => []);
  const io = makeIo({ json: true });
  const code = await cmd.handler({ positionals: [], flags: {} }, io);
  assert.equal(code, 0);
  assert.deepEqual(io.dataValue, []);
});

test("integration: listeners registered through a real CoreEventBus are inventoried", async () => {
  // one bus per process — constructing it makes describeActiveBus() see it
  const bus = new CoreEventBus({ log: nullLog, traceId: "trace-bus" });
  const fake = makeRecCtx();
  const recorder = new RunRecorder({ state: fake.ctx.state, fs: fake.ctx.fs, log: fake.ctx.log, cwd: WS });
  for (const e of RECORDER_EVENTS) bus.on(e, (env) => recorder.handle(env), "mola-rec-runs");
  bus.hook(MolaEvents.ToolBefore, (v) => v, "mola-policy-approval");

  const inventory = describeActiveBus();
  assert.equal(inventory.length, RECORDER_EVENTS.length + 1);
  assert.ok(inventory.some((i) => i.kind === "waterfall" && i.owner === "mola-policy-approval"));

  // the same bus feeds the recorder: a dispatch run lands in events.jsonl
  bus.emit(MolaEvents.CommandStarted, { traceId: "trace-bus", path: "dispatch", argv: [] });
  bus.emit(MolaEvents.SessionStarted, { agent: "dsh", cwd: WS, machine: "wsl:Ubuntu", modelRoute: "group/smart-split" });
  bus.emit(MolaEvents.SessionEnded, { sessionId: "trace-bus", exitCode: 0 });
  const lines = fake.files
    .get(path.join(runDirOf("trace-bus"), "events.jsonl"))!
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { kind: string }).kind);
  assert.deepEqual(lines, ["mola.command.started", "mola.session.started", "mola.session.ended"]);

  const cmd = runsShowCommand((t) => recorder.get(t), (f) => fake.ctx.fs.readFile(f), (t) => runDirOf(t));
  const io = makeIo({ json: true });
  await cmd.handler({ positionals: ["trace-bus"], flags: {} }, io);
  assert.equal((io.dataValue as { run: Record<string, unknown> }).run.exitCode, 0);
});
