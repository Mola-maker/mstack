/**
 * The run's NDJSON event stream, seen from the command's own body
 * (prepareRun + executeRun). Core §8.2: `run` is a streaming command — in
 * `--json` mode stdout carries exactly ONE envelope and the run's events go to
 * stderr as NDJSON. The sink is injected here, so nothing is written to the
 * real stderr and no process is spawned.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { executeRun, prepareRun } from "../src/index.js";
import { loadPolicy } from "../src/policy.js";
import { eventKinds, recordingSink } from "../src/stream.js";
import { makeFakeCtx, makeIo, type FakeAgent } from "./fake.js";

const HOME = path.resolve("/fake/home"); // MOLA_HOME is resolved (E:\fake\home on Windows)
process.env.MOLA_HOME = HOME;

/** An agent that emits the ADR-0004 §1 vocabulary through the onEvent tap. */
function streamingAgent(): FakeAgent {
  return {
    id: "dsh",
    results: [{ exitCode: 0, finalText: "the answer" }],
    calls: [],
    events: [
      { kind: "mola.session.started", data: { agent: "dsh", machine: "wsl:Ubuntu" } },
      { kind: "mola.agent.message", data: { role: "assistant", textExcerpt: "hello" } },
      { kind: "mola.turn.completed", data: { turnId: "t1" } },
      { kind: "mola.task.done", data: { runId: "trace-test-0000-0000" } },
      { kind: "mola.session.ended", data: { exitCode: 0 } },
    ],
  };
}

async function runThrough(f: ReturnType<typeof makeFakeCtx>, io: ReturnType<typeof makeIo>, prompt = "the task") {
  const policy = loadPolicy(f.ctx.fs, io.cwd);
  const prepared = await prepareRun(f.ctx, {
    taskKind: "implement",
    prompt,
    flags: {},
    cwd: io.cwd,
    policy,
  });
  const sink = recordingSink();
  const code = await executeRun(f.ctx, io, {
    prompt,
    prepared,
    runId: io.traceId,
    command: "run",
    argv: [prompt],
    sink,
  });
  return { code, sink };
}

test("run: the NDJSON stream carries the routing decision first, then the adapter's events", async () => {
  const f = makeFakeCtx({ agents: [streamingAgent()] });
  const io = makeIo({ json: true });
  const { code, sink } = await runThrough(f, io);

  assert.equal(code, 0);
  const kinds = eventKinds(sink.events);
  assert.equal(kinds[0], "mola.session.started");
  for (const expected of [
    "mola.session.started",
    "mola.agent.message",
    "mola.turn.completed",
    "mola.task.done",
    "mola.session.ended",
  ]) {
    assert.ok(kinds.includes(expected), `the stream misses ${expected} (${kinds.join(", ")})`);
  }
});

test("run: the routing event names the agent, the machine and the model route", async () => {
  const f = makeFakeCtx({ agents: [streamingAgent()] });
  const io = makeIo({ json: true });
  const { sink } = await runThrough(f, io);

  const routing = sink.events[0];
  assert.equal(routing.kind, "mola.session.started");
  const data = routing.data as Record<string, unknown>;
  assert.equal(data.agent, "dsh");
  assert.equal(data.modelRoute, "group/smart-split");
  assert.equal(data.cwd, "/fake/ws");
  assert.equal(data.runId, "trace-test-0000-0000");
  assert.equal(routing.source.agent, "dsh");
  assert.equal(routing.source.runId, "trace-test-0000-0000");
});

test("run: the routing event goes on the bus too (rec-runs reads it)", async () => {
  const f = makeFakeCtx({ agents: [streamingAgent()] });
  const io = makeIo();
  await runThrough(f, io);

  const started = f.emitted.filter((e) => e.event === "mola.session.started");
  assert.ok(started.length >= 1);
  const data = started[0].data as Record<string, unknown>;
  assert.equal(data.agent, "dsh");
  assert.equal(data.modelRoute, "group/smart-split");
  assert.equal(data.cwd, "/fake/ws");
});

test("run: the --json envelope reports the event kinds the run produced", async () => {
  const f = makeFakeCtx({ agents: [streamingAgent()] });
  const io = makeIo({ json: true });
  await runThrough(f, io);

  const data = io.dataValue as any;
  assert.ok(Array.isArray(data.eventKinds));
  assert.ok(data.eventKinds.includes("mola.task.done"));
  assert.ok(data.eventKinds.includes("mola.session.ended"));
  // the state record keeps them too
  assert.ok((f.kv["run:trace-test-0000-0000"] as any).eventKinds.includes("mola.task.done"));
});

test("run: in --json mode nothing human goes to stdout (the stream is stderr-only)", async () => {
  const f = makeFakeCtx({ agents: [streamingAgent()] });
  const io = makeIo({ json: true });
  await runThrough(f, io);
  assert.deepEqual(io.outLines, []);
});

test("run: a failing run still streams the error and the session end", async () => {
  const agent: FakeAgent = {
    id: "dsh",
    results: [{ exitCode: 1, finalText: "boom" }],
    calls: [],
    events: [
      { kind: "mola.error.raised", data: { kind: "crash", detail: "dsh exited 1" } },
      { kind: "mola.session.ended", data: { exitCode: 1 } },
    ],
  };
  const f = makeFakeCtx({ agents: [agent] });
  const io = makeIo({ json: true });
  const { code, sink } = await runThrough(f, io);

  assert.notEqual(code, 0);
  const kinds = eventKinds(sink.events);
  assert.ok(kinds.includes("mola.error.raised"));
  assert.ok(kinds.includes("mola.session.ended"));
});

test("run: the policy layer comes from MOLA_HOME (never the machine's real policy)", async () => {
  const f = makeFakeCtx({ agents: [streamingAgent()] });
  f.files.set(path.join(HOME, "policy.jsonc"), JSON.stringify({ routes: { byTaskKind: { implement: { route: "auto/kimi-k3" } } } }));
  const io = makeIo({ json: true });
  await runThrough(f, io);
  assert.equal((io.dataValue as any).modelRoute, "auto/kimi-k3");
});

test("run: the report names the permission profile the agent ACTUALLY applied", async () => {
  // the adapter reports the mode in effect in its own session.started
  // (ADR-0003 §5: the router must know what is really in effect)
  const agent: FakeAgent = {
    id: "dsh",
    results: [{ exitCode: 0, finalText: "ok" }],
    calls: [],
    events: [
      { kind: "mola.session.started", data: { agent: "dsh", machine: "wsl:Ubuntu", permissionMode: "workspace-write" } },
      { kind: "mola.session.ended", data: { exitCode: 0 } },
    ],
  };
  const f = makeFakeCtx({ agents: [agent] });
  const io = makeIo({ json: true });
  await runThrough(f, io);

  const data = io.dataValue as any;
  assert.equal(data.permissionProfile, "workspace-write"); // requested
  assert.equal(data.permissionProfileApplied, "workspace-write"); // applied
});

test("run: an agent with no preset reports null, the router never claims one", async () => {
  const agent: FakeAgent = {
    id: "dsh",
    results: [{ exitCode: 0, finalText: "ok" }],
    calls: [],
    events: [
      { kind: "mola.session.started", data: { agent: "dsh", machine: "wsl:Ubuntu", permissionMode: null } },
      { kind: "mola.session.ended", data: { exitCode: 0 } },
    ],
  };
  const f = makeFakeCtx({ agents: [agent] });
  const io = makeIo({ json: true });
  await runThrough(f, io);

  const data = io.dataValue as any;
  assert.equal(data.permissionProfile, "workspace-write");
  assert.equal(data.permissionProfileApplied, null);
});

test("run: an adapter that reports no permission mode leaves the applied field out", async () => {
  const f = makeFakeCtx({ agents: [streamingAgent()] });
  const io = makeIo({ json: true });
  await runThrough(f, io);
  assert.equal("permissionProfileApplied" in (io.dataValue as any), false);
});
