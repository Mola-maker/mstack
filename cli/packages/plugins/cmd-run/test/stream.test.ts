/**
 * Tests for the NDJSON run-event stream (core §8.2: `run` is a streaming
 * command — stdout carries one envelope, the run's events go to stderr as
 * NDJSON). No process is spawned; the sink writes into a collector.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  RUN_STREAM_EVENTS,
  eventKinds,
  makeEnvelope,
  ndjsonSink,
  recordingSink,
} from "../src/stream.js";

test("stream: the sink writes one JSON envelope per line", () => {
  const lines: string[] = [];
  const sink = ndjsonSink({ write: (l) => lines.push(l) });
  sink(
    makeEnvelope({
      kind: "mola.session.started",
      agent: "dsh",
      machine: "wsl:Ubuntu",
      runId: "run-1",
      data: { agent: "dsh", machine: "wsl:Ubuntu", modelRoute: "group/smart-split" },
    }),
  );

  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith("\n"));
  const env = JSON.parse(lines[0]);
  assert.equal(env.kind, "mola.session.started");
  assert.equal(env.source.agent, "dsh");
  assert.equal(env.source.machine, "wsl:Ubuntu");
  assert.equal(env.source.runId, "run-1");
  assert.equal(env.data.modelRoute, "group/smart-split");
  // the envelope has the ADR-0004 §1 shape
  assert.equal(typeof env.id, "string");
  assert.equal(typeof env.ts, "string");
});

test("stream: the envelope carries the session id only when there is one", () => {
  const env = makeEnvelope({
    kind: "mola.session.ended",
    agent: "dsh",
    machine: "local",
    runId: "run-2",
    data: { exitCode: 0 },
  });
  assert.equal(env.source.sessionId, undefined);

  const withSession = makeEnvelope({
    kind: "mola.session.ended",
    agent: "dsh",
    machine: "local",
    runId: "run-2",
    sessionId: "sess-9",
    data: { exitCode: 0 },
  });
  assert.equal(withSession.source.sessionId, "sess-9");
});

test("stream: an unserializable envelope is skipped, not fatal", () => {
  const lines: string[] = [];
  const errors: unknown[] = [];
  const sink = ndjsonSink({ write: (l) => lines.push(l), onError: (e) => errors.push(e) });
  const bad = {
    id: "x",
    ts: "2026-01-01T00:00:00.000Z",
    kind: "mola.task.done",
    source: {},
    data: {},
    get boom(): never {
      throw new Error("nope");
    },
  } as never;
  sink(bad);
  assert.equal(lines.length, 0);
  assert.equal(errors.length, 1);
});

test("stream: the recording sink keeps the envelopes in order", () => {
  const sink = recordingSink();
  sink(makeEnvelope({ kind: "mola.session.started", agent: "dsh", machine: "local", runId: "r", data: {} }));
  sink(makeEnvelope({ kind: "mola.task.done", agent: "dsh", machine: "local", runId: "r", data: {} }));
  sink(makeEnvelope({ kind: "mola.task.done", agent: "dsh", machine: "local", runId: "r", data: {} }));

  assert.deepEqual(eventKinds(sink.events), ["mola.session.started", "mola.task.done"]);
  assert.equal(sink.events.length, 3);
});

test("stream: the recording sink is bounded", () => {
  const sink = recordingSink(2);
  for (let i = 0; i < 5; i++) {
    sink(makeEnvelope({ kind: "mola.agent.message", agent: "dsh", machine: "local", runId: "r", data: { i } }));
  }
  assert.equal(sink.events.length, 2);
  assert.equal((sink.events[1].data as { i: number }).i, 4);
});

test("stream: the run vocabulary is the ADR-0004 §1 set", () => {
  assert.deepEqual(RUN_STREAM_EVENTS, [
    "mola.session.started",
    "mola.agent.message",
    "mola.agent.idle",
    "mola.turn.completed",
    "mola.task.done",
    "mola.error.raised",
    "mola.session.ended",
  ]);
});
