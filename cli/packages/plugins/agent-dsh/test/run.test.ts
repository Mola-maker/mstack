/**
 * agent-dsh run-surface tests (B2). Everything external is mocked: the fake
 * ExecService returns scripted dsh `--json` streams, no WSL is touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/index.js";
import { DSH_CAPABILITIES, makeDshAdapter } from "../src/index.js";
import { dshOverlayYaml, dshRunArgv, dshRunScript, parseDshStream } from "../src/run.js";
import { makeFakeCtx } from "./fake.js";
import type { RunRequest } from "@mola/plugin-sdk";

// POSIX fixture paths (/fake/...): run on Linux (WSL, CI); skipped on a Windows host.
const linuxTest = process.platform === "win32" ? test.skip : test;

const NDJSON = [
  '{"session_id":"sess-1","type":"session/created"}',
  '{"type":"agent/message","text":"counted 12 TODOs"}',
  '{"type":"turn/end","usage":{"input_tokens":100,"output_tokens":20}}',
  '{"result":"counted 12 TODOs"}',
].join("\n");

function req(overrides: Partial<RunRequest> = {}): RunRequest {
  return { prompt: "count TODOs", cwd: "/fake/ws", ...overrides };
}

linuxTest("capabilities: dsh is headless+json-stream+resume, not continue-latest/worktree/budget", () => {
  assert.equal(DSH_CAPABILITIES.headless, true);
  assert.equal(DSH_CAPABILITIES.headlessJsonStream, true);
  assert.equal(DSH_CAPABILITIES.resume, true);
  assert.equal(DSH_CAPABILITIES.continueLatest, false);
  assert.equal(DSH_CAPABILITIES.forkSession, false);
  assert.equal(DSH_CAPABILITIES.listSessions, false);
  assert.equal(DSH_CAPABILITIES.worktree, false);
  assert.equal(DSH_CAPABILITIES.budgetCap, false);
  assert.equal(DSH_CAPABILITIES.costReadout, "magpie");
});

linuxTest("dshRunScript: profile, patch overlay, --json, no prompt in the script (stdin)", () => {
  const script = dshRunScript({
    cwdPosix: "/mnt/e/mstack",
    overlayPath: ".mstack/runs/run-1/model-overlay.yml",
    sessionId: "sess-9",
    permissionMode: "workspace-write",
  });
  assert.match(script, /dsh --profile mola-cli/);
  assert.match(script, /--patch '\.mstack\/runs\/run-1\/model-overlay\.yml'/);
  assert.match(script, /--json/);
  assert.match(script, /--session-id 'sess-9'/);
  assert.match(script, /--permission-mode 'workspace-write'/);
  assert.doesNotMatch(script, /count TODOs/);
  // a prompt containing quotes must never reach the script (stdin instead)
  const quoted = dshRunScript({ cwdPosix: "/mnt/e/mstack" });
  assert.match(quoted, /cd '\/mnt\/e\/mstack'/);
  // argv: direct bash inside Linux/WSL, wsl -e bash -lc on Windows
  assert.deepEqual(dshRunArgv("echo hi", false), ["bash", "-lc", "echo hi"]);
  assert.deepEqual(dshRunArgv("echo hi", true), ["wsl", "-e", "bash", "-lc", "echo hi"]);
});

linuxTest("dshOverlayYaml: the magpie model overlay shape", () => {
  assert.equal(dshOverlayYaml("group/smart-split"), "- id: agent-default-model\n  config:\n    provider: magpie\n    model: group/smart-split\n");
});

linuxTest("parseDshStream: session id, final text, usage from the NDJSON; plain stdout falls through", () => {
  const p = parseDshStream(NDJSON);
  assert.equal(p.sessionId, "sess-1");
  assert.equal(p.finalText, "counted 12 TODOs");
  assert.deepEqual(p.usage, { inputTokens: 100, outputTokens: 20 });

  const plain = parseDshStream("just the answer\n");
  assert.equal(plain.finalText, "just the answer");
});

linuxTest("parseDshStream: the real mola-cli --json shape (session/status turn_end/final)", () => {
  const real = [
    '{"type":"session","sessionId":"session-552d1f49","cwd":"/mnt/e/mstack"}',
    '{"type":"status","phase":"turn_start","turn":1}',
    '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"MISSING_CREDENTIAL: no credential for provider route magpie"}}}',
    '{"type":"final","text":""}',
  ].join("\n");
  const p = parseDshStream(real);
  assert.equal(p.sessionId, "session-552d1f49");
  assert.equal(p.errorDetail, "MISSING_CREDENTIAL: no credential for provider route magpie");
  // the happy variant carries the answer on the final event
  const ok = parseDshStream('{"type":"session","sessionId":"s1"}\n{"type":"final","text":"42"}');
  assert.equal(ok.finalText, "42");
  assert.ok(ok.errorDetail === undefined);
});

linuxTest("run(): argv + overlay + the four ADR-0004 events on the bus and onEvent", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: NDJSON, stderr: "" }) });
  const adapter = makeDshAdapter(f.ctx);
  const tapped: string[] = [];
  const result = await adapter.run(req({ modelRoute: "group/smart-split", runId: "run-1", onEvent: (e) => tapped.push(e.kind) }));

  // one exec, login-shell argv, prompt on stdin, env mapping
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].argv, ["bash", "-lc", dshRunScript({
    cwdPosix: "/fake/ws",
    overlayPath: ".mstack/runs/run-1/model-overlay.yml",
  })]);
  assert.equal(f.calls[0].opts.input, "count TODOs");
  assert.equal(f.calls[0].opts.cwd, "/fake/ws");
  // the overlay was written under the run dir
  assert.match(f.files.get("/fake/ws/.mstack/runs/run-1/model-overlay.yml")!, /model: group\/smart-split/);

  // ADR-0004 vocabulary, in order
  const kinds = f.emitted.map((e) => e.event);
  assert.deepEqual(kinds, [
    "mola.session.started",
    "mola.agent.message",
    "mola.turn.completed",
    "mola.task.done",
    "mola.session.ended",
  ]);
  assert.deepEqual(tapped, kinds, "onEvent receives the same envelopes as the bus");
  const started = f.emitted[0].data as Record<string, unknown>;
  assert.equal(started.cwd, "/fake/ws");
  assert.equal(started.modelRoute, "group/smart-split");
  assert.equal(started.argv, f.calls[0].argv);

  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "sess-1");
  assert.equal(result.finalText, "counted 12 TODOs");
  assert.equal(result.usage?.source, "agent"); // token counts come from the agent's own stream; cost stays with magpie
  assert.equal(result.usage?.inputTokens, 100);
  assert.equal(result.events?.length, kinds.length);
});

linuxTest("run(): no modelRoute ⇒ no overlay, no --patch; no fake JSON ⇒ plain finalText", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "42\n", stderr: "" }) });
  const adapter = makeDshAdapter(f.ctx);
  const result = await adapter.run(req({ runId: "run-2" }));
  assert.doesNotMatch(f.calls[0].argv[4] ?? f.calls[0].argv[f.calls[0].argv.length - 1], /--patch/);
  assert.equal(result.finalText, "42");
  assert.equal(result.sessionId, undefined);
});

linuxTest("run(): non-zero exit ⇒ error.raised, still ends the session, exit code passes through", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 3, stdout: "", stderr: "boom" }) });
  const adapter = makeDshAdapter(f.ctx);
  const result = await adapter.run(req());
  assert.equal(result.exitCode, 3);
  const kinds = f.emitted.map((e) => e.event);
  assert.ok(kinds.includes("mola.error.raised"));
  assert.equal(kinds[kinds.length - 1], "mola.session.ended");
  assert.ok(!kinds.includes("mola.task.done"));
  const errData = f.emitted.find((e) => e.event === "mola.error.raised")!.data as Record<string, unknown>;
  assert.equal(errData.kind, "crash");
});

linuxTest("run(): 402/rate-limit stderr ⇒ normalized QuotaFailure (ADR-0003 §4)", async () => {
  const f = makeFakeCtx({
    exec: async () => ({ code: 1, stdout: "", stderr: "magpie route group/smart-split: 402 payment required" }),
  });
  const adapter = makeDshAdapter(f.ctx);
  const result = await adapter.run(req({ modelRoute: "group/smart-split" }));
  assert.equal(result.quotaFailure?.status, 402);
  assert.equal(result.quotaFailure?.route, "group/smart-split");
  const errData = f.emitted.find((e) => e.event === "mola.error.raised")!.data as Record<string, unknown>;
  assert.equal(errData.kind, "quota");
});

linuxTest("run(): spawn failure ⇒ error.raised + session.ended(aborted), then rethrows", async () => {
  const f = makeFakeCtx({
    exec: async () => {
      throw new Error("spawn failed");
    },
  });
  const adapter = makeDshAdapter(f.ctx);
  await assert.rejects(adapter.run(req()), /spawn failed/);
  const kinds = f.emitted.map((e) => e.event);
  assert.ok(kinds.includes("mola.error.raised"));
  const ended = f.emitted.find((e) => e.event === "mola.session.ended")!.data as Record<string, unknown>;
  assert.equal(ended.reason, "aborted");
});

linuxTest("resume(sessionId): same run path with --session-id; resume('latest') is unsupported", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: NDJSON, stderr: "" }) });
  const adapter = makeDshAdapter(f.ctx);
  const result = await adapter.resume("sess-1", req({ runId: "run-3" }));
  assert.match(f.calls[0].argv[f.calls[0].argv.length - 1], /--session-id 'sess-1'/);
  assert.equal(result.sessionId, "sess-1");
  const started = f.emitted[0].data as Record<string, unknown>;
  assert.equal(started.resumed, true);

  await assert.rejects(adapter.resume("latest", req()), (err: unknown) => {
    const e = err as { code: string; capability?: string };
    return e.code === "UNSUPPORTED_CAPABILITY" && e.capability === 'resume("latest")';
  });
});

linuxTest("run(): addDirs ride --add-dir, Windows paths mapped into WSL; the effective permission mode is reported", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "ok", stderr: "" }) });
  const adapter = makeDshAdapter(f.ctx);
  await adapter.run(req({ addDirs: ["/tmp/extra"], runId: "run-4" }));
  assert.match(f.calls[0].argv[f.calls[0].argv.length - 1], /--add-dir '\/tmp\/extra'/);
  const started = f.emitted[0].data as Record<string, unknown>;
  assert.equal(started.permissionMode, null); // read-only/plan/full-auto have no captured preset

  const g = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "ok", stderr: "" }) });
  process.env.MOLA_PLATFORM = "win32";
  try {
    await makeDshAdapter(g.ctx).run({ prompt: "x", cwd: "E:\\repo", addDirs: ["E:\\repo\\.git"] });
  } finally {
    delete process.env.MOLA_PLATFORM;
  }
  assert.match(g.calls[0].argv[g.calls[0].argv.length - 1], /--add-dir '\/mnt\/e\/repo\/.git'/);
});

linuxTest("run(): permissionProfile workspace-write maps to the captured preset; others are omitted", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "ok", stderr: "" }) });
  const adapter = makeDshAdapter(f.ctx);
  await adapter.run(req({ permissionProfile: "workspace-write" }));
  assert.match(f.calls[0].argv[f.calls[0].argv.length - 1], /--permission-mode 'workspace-write'/);

  const g = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "ok", stderr: "" }) });
  await makeDshAdapter(g.ctx).run(req({ permissionProfile: "full-auto" }));
  assert.doesNotMatch(g.calls[0].argv[g.calls[0].argv.length - 1], /--permission-mode/);
});

linuxTest("activate: still registers the adapter and the agent.dsh doctor check", () => {
  const f = makeFakeCtx();
  plugin.activate(f.ctx);
  assert.deepEqual(f.agents.map((a) => a.id), ["dsh"]);
  assert.ok(f.checks.some((c) => c.id === "agent.dsh"));
});
