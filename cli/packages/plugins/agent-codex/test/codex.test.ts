/**
 * agent-codex tests (B2). All external processes (codex, magpie) are mocked
 * through the fake ExecService — no real codex run happens in tests. The one
 * real (mock-free) check is `codex --version` / `codex exec --help` on a
 * machine that has it; see the B2 batch report.
 */

import test from "node:test";
import assert from "node:assert/strict";
import plugin, {
  makeCodexAdapter,
  parseCodexStream,
  parseExecSurface,
  probeCodex,
  buildCodexArgv,
  buildCodexResumeArgv,
  sandboxOf,
} from "@mola/plugin-agent-codex";
import { makeFakeCtx } from "./fake.js";
import type { RunRequest } from "@mola/plugin-sdk";

const linuxTest = process.platform === "win32" ? test.skip : test;

// codex exec --help probe: --json + resume present (real codex ≥0.5x)
const SURFACE_FULL = [
  "Run Codex non-interactively",
  "Usage: codex exec [OPTIONS] [PROMPT]",
  "  --json                 Print events as newline-delimited JSON",
  "  -m, --model <MODEL>    Model the agent should use",
  "  -s, --sandbox <SANDBOX_MODE>",
  "  -a, --ask-for-approval <APPROVAL_POLICY>",
  "      --add-dir <DIR>",
  "      --worktree",
  "      --output-last-message <FILE>",
  "Commands:",
  "  resume  Resume a previous exec session (use --last for the most recent)",
].join("\n");
// an older codex: no --json, resume without --last
const SURFACE_MIN = [
  "Run Codex non-interactively",
  "Usage: codex exec [OPTIONS] [PROMPT]",
  "  -m, --model <MODEL>    Model the agent should use",
  "  -s, --sandbox <SANDBOX_MODE>",
  "  -a, --ask-for-approval <APPROVAL_POLICY>",
  "      --add-dir <DIR>",
  "Commands:",
  "  resume  Resume a previous exec session",
].join("\n");

const JSONL = [
  '{"type":"thread.started","thread_id":"thr-1"}',
  '{"type":"item.completed","item":{"item_type":"assistant_message","text":"3 TODOs"}}',
  '{"type":"turn.completed","usage":{"input_tokens":900,"output_tokens":80}}',
].join("\n");

function req(overrides: Partial<RunRequest> = {}): RunRequest {
  return { prompt: "count TODOs", cwd: "/fake/ws", ...overrides };
}

test("capabilities: codex is headless + listSessions; json/resume/worktree are probe-gated", () => {
  const c = makeCodexAdapter(makeFakeCtx().ctx).capabilities;
  assert.equal(c.headless, true);
  assert.equal(c.headlessJsonStream, false, "--json is not in the captured help");
  assert.equal(c.resume, false, "codex resume is interactive per the captured help");
  assert.equal(c.continueLatest, false);
  assert.equal(c.forkSession, false);
  assert.equal(c.listSessions, true);
  assert.equal(c.nativeHooks, false, "bridge = stream (DESIGN §11 conflict 4: no hook-trust bypass)");
  assert.equal(c.worktree, false);
  assert.equal(c.budgetCap, false, "no budget flag — router enforces (§2.2 gap)");
  assert.equal(c.costReadout, "magpie");
});

test("parseExecSurface: reads only what `codex exec --help` confirms", () => {
  const full = parseExecSurface(SURFACE_FULL);
  assert.equal(full.json, true);
  assert.equal(full.sandbox, true);
  assert.equal(full.model, true);
  assert.equal(full.approval, true);
  assert.equal(full.addDir, true);
  assert.equal(full.worktree, true);
  assert.equal(full.outputLastMessage, true);
  assert.equal(full.resume, true);
  assert.equal(full.resumeLast, true);

  const min = parseExecSurface(SURFACE_MIN);
  assert.equal(min.json, false);
  assert.equal(min.resume, true);
  assert.equal(min.resumeLast, false, "--last absent in this help variant");

  assert.equal(parseExecSurface("totally different CLI").json, false);
});

test("sandboxOf: read-only/plan → read-only; workspace-write default; full-auto → danger-full-access", () => {
  assert.equal(sandboxOf("read-only"), "read-only");
  assert.equal(sandboxOf("plan"), "read-only");
  assert.equal(sandboxOf("workspace-write"), "workspace-write");
  assert.equal(sandboxOf("full-auto"), "danger-full-access");
  assert.equal(sandboxOf(undefined), "workspace-write");
});

test("buildCodexArgv: exec + flags confirmed by the probe; prompt last", () => {
  const argv = buildCodexArgv("count TODOs", {
    sandbox: "workspace-write",
    json: true,
    model: "auto/gpt-6-luna",
    addDirs: ["/tmp/extra"],
    lastMessageFile: ".mstack/runs/run-1/last-message.txt",
  });
  assert.deepEqual(argv, [
    "codex",
    "exec",
    "--json",
    "-m",
    "auto/gpt-6-luna",
    "--sandbox",
    "workspace-write",
    "-a",
    "never",
    "--add-dir",
    "/tmp/extra",
    "--output-last-message",
    ".mstack/runs/run-1/last-message.txt",
    "count TODOs",
  ]);
  // without the probe confirming --json, no such flag is ever sent
  const plain = buildCodexArgv("go", { sandbox: "read-only", json: false });
  assert.ok(!plain.includes("--json"));
  assert.ok(!plain.includes("-m"));
});

test("buildCodexResumeArgv: probe-gated; --last only when confirmed", () => {
  const full = parseExecSurface(SURFACE_FULL);
  assert.deepEqual(buildCodexResumeArgv("thr-1", "continue", full), ["codex", "exec", "resume", "thr-1", "continue"]);
  assert.deepEqual(buildCodexResumeArgv("latest", "continue", full).slice(0, 4), ["codex", "exec", "resume", "--last"]);

  const min = parseExecSurface(SURFACE_MIN);
  assert.throws(() => buildCodexResumeArgv("latest", "continue", min), (err: unknown) => {
    const e = err as { code: string; capability: string };
    return e.code === "UNSUPPORTED_CAPABILITY" && e.capability === 'resume("latest")';
  });
  const none = parseExecSurface("no resume here");
  assert.throws(() => buildCodexResumeArgv("thr-1", "continue", none), /does not support resume/);
});

linuxTest("parseCodexStream: thread id, assistant items, turn usage; plain stdout falls through", () => {
  const p = parseCodexStream(JSONL);
  assert.equal(p.sessionId, "thr-1");
  assert.deepEqual(p.messages, ["3 TODOs"]);
  assert.equal(p.finalText, "3 TODOs");
  assert.deepEqual(p.usage, { inputTokens: 900, outputTokens: 80 });

  assert.equal(parseCodexStream("plain answer\n").finalText, "plain answer");
  assert.deepEqual(parseCodexStream("plain\n").messages, []);
});

linuxTest("run(): json surface — argv, events on bus + onEvent, usage from the stream", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: JSONL, stderr: "" }) });
  const adapter = makeCodexAdapter(f.ctx);
  adapter.execSurface = parseExecSurface(SURFACE_FULL);
  const tapped: string[] = [];
  const result = await adapter.run(req({ modelRoute: "auto/gpt-6-luna", runId: "run-1", onEvent: (e) => tapped.push(e.kind) }));

  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].argv, [
    "codex",
    "exec",
    "--json",
    "-m",
    "auto/gpt-6-luna",
    "--sandbox",
    "workspace-write",
    "-a",
    "never",
    "--output-last-message",
    ".mstack/runs/run-1/last-message.txt",
    "count TODOs",
  ]);
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
  const started = f.emitted[0].data as Record<string, unknown>;
  assert.equal(started.sandbox, "workspace-write");
  assert.equal(started.modelRoute, "auto/gpt-6-luna");

  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "thr-1");
  assert.equal(result.finalText, "3 TODOs");
  assert.equal(result.usage?.source, "agent");
  assert.equal(result.usage?.inputTokens, 900);
});

linuxTest("run(): without --json the plain stdout is the answer; profile drives --sandbox", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "plain answer\n", stderr: "" }) });
  const adapter = makeCodexAdapter(f.ctx);
  adapter.execSurface = parseExecSurface(SURFACE_MIN);
  const result = await adapter.run(req({ permissionProfile: "read-only" }));
  assert.ok(!(f.calls[0].argv as string[]).includes("--json"));
  assert.equal(f.calls[0].argv[(f.calls[0].argv as string[]).indexOf("--sandbox") + 1], "read-only");
  assert.equal(result.finalText, "plain answer");
  assert.equal(result.sessionId, undefined);
});

linuxTest("run(): resume through exec resume; UnsupportedCapability without the probe", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 0, stdout: JSONL, stderr: "" }) });
  const adapter = makeCodexAdapter(f.ctx);
  adapter.execSurface = parseExecSurface(SURFACE_FULL);
  const result = await adapter.resume("thr-1", req());
  assert.deepEqual(f.calls[0].argv.slice(0, 4), ["codex", "exec", "resume", "thr-1"]);
  assert.equal(result.sessionId, "thr-1");
  const started = f.emitted.filter((e) => e.event === "mola.session.started").at(-1)!.data as Record<string, unknown>;
  assert.equal(started.resumed, true);

  const bare = makeFakeCtx({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  await assert.rejects(makeCodexAdapter(bare.ctx).resume("thr-1", req()), (err: unknown) => {
    const e = err as { code: string };
    return e.code === "UNSUPPORTED_CAPABILITY";
  });
});

linuxTest("run(): non-zero exit ⇒ error.raised; 402 ⇒ quotaFailure", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 1, stdout: "", stderr: "402 insufficient quota" }) });
  const adapter = makeCodexAdapter(f.ctx);
  adapter.execSurface = parseExecSurface(SURFACE_MIN);
  const result = await adapter.run(req({ modelRoute: "auto/kimi-k3" }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.quotaFailure?.status, 402);
  const kinds = f.emitted.map((e) => e.event);
  assert.ok(kinds.includes("mola.error.raised"));
  assert.ok(!kinds.includes("mola.task.done"));
});

linuxTest("run(): spawn failure ends the session as aborted", async () => {
  const f = makeFakeCtx({
    exec: async () => {
      throw new Error("spawn failed");
    },
  });
  const adapter = makeCodexAdapter(f.ctx);
  adapter.execSurface = parseExecSurface(SURFACE_MIN);
  await assert.rejects(adapter.run(req()), /spawn failed/);
  const ended = f.emitted.filter((e) => e.event === "mola.session.ended").at(-1)!.data as Record<string, unknown>;
  assert.equal(ended.reason, "aborted");
});

linuxTest("listSessions: codex agents parsed (JSON and table shapes); failure ⇒ []", async () => {
  const json = makeFakeCtx({
    exec: async (argv) =>
      argv.includes("agents") ? { code: 0, stdout: '{"agents":[{"id":"thr-1","title":"fix bug","cwd":"/fake/ws","updated_at":"2026-11-06"}]}', stderr: "" } : { code: 0, stdout: "", stderr: "" },
  });
  const rows = await makeCodexAdapter(json.ctx).listSessions();
  assert.deepEqual(rows, [{ id: "thr-1", title: "fix bug", cwd: "/fake/ws", updatedAt: "2026-11-06" }]);
  assert.deepEqual(await makeCodexAdapter(json.ctx).listSessions({ cwd: "/other" }), []);

  const table = makeFakeCtx({
    exec: async (argv) =>
      argv.includes("agents") ? { code: 0, stdout: "fix the bug        thr-1a2b3c        2026-11-06\nanother           thr-9f8e7d", stderr: "" } : { code: 0, stdout: "", stderr: "" },
  });
  const rows2 = await makeCodexAdapter(table.ctx).listSessions();
  assert.deepEqual(rows2, [
    { id: "thr-1a2b3c", title: "fix the bug", updatedAt: "2026-11-06" },
    { id: "thr-9f8e7d", title: "another" },
  ]);

  const broken = makeFakeCtx({ exec: async (argv) => (argv.includes("agents") ? { code: 1, stdout: "", stderr: "no daemon" } : { code: 0, stdout: "", stderr: "" }) });
  assert.deepEqual(await makeCodexAdapter(broken.ctx).listSessions(), []);
});

test("usage(): magpie CSV; setModel(): magpie codex <route>", async () => {
  const csv = "agent,model,input_tokens,output_tokens,cost_usd\ncodex,kimi-code-cn/k3,10,2,0.2\n";
  const f = makeFakeCtx({
    exec: async (argv) => {
      if (argv.includes("usage")) return { code: 0, stdout: csv, stderr: "" };
      if (argv.includes("codex") && argv.includes("group/claude-cheap")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unknown route" };
    },
  });
  const adapter = makeCodexAdapter(f.ctx);
  const rows = await adapter.usage({ window: "today" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, "codex");

  await adapter.setModel("group/claude-cheap");
  const expectedModelArgv = process.platform === "win32"
    ? ["cmd", "/d", "/c", "magpie", "codex", "group/claude-cheap"]
    : ["magpie", "codex", "group/claude-cheap"];
  assert.deepEqual(f.calls.find((c) => c.argv.includes("magpie") && c.argv.includes("codex"))!.argv, expectedModelArgv);
  await assert.rejects(adapter.setModel("bogus/route"), (err: unknown) => {
    const e = err as { code: string };
    return e.code === "UNSUPPORTED_CAPABILITY";
  });
});

test("detect: ok + probe; broken on a crash", async () => {
  const f = makeFakeCtx({
    exec: async (argv) => {
      const a = argv.slice(process.platform === "win32" ? 3 : 0);
      if (a[0] === "codex" && a[1] === "--version") return { code: 0, stdout: "codex-cli 0.99.0\n", stderr: "" };
      if (a[0] === "codex" && a[1] === "exec" && a[2] === "--help") return { code: 0, stdout: SURFACE_FULL, stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  });
  const d = await probeCodex(f.ctx.process);
  assert.equal(d.available, true);
  assert.equal(d.version, "codex-cli 0.99.0");
  assert.equal(d.managedByMagpie, true);
  assert.equal(d.exec.json, true);
  assert.equal(d.exec.resume, true);

  const crashed = makeFakeCtx({ exec: async () => ({ code: 1, stdout: "", stderr: "SyntaxError: boom" }) });
  const b = await probeCodex(crashed.ctx.process);
  assert.equal(b.available, false);
  assert.equal(b.health, "broken");
  assert.equal(b.exec.json, false);
});

linuxTest("run(): an unverified exec surface fails closed — no blind headless flags", async () => {
  const f = makeFakeCtx({ exec: async () => ({ code: 1, stdout: "", stderr: "help unavailable" }) });
  await assert.rejects(makeCodexAdapter(f.ctx).run(req()), (err: unknown) => {
    const e = err as { code: string; capability: string };
    return e.code === "UNSUPPORTED_CAPABILITY" && e.capability === "headless run";
  });
  assert.equal(f.calls.length, 1); // only the probe ran, never codex exec
});

linuxTest("capabilities reflect the probed surface once detect() has pinned it", async () => {
  const f = makeFakeCtx({
    exec: async (argv) => {
      const a = argv.slice(process.platform === "win32" ? 3 : 0);
      if (a[0] === "codex" && a[1] === "--version") return { code: 0, stdout: "codex-cli 0.99.0\n", stderr: "" };
      if (a[0] === "codex" && a[1] === "exec" && a[2] === "--help") return { code: 0, stdout: SURFACE_FULL, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const adapter = makeCodexAdapter(f.ctx);
  assert.equal(adapter.capabilities.resume, false); // static: only captured-help facts
  await adapter.detect();
  assert.equal(adapter.capabilities.resume, true); // probe confirmed exec resume
  assert.equal(adapter.capabilities.headlessJsonStream, true);
  assert.equal(adapter.capabilities.continueLatest, true);
  assert.equal(adapter.capabilities.worktree, true);
});

test("resume carries the headless invariants and the modelRoute (probe-gated)", () => {
  const full = parseExecSurface(SURFACE_FULL);
  const argv = buildCodexResumeArgv("thr-1", "continue", full, {
    json: true,
    model: "auto/gpt-6-luna",
    sandbox: "workspace-write",
  });
  assert.deepEqual(argv, [
    "codex",
    "exec",
    "resume",
    "thr-1",
    "--json",
    "-m",
    "auto/gpt-6-luna",
    "--sandbox",
    "workspace-write",
    "-a",
    "never",
    "continue",
  ]);
});

test("activate: registers one runnable codex adapter; doctor checks stay with tool-magpie", () => {
  const f = makeFakeCtx();
  plugin.activate(f.ctx);
  assert.deepEqual(f.agents.map((a) => a.id), ["codex"]);
  assert.equal(typeof f.agents[0].run, "function");
  assert.deepEqual(f.checks, []);
});

test("manifest: kind agent, provides agent:codex, codex+magpie exec allow-list", async () => {
  const { readFileSync } = await import("node:fs");
  const { validateManifest } = await import("@mola/plugin-sdk");
  const manifest = JSON.parse(readFileSync(new URL("../../mola-plugin.json", import.meta.url), "utf8"));
  const v = validateManifest(manifest);
  assert.equal(v.ok, true, v.errors.join(", "));
  assert.deepEqual(manifest.provides, ["agent:codex"]);
  assert.ok(manifest.permissions["process.exec"].includes("codex"));
  assert.equal(manifest.permissions["process.exec"].includes("--dangerously-bypass-hook-trust"), false);
});
