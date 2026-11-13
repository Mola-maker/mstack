import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { decideApproval, listProgress, readApproval, readProgress, runDir } from "@mola/plugin-sdk";
import { familyOf, loadRoutingFile } from "@mola/plugin-cmd-run";
import plugin from "../src/index.js";
import { resumeRun, startRun } from "../src/engine.js";
import { cmdDecide, cmdStop } from "../src/manage.js";
import { fakeAgent, makeCtx, makeEnv, makeIo, ok, tempCwd, until, type FakeAgent } from "./helpers.js";

const INTENT = "fix the login bug in src/auth.ts so tokens refresh";
const opts = (over: Record<string, unknown> = {}) => ({ intent: INTENT, auto: true, dryRun: false, ...over }) as Parameters<typeof startRun>[1];

test("happy path: stages in order, progress + artifacts + events written", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent("claude", (s) => ok(s, { usage: { source: "agent", costUsd: 0.1 } }));
  const f = makeCtx([agent]);
  const { code, progress: p } = await startRun(makeEnv(f, cwd), opts());

  assert.equal(code, 0);
  assert.deepEqual(agent.stages, ["plan", "implement", "verify", "review"]);
  assert.match(p.id, /^go-\d{8}-\d{4}-[0-9a-f]{4}$/);
  assert.equal(p.status, "done");
  assert.equal(p.origin, "cli");
  assert.equal(p.costUsd, 0.4);
  const disk = readProgress(cwd, p.id)!;
  assert.deepEqual(disk.stages.map((s) => s.status), ["skipped", "done", "done", "done", "done", "skipped"]);
  const plan = disk.stages.find((s) => s.name === "plan")!;
  assert.equal(plan.agent, "claude");
  assert.equal(plan.model, "auto/claude-opus-5-5");
  assert.equal(plan.summary, "plan ok");
  assert.equal(plan.artifact, "plan.md");
  assert.ok(plan.startedAt && plan.endedAt);
  assert.equal(disk.workers.length, 4);
  assert.ok(disk.workers.every((w) => w.status === "done"));
  assert.match(fs.readFileSync(path.join(runDir(cwd, p.id), "intent.md"), "utf8"), /login bug/);
  assert.match(fs.readFileSync(path.join(runDir(cwd, p.id), "plan.md"), "utf8"), /plan output/);
  // the agent's run id is the go run id, so adapters record into the same dir
  assert.ok(agent.calls.every((c) => c.runId === p.id));

  const kinds = f.emitted.map((e) => e.event);
  assert.equal(kinds[0], "mola.go.started");
  assert.equal(kinds.at(-1), "mola.go.done");
  assert.equal(kinds.filter((k) => k === "mola.go.stage").length, 8);
  assert.deepEqual(f.emitted.at(-1)!.data, { runId: p.id, stage: "review", status: "done" });
});

test("prompts carry the previous artifacts and are family-adapted", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent();
  await startRun(makeEnv(makeCtx([agent]), cwd), opts());
  const impl = agent.calls[agent.stages.indexOf("implement")];
  assert.match(impl.prompt, /<task>/); // claude family → xml wrapper
  assert.match(impl.prompt, /plan\.md/);
  assert.match(impl.prompt, /STATUS: done\|failed\|blocked/);
});

test("a missing STATUS line counts as failed", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent("claude", (s) => (s === "plan" ? { exitCode: 0, finalText: "I planned it" } : ok(s)));
  const { code, progress: p } = await startRun(makeEnv(makeCtx([agent]), cwd), opts());
  assert.equal(code, 1);
  assert.equal(p.status, "failed");
  assert.equal(p.stages.find((s) => s.name === "plan")!.status, "failed");
  assert.deepEqual(agent.stages, ["plan"]);
});

test("verify retry loop: fail → implement again with verify.md → pass", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent("claude", (s, n) => (s === "verify" && n < 3 ? { exitCode: 0, finalText: "STATUS: failed 2 tests red" } : ok(s)));
  const { code, progress: p } = await startRun(makeEnv(makeCtx([agent]), cwd), opts());
  assert.equal(code, 0);
  assert.deepEqual(agent.stages, ["plan", "implement", "verify", "implement", "verify", "implement", "verify", "review"]);
  const retryPrompt = agent.calls[3].prompt;
  assert.match(retryPrompt, /verify\.md/);
  assert.match(retryPrompt, /Verification failed/);
  assert.ok(!/Verification failed/.test(agent.calls[1].prompt));
  assert.equal(p.status, "done");
  assert.equal(p.workers.length, 8);
});

test("three strikes: blocked with reason 'verify failed 3 times'", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent("claude", (s) => (s === "verify" ? { exitCode: 0, finalText: "STATUS: failed still red" } : ok(s)));
  const f = makeCtx([agent]);
  const { code, progress: p } = await startRun(makeEnv(f, cwd), opts());
  assert.equal(code, 1);
  assert.equal(p.status, "blocked");
  assert.equal(p.blocked?.reason, "verify failed 3 times");
  assert.equal(agent.stages.filter((s) => s === "verify").length, 3);
  assert.equal(agent.stages.filter((s) => s === "implement").length, 3);
  assert.ok(!agent.stages.includes("review"));
  assert.equal(readProgress(cwd, p.id)!.status, "blocked");
  assert.ok(f.emitted.some((e) => e.event === "mola.go.blocked"));
});

test("approval gate: implement waits for the plan approval, approve continues", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent();
  const f = makeCtx([agent]);
  const done = startRun(makeEnv(f, cwd), opts({ auto: false }));

  await until(() => listProgress(cwd)[0]?.status === "blocked");
  const p = listProgress(cwd)[0];
  assert.equal(p.stage, "implement");
  assert.equal(p.blocked?.approvalId, "implement-1");
  assert.match(p.blocked!.reason, /approval needed/);
  assert.match(p.next!, /mola go approve/);
  const a = readApproval(cwd, p.id, "implement-1")!;
  assert.equal(a.status, "pending");
  assert.match(a.action, /start implementing/);
  assert.deepEqual(agent.stages, ["plan"]); // implement has not started
  assert.equal(f.notified.length, 1);
  assert.match(f.notified[0].title, /needs approval/);

  const io = makeIo(cwd);
  assert.equal(cmdDecide(io, true, p.id), 0); // default: the run's pending approval
  const res = await done;
  assert.equal(res.code, 0);
  assert.equal(readApproval(cwd, p.id, "implement-1")!.decidedBy, "cli");
  assert.deepEqual(agent.stages, ["plan", "implement", "verify", "review"]);
  assert.equal(res.progress.blocked, undefined);
});

test("approval gate: deny stops the run before implement", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent();
  const done = startRun(makeEnv(makeCtx([agent]), cwd), opts({ auto: false }));
  await until(() => listProgress(cwd)[0]?.status === "blocked");
  const id = listProgress(cwd)[0].id;
  assert.equal(cmdDecide(makeIo(cwd), false, id), 0);
  const res = await done;
  assert.equal(res.progress.status, "stopped");
  assert.deepEqual(agent.stages, ["plan"]);
  assert.equal(readApproval(cwd, id, "implement-1")!.status, "denied");
});

test("--auto skips the plan gate, but ship always needs approval", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent();
  const done = startRun(makeEnv(makeCtx([agent]), cwd), opts({ until: "ship" }));
  await until(() => listProgress(cwd)[0]?.status === "blocked");
  const p = listProgress(cwd)[0];
  assert.equal(p.stage, "ship");
  assert.equal(p.blocked?.approvalId, "ship-1");
  assert.match(readApproval(cwd, p.id, "ship-1")!.action, /push the branch and open a PR/);
  assert.deepEqual(agent.stages, ["plan", "implement", "verify", "review"]);
  assert.ok(decideApproval(cwd, p.id, "ship-1", true, "cli"));
  const res = await done;
  assert.equal(res.code, 0);
  assert.deepEqual(agent.stages.at(-1), "ship");
});

test("stop while waiting for approval", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent();
  const done = startRun(makeEnv(makeCtx([agent]), cwd), opts({ auto: false }));
  await until(() => listProgress(cwd)[0]?.status === "blocked");
  const id = listProgress(cwd)[0].id;
  assert.equal(cmdStop(makeIo(cwd), id), 0);
  assert.ok(fs.existsSync(path.join(runDir(cwd, id), "STOP")));
  const res = await done;
  assert.equal(res.progress.status, "stopped");
  assert.deepEqual(agent.stages, ["plan"]);
});

test("stop while an agent is running: run stopped, stage and worker failed", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent("claude", (s) => (s === "implement" ? new Promise<never>(() => {}) : ok(s)));
  const done = startRun(makeEnv(makeCtx([agent]), cwd), opts());
  await until(() => listProgress(cwd)[0]?.stages.find((s) => s.name === "implement")?.status === "running");
  const id = listProgress(cwd)[0].id;
  cmdStop(makeIo(cwd), id);
  const res = await done;
  assert.equal(res.progress.status, "stopped");
  const impl = res.progress.stages.find((s) => s.name === "implement")!;
  assert.equal(impl.status, "failed");
  assert.equal(impl.summary, "stopped by the user");
  assert.equal(res.progress.workers.find((w) => w.stage === "implement")!.status, "failed");
  assert.ok(!agent.stages.includes("verify"));
});

test("stop on a finished run is a no-op", () => {
  const cwd = tempCwd();
  const io = makeIo(cwd);
  assert.throws(() => cmdStop(io, "nope"), /no such run/);
});

test("resume continues from the first stage that is not done/skipped", async () => {
  const cwd = tempCwd();
  let failImplement = true;
  const agent = fakeAgent("claude", (s) => (s === "implement" && failImplement ? { exitCode: 0, finalText: "STATUS: failed disk full" } : ok(s)));
  const f = makeCtx([agent]);
  const first = await startRun(makeEnv(f, cwd), opts());
  assert.equal(first.progress.status, "failed");
  assert.deepEqual(agent.stages, ["plan", "implement"]);

  failImplement = false;
  const res = await resumeRun(makeEnv(f, cwd), first.progress.id, { auto: true });
  assert.equal(res.code, 0);
  assert.equal(res.progress.status, "done");
  assert.deepEqual(agent.stages, ["plan", "implement", "implement", "verify", "review"]); // plan not re-run
  assert.equal(listProgress(cwd).length, 1);
});

test("resume after a stop clears the STOP flag", async () => {
  const cwd = tempCwd();
  let hang = true;
  const agent = fakeAgent("claude", (s) => (s === "implement" && hang ? new Promise<never>(() => {}) : ok(s)));
  const f = makeCtx([agent]);
  const done = startRun(makeEnv(f, cwd), opts());
  await until(() => listProgress(cwd)[0]?.stages.find((s) => s.name === "implement")?.status === "running");
  const id = listProgress(cwd)[0].id;
  cmdStop(makeIo(cwd), id);
  await done;
  hang = false;
  const res = await resumeRun(makeEnv(f, cwd), id, { auto: true });
  assert.equal(res.progress.status, "done");
  assert.ok(!fs.existsSync(path.join(runDir(cwd, id), "STOP")));
});

test("review uses a model family different from implement", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent();
  const { progress: p } = await startRun(makeEnv(makeCtx([agent]), cwd), opts());
  const table = loadRoutingFile().table!;
  const impl = p.stages.find((s) => s.name === "implement")!.model!;
  const rev = p.stages.find((s) => s.name === "review")!.model!;
  assert.equal(impl, "auto/claude-opus-5-5");
  assert.notEqual(familyOf(table, rev), familyOf(table, impl));
  assert.equal(rev, "auto/gemini-3.8-flash"); // review's picks start with opus, sonnet: both claude
  assert.equal(agent.calls[agent.stages.indexOf("review")].modelRoute, rev);
});

test("worker lastLine follows agent messages, at most once per second", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent();
  agent.messages = ["first message", "second message", "third message"];
  const { progress: p } = await startRun(makeEnv(makeCtx([agent]), cwd), opts({ until: "plan" }));
  assert.equal(p.workers[0].lastLine, "first message");
});

test("--agent pins the adapter", async () => {
  const cwd = tempCwd();
  const a = fakeAgent("claude");
  const b = fakeAgent("dsh");
  await startRun(makeEnv(makeCtx([a, b]), cwd), opts({ agent: "dsh", until: "plan" }));
  assert.equal(a.calls.length, 0);
  assert.equal(b.calls.length, 1);
});

test("the go command: --dry-run routes every stage, runs nothing, writes nothing", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent();
  const f = makeCtx([agent]);
  plugin.activate(f.ctx);
  const go = f.commands.find((c) => c.path.join(" ") === "go")!;
  const io = makeIo(cwd);
  const code = await go.handler({ positionals: ["make it better"], flags: { "dry-run": true } }, io);
  assert.equal(code, 0);
  assert.equal(agent.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(cwd, ".mstack")));
  const text = io.lines.join("\n");
  assert.match(text, /think → plan → implement → verify → review/);
  assert.match(text, /auto\/gemini-3\.8-flash/); // the review model
  assert.match(text, /\d+ chars/);
  assert.match(text, /approval: plan/);
  const rows = (io.dataValue as { stages: Array<{ stage: string; model?: string; selected: boolean }> }).stages;
  assert.equal(rows.find((r) => r.stage === "ship")!.selected, false);
});

test("the go command: bad --until and an empty intent are usage errors; subcommands are registered", async () => {
  const cwd = tempCwd();
  const f = makeCtx([fakeAgent()]);
  plugin.activate(f.ctx);
  const go = f.commands.find((c) => c.path.join(" ") === "go")!;
  await assert.rejects(go.handler({ positionals: ["x"], flags: { until: "party" } }, makeIo(cwd)), /--until/);
  await assert.rejects(go.handler({ positionals: [], flags: {} }, makeIo(cwd)), /usage/);
  const names = f.commands.map((c) => c.path.join(" "));
  for (const n of ["go status", "go list", "go approve", "go deny", "go stop", "statusline", "statusline install", "notify"]) assert.ok(names.includes(n), n);
});

test("go status / list read the progress contract", async () => {
  const cwd = tempCwd();
  const f = makeCtx([fakeAgent()]);
  plugin.activate(f.ctx);
  const { progress: p } = await startRun(makeEnv(f, cwd), opts());
  const find = (n: string) => f.commands.find((c) => c.path.join(" ") === n)!;
  const io = makeIo(cwd);
  await find("go status").handler({ positionals: [], flags: {} }, io);
  assert.match(io.lines[0], /^go ▸ /);
  assert.ok(io.lines.some((l) => /plan\s+done/.test(l)));
  const jio = makeIo(cwd, { json: true });
  await find("go status").handler({ positionals: [p.id.slice(-4)], flags: {} }, jio);
  assert.equal((jio.dataValue as { id: string }).id, p.id);
  const lio = makeIo(cwd);
  await find("go list").handler({ positionals: [], flags: {} }, lio);
  assert.ok(lio.lines.some((l) => l.includes(p.id)));
});

test("approve with nothing pending is an error", () => {
  const cwd = tempCwd();
  assert.throws(() => cmdDecide(makeIo(cwd), true, undefined), /usage/);
});
