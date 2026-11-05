/**
 * agent-claude tests (B2). All external processes (claude, magpie) are mocked
 * through the fake ExecService — no real claude run happens in tests. The one
 * real (mock-free) check is `claude --version` on a machine that has it; see
 * the B2 batch report.
 */

import test from "node:test";
import assert from "node:assert/strict";
import plugin, { makeClaudeAdapter, probeClaude, buildClaudeArgv, buildHookSettings, hookSinkScript, parseClaudeStream, permissionModeOf } from "@mola/plugin-agent-claude";
import { makeFakeCtx } from "./fake.js";
import type { RunRequest } from "@mola/plugin-sdk";

const linuxTest = process.platform === "win32" ? test.skip : test;

const STREAM = [
  '{"type":"system","subtype":"init","session_id":"sess-abc","model":"claude-sonnet-5-5","cwd":"E:\\\\mstack"}',
  '{"type":"assistant","session_id":"sess-abc","message":{"content":[{"type":"text","text":"12 TODOs found"}]}}',
  '{"type":"result","subtype":"success","session_id":"sess-abc","result":"12 TODOs found","is_error":false,"usage":{"input_tokens":1200,"output_tokens":240},"total_cost_usd":0.031}',
].join("\n");

function req(overrides: Partial<RunRequest> = {}): RunRequest {
  return { prompt: "count TODOs", cwd: "/fake/ws", ...overrides };
}

test("capabilities: claude is headless/resume/hooks/worktree/budget-cap; no native session list", () => {
  const c = makeClaudeAdapter(makeFakeCtx().ctx).capabilities;
  assert.equal(c.headless, true);
  assert.equal(c.headlessJsonStream, true);
  assert.equal(c.resume, true);
  assert.equal(c.continueLatest, true);
  assert.equal(c.forkSession, true);
  assert.equal(c.listSessions, false);
  assert.equal(c.nativeHooks, true);
  assert.equal(c.backgroundSessions, true);
  assert.equal(c.worktree, true);
  assert.equal(c.budgetCap, true);
  assert.equal(c.costReadout, "magpie");
});

test("permissionModeOf: the §2.1 mapping — plan for read-only, acceptEdits default, bypass only for full-auto", () => {
  assert.equal(permissionModeOf("plan"), "plan");
  assert.equal(permissionModeOf("read-only"), "plan");
  assert.equal(permissionModeOf("workspace-write"), "acceptEdits");
  assert.equal(permissionModeOf("full-auto"), "bypassPermissions");
  assert.equal(permissionModeOf(undefined), "acceptEdits");
});

test("buildClaudeArgv: headless stream argv from claude-help.txt flags only", () => {
  const argv = buildClaudeArgv("count TODOs", {
    permissionMode: "acceptEdits",
    model: "group/claude-cheap",
    budgetUsd: 1.5,
    addDirs: ["/tmp/extra"],
    resumeId: "sess-abc",
    fork: true,
    settingsJson: '{"hooks":{}}',
  });
  assert.deepEqual(argv, [
    "claude",
    "-p",
    "count TODOs",
    "--output-format",
    "stream-json",
    "--include-hook-events",
    "--permission-mode",
    "acceptEdits",
    "--model",
    "group/claude-cheap",
    "--max-budget-usd",
    "1.5",
    "--add-dir",
    "/tmp/extra",
    "--resume",
    "sess-abc",
    "--fork-session",
    "--settings",
    '{"hooks":{}}',
  ]);
  // continue-latest uses -c and never combines with --resume
  const cont = buildClaudeArgv("go", { permissionMode: "plan", continueLatest: true });
  assert.ok(cont.includes("-c"));
  assert.ok(!cont.includes("--resume"));
});

test("buildHookSettings + hookSinkScript: per-run settings with a file sink, no config mutation", () => {
  const settings = buildHookSettings("run-9") as { hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> };
  for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
    assert.deepEqual(settings.hooks[event], [{ hooks: [{ type: "command", command: "node .mstack/runs/run-9/hook-sink.cjs" }] }]);
  }
  const script = hookSinkScript();
  assert.match(script, /hooks\.jsonl/);
  assert.match(script, /hook_event_name/);
  assert.ok(!/http|fetch\(/.test(script), "the B2 sink is a file, not the (later) ingest endpoint");
});

linuxTest("parseClaudeStream: session id, assistant messages, result usage + cost", () => {
  const p = parseClaudeStream(STREAM);
  assert.equal(p.sessionId, "sess-abc");
  assert.deepEqual(p.messages, ["12 TODOs found"]);
  assert.equal(p.finalText, "12 TODOs found");
  assert.equal(p.usage?.inputTokens, 1200);
  assert.equal(p.usage?.outputTokens, 240);
  assert.equal(p.usage?.costUsd, 0.031);
  assert.equal(p.isError, false);
  // garbage lines never throw
  assert.deepEqual(parseClaudeStream("not json\n").messages, []);
});

linuxTest("run(): argv, hook-sink file, and the ADR-0004 events on bus + onEvent", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: STREAM, stderr: "" }) });
  const adapter = makeClaudeAdapter(f.ctx);
  const tapped: string[] = [];
  const result = await adapter.run(
    req({ modelRoute: "group/claude-cheap", budgetUsd: 2, runId: "run-1", onEvent: (e) => tapped.push(e.kind) }),
  );

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].argv[0], "claude");
  assert.deepEqual(f.calls[0].argv.slice(0, 8), [
    "claude",
    "-p",
    "count TODOs",
    "--output-format",
    "stream-json",
    "--include-hook-events",
    "--permission-mode",
    "acceptEdits",
  ]);
  const argv = f.calls[0].argv as string[];
  assert.ok(argv.includes("--model") && argv[argv.indexOf("--model") + 1] === "group/claude-cheap");
  assert.ok(argv.includes("--max-budget-usd") && argv[argv.indexOf("--max-budget-usd") + 1] === "2");
  const settingsIdx = argv.indexOf("--settings");
  assert.ok(settingsIdx > 0, "--settings injected per run");
  const settings = JSON.parse(argv[settingsIdx + 1]) as ReturnType<typeof buildHookSettings>;
  assert.deepEqual(settings, buildHookSettings("run-1"));
  // the sink file exists AND the injected command points at exactly that path
  const sinkFile = "/fake/ws/.mstack/runs/run-1/hook-sink.cjs";
  assert.match(f.files.get(sinkFile)!, /hooks\.jsonl/);
  const command = (settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).SessionStart[0].hooks[0].command;
  assert.equal(command, "node .mstack/runs/run-1/hook-sink.cjs");
  assert.equal(f.files.get("/fake/ws/" + command.replace("node ", "")), f.files.get(sinkFile));
  assert.equal(f.calls[0].opts.cwd, "/fake/ws");

  const kinds = f.emitted.map((e) => e.event);
  assert.deepEqual(kinds, [
    "mola.session.started",
    "mola.agent.message",
    "mola.turn.completed",
    "mola.task.done",
    "mola.session.ended",
  ]);
  assert.deepEqual(tapped, kinds);
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "sess-abc");
  assert.equal(result.finalText, "12 TODOs found");
  assert.equal(result.usage?.source, "agent");
  assert.equal(result.usage?.costUsd, 0.031);
});

linuxTest("run(): nativeHooks off ⇒ no --settings, no sink file", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: STREAM, stderr: "" }) });
  const { runClaude } = await import("@mola/plugin-agent-claude");
  await runClaude({ exec: f.ctx.process, events: f.ctx.events, fs: f.ctx.fs, nativeHooks: false }, req({ runId: "run-2" }));
  assert.ok(!(f.calls[0].argv as string[]).includes("--settings"));
  assert.ok(![...f.files.keys()].some((k) => k.includes("hook-sink.cjs")));
});

linuxTest("run(): fresh session by default; resume('latest') uses -c; resume(id) uses --resume", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: STREAM, stderr: "" }) });
  const adapter = makeClaudeAdapter(f.ctx);
  await adapter.run(req());
  assert.ok(!(f.calls[0].argv as string[]).includes("--resume"));
  assert.ok(!(f.calls[0].argv as string[]).includes("-c"));

  await adapter.resume("latest", req());
  assert.ok((f.calls[1].argv as string[]).includes("-c"));
  assert.ok(!(f.calls[1].argv as string[]).includes("--fork-session"));

  await adapter.resume("sess-abc", req({ fork: true }));
  const argv = f.calls[2].argv as string[];
  assert.equal(argv[argv.indexOf("--resume") + 1], "sess-abc");
  assert.ok(argv.includes("--fork-session"));
  const started = f.emitted.filter((e) => e.event === "mola.session.started").at(-1)!.data as Record<string, unknown>;
  assert.equal(started.resumed, true);
});

linuxTest("run(): non-zero exit and result.is_error ⇒ error.raised, no task.done", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 1, stdout: STREAM.replace('"is_error":false', '"is_error":true'), stderr: "" }) });
  const adapter = makeClaudeAdapter(f.ctx);
  const result = await adapter.run(req());
  assert.equal(result.exitCode, 1);
  const kinds = f.emitted.map((e) => e.event);
  assert.ok(kinds.includes("mola.error.raised"));
  assert.ok(!kinds.includes("mola.task.done"));
  assert.equal(kinds.at(-1), "mola.session.ended");
});

linuxTest("run(): quota-shaped failure normalizes (ADR-0003 §4)", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 1, stdout: "", stderr: "429 rate limit exceeded" }) });
  const result = await makeClaudeAdapter(f.ctx).run(req());
  assert.equal(result.quotaFailure?.status, 429);
  const errData = f.emitted.find((e) => e.event === "mola.error.raised")!.data as Record<string, unknown>;
  assert.equal(errData.kind, "quota");
});

test("usage(): magpie usage CSV parsed by column name; magpie down ⇒ []", async () => {
  const csv = "agent,model,input_tokens,output_tokens,cost_usd\nclaude,auto/claude-sonnet-5-5,10,2,0.5\n";
  const f = makeFakeCtx({ exec: async (argv) => (argv.includes("--csv") ? { code: 0, stdout: csv, stderr: "" } : { code: 0, stdout: "", stderr: "" }) });
  const rows = await makeClaudeAdapter(f.ctx).usage({ window: "7d" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "magpie");
  assert.equal(rows[0].costUsd, 0.5);
  assert.ok((f.calls[0].argv as string[]).includes("7d"));

  const down = makeFakeCtx({ exec: async () => ({ code: 69, stdout: "", stderr: "gateway down" }) });
  assert.deepEqual(await makeClaudeAdapter(down.ctx).usage(), []);
});

test("setModel(): ALWAYS magpie claude <route> — never a config edit", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  await makeClaudeAdapter(f.ctx).setModel("group/claude-cheap");
  assert.deepEqual(f.calls[0].argv.slice(-3), ["magpie", "claude", "group/claude-cheap"]);

  const failing = makeFakeCtx({ exec: async () => ({ code: 1, stdout: "", stderr: "unknown route" }) });
  await assert.rejects(makeClaudeAdapter(failing.ctx).setModel("nope"), (err: unknown) => {
    const e = err as { code: string };
    return e.code === "UNSUPPORTED_CAPABILITY";
  });
});

test("listSessions: UnsupportedCapability (background-only; historical via magpie sessions)", async () => {
  const adapter = makeClaudeAdapter(makeFakeCtx().ctx);
  await assert.rejects(adapter.listSessions?.(), (err: unknown) => {
    const e = err as { code: string; capability: string };
    return e.code === "UNSUPPORTED_CAPABILITY" && e.capability === "listSessions";
  });
});

linuxTest("detect: ok parses the version; broken parses the crash line", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "2.1.0 (Claude Code)\n", stderr: "" }) });
  const d = await probeClaude(f.ctx.process);
  assert.equal(d.available, true);
  assert.equal(d.version, "2.1.0 (Claude Code)");
  assert.equal(d.managedByMagpie, true);

  const crashed = makeFakeCtx({ exec: async () => ({ code: 1, stdout: "1 | ~", stderr: "SyntaxError:Unexpected token" }) });
  const b = await probeClaude(crashed.ctx.process);
  assert.equal(b.available, false);
  assert.equal(b.health, "broken");
  assert.match(b.detail!, /SyntaxError/);
});

test("activate: registers one runnable claude adapter; doctor checks stay with tool-magpie", () => {
  const f = makeFakeCtx();
  plugin.activate(f.ctx);
  assert.deepEqual(f.agents.map((a) => a.id), ["claude"]);
  assert.equal(typeof f.agents[0].run, "function");
  assert.deepEqual(f.checks, []); // agent.claude probe belongs to tool-magpie
});

test("manifest: kind agent, provides agent:claude, claude+magpie exec allow-list", async () => {
  const { readFileSync } = await import("node:fs");
  const { validateManifest } = await import("@mola/plugin-sdk");
  const manifest = JSON.parse(readFileSync(new URL("../../mola-plugin.json", import.meta.url), "utf8"));
  const v = validateManifest(manifest);
  assert.equal(v.ok, true, v.errors.join(", "));
  assert.deepEqual(manifest.provides, ["agent:claude"]);
  assert.ok(manifest.permissions["process.exec"].includes("claude"));
  assert.ok(manifest.hooks.emit.includes("mola.session.ended"));
});
