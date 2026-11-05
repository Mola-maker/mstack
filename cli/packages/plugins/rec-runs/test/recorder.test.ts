/**
 * RunRecorder tests: drives the recorder through the same envelope shapes the
 * core bus produces (source.runId = invocation traceId). A dispatch-shaped run
 * (cmd-dispatch's event sequence) must produce events.jsonl, decision.json and
 * a `run:<runId>` index entry without any producer edits.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { MolaEvents } from "@mola/plugin-sdk";
import { RunRecorder, RECORDER_EVENTS, runKey } from "../src/recorder.js";
import { makeRecCtx } from "./fake.js";

const WS = "/fake/ws";
const RUN = "trace-run-0001";
const runDir = path.join(WS, ".mstack", "runs", RUN);

test("recorder: dispatch-shaped run produces events.jsonl, decision.json and the index entry", () => {
  const { ctx, bus, files, kv } = makeRecCtx({ traceId: RUN });
  const rec = new RunRecorder({ state: ctx.state, fs: ctx.fs, log: ctx.log, cwd: WS });
  for (const e of RECORDER_EVENTS) ctx.events.on(e, (env) => rec.handle(env));

  bus.dispatch(MolaEvents.CommandStarted, { traceId: RUN, path: "dispatch", argv: ["tasks/t.md"] });
  bus.dispatch(MolaEvents.SessionStarted, {
    agent: "dsh",
    sessionId: RUN,
    cwd: WS,
    machine: "wsl:Ubuntu",
    modelRoute: "group/smart-split",
  });
  bus.dispatch(MolaEvents.AgentMessage, { sessionId: RUN, role: "assistant", text: "hi" });
  bus.dispatch(MolaEvents.TurnCompleted, { sessionId: RUN, turn: 1 });
  bus.dispatch(MolaEvents.TaskDone, { runId: RUN, sessionId: RUN, evidence: "logs/x.out" });
  bus.dispatch(MolaEvents.SessionEnded, { sessionId: RUN, exitCode: 0 });
  bus.dispatch(MolaEvents.CommandEnded, { traceId: RUN, path: "dispatch", exitCode: 0, durationMs: 16000 });

  const lines = files
    .get(path.join(runDir, "events.jsonl"))!
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { kind: string });
  assert.deepEqual(
    lines.map((l) => l.kind),
    [
      "mola.command.started",
      "mola.session.started",
      "mola.agent.message",
      "mola.turn.completed",
      "mola.task.done",
      "mola.session.ended",
      "mola.command.ended",
    ],
  );

  const decision = JSON.parse(files.get(path.join(runDir, "decision.json"))!) as Record<string, unknown>;
  assert.equal(decision.schemaVersion, 1);
  assert.equal(decision.runId, RUN);
  assert.equal(decision.agent, "dsh");
  assert.equal(decision.machine, "wsl:Ubuntu");
  assert.equal(decision.modelRoute, "group/smart-split");
  assert.equal(decision.workspaceDir, WS);
  assert.equal(decision.exitCode, 0);

  const entry = kv[runKey(RUN)] as Record<string, unknown>;
  assert.equal(entry.status, "ended");
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.modelRoute, "group/smart-split");
  assert.equal(entry.command, "dispatch");
  assert.equal(entry.durationMs, 16000); // from command.ended, not the ts fallback
  assert.equal(entry.runDir, runDir);
  assert.deepEqual(rec.get(RUN), kv[runKey(RUN)]);
  assert.equal(rec.entries().length, 1);
});

test("recorder: plain command (no session events) still lands in the index", () => {
  const { ctx, bus, files, kv } = makeRecCtx({ traceId: RUN });
  const rec = new RunRecorder({ state: ctx.state, fs: ctx.fs, log: ctx.log, cwd: WS });
  ctx.events.on(MolaEvents.CommandStarted, (env) => rec.handle(env));
  ctx.events.on(MolaEvents.CommandEnded, (env) => rec.handle(env));

  bus.dispatch(MolaEvents.CommandStarted, { traceId: RUN, path: "doctor", argv: [] });
  bus.dispatch(MolaEvents.CommandEnded, { traceId: RUN, path: "doctor", exitCode: 0, durationMs: 40 });

  const entry = kv[runKey(RUN)] as Record<string, unknown>;
  assert.equal(entry.command, "doctor");
  assert.equal(entry.status, "ended");
  assert.equal(files.get(path.join(runDir, "decision.json")), undefined);
  const kinds = files
    .get(path.join(runDir, "events.jsonl"))!
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { kind: string }).kind);
  assert.deepEqual(kinds, ["mola.command.started", "mola.command.ended"]);
});

test("recorder: session.ended without session.started still writes a decision (exit only)", () => {
  const { ctx, bus, files, kv } = makeRecCtx({ traceId: RUN });
  const rec = new RunRecorder({ state: ctx.state, fs: ctx.fs, log: ctx.log, cwd: WS });
  ctx.events.on(MolaEvents.SessionEnded, (env) => rec.handle(env));

  bus.dispatch(MolaEvents.SessionEnded, { sessionId: RUN, exitCode: 3 });
  const decision = JSON.parse(files.get(path.join(runDir, "decision.json"))!) as Record<string, unknown>;
  assert.equal(decision.exitCode, 3);
  assert.equal(decision.agent, undefined);
  const entry = kv[runKey(RUN)] as Record<string, unknown>;
  assert.equal(entry.exitCode, 3);
});

test("recorder: write failures are logged, never thrown (bus isolation)", () => {
  const { ctx, bus, logWarnings, kv } = makeRecCtx({ traceId: RUN, fsWriteFails: true });
  const rec = new RunRecorder({ state: ctx.state, fs: ctx.fs, log: ctx.log, cwd: WS });
  ctx.events.on(MolaEvents.SessionStarted, (env) => rec.handle(env));

  assert.doesNotThrow(() =>
    bus.dispatch(MolaEvents.SessionStarted, { agent: "dsh", cwd: WS, modelRoute: "group/smart-split" }),
  );
  assert.equal(logWarnings.length, 1);
  assert.match(logWarnings[0].msg, /could not record event/);
  assert.equal(kv[runKey(RUN)], undefined); // entry is written only after the artifacts
});

test("recorder: events without a runId are ignored", () => {
  const { ctx, bus, files } = makeRecCtx();
  const rec = new RunRecorder({ state: ctx.state, fs: ctx.fs, log: ctx.log, cwd: WS });
  rec.handle({
    id: "x",
    ts: new Date().toISOString(),
    kind: MolaEvents.AgentMessage,
    source: {},
    data: { text: "orphan" },
  });
  assert.equal(files.size, 0);
  assert.equal(rec.entries().length, 0);
});
