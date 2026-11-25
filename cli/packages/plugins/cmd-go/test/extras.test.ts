import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { addNote, listCheckpoints, readProgress } from "@mola/plugin-sdk";
import { startRun } from "../src/engine.js";
import { cmdLater, cmdRewind, cmdSay, parseWhen } from "../src/extras.js";
import { applyUninstall, planUninstall, buildCommand } from "../src/statusline.js";
import { fakeAgent, makeCtx, makeEnv, makeIo, ok, tempCwd } from "./helpers.js";

const opts = (over: Record<string, unknown> = {}) =>
  ({ intent: "fix the login bug in src/auth.ts so tokens refresh", auto: true, dryRun: false, ...over }) as Parameters<typeof startRun>[1];

function gitCwd(): string {
  const cwd = tempCwd();
  const g = (...a: string[]): void => void execFileSync("git", a, { cwd });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(cwd, "src.txt"), "v0\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return cwd;
}

test("a stage that edits files gets its own checkpoint; rewind to base undoes it and is itself undoable", async () => {
  const cwd = gitCwd();
  const agent = fakeAgent("claude", (stage, _n, req) => {
    if (stage === "implement") fs.writeFileSync(path.join(req.cwd!, "src.txt"), "v1\n");
    return ok(stage);
  });
  const { progress: p } = await startRun(makeEnv(makeCtx([agent]), cwd), opts());
  assert.equal(p.status, "done");
  assert.deepEqual(listCheckpoints(cwd, p.id).map((c) => c.name), ["base", "plan", "implement", "verify", "review"]);
  assert.equal(readProgress(cwd, p.id)!.checkpoints!.length, 5);

  const dry = makeIo(cwd);
  cmdRewind(dry, p.id, "base", false);
  assert.equal(fs.readFileSync(path.join(cwd, "src.txt"), "utf8"), "v1\n", "without --yes nothing changes");

  cmdRewind(makeIo(cwd), p.id, "base", true);
  assert.equal(fs.readFileSync(path.join(cwd, "src.txt"), "utf8"), "v0\n");
  cmdRewind(makeIo(cwd), p.id, "pre-rewind", true);
  assert.equal(fs.readFileSync(path.join(cwd, "src.txt"), "utf8"), "v1\n");
});

test("rewind is refused while another run works in the same directory", async () => {
  const cwd = gitCwd();
  const { progress: done } = await startRun(makeEnv(makeCtx([fakeAgent()]), cwd), opts());
  const busy = { ...done, id: "go-busy", status: "running" as const };
  fs.mkdirSync(path.join(cwd, ".mstack", "runs", "go-busy"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".mstack", "runs", "go-busy", "progress.json"), JSON.stringify(busy));
  assert.throws(() => cmdRewind(makeIo(cwd), done.id, "base", true), /go-busy/);
});

test("notes queued with go say reach the next stage's prompt once", async () => {
  const cwd = tempCwd();
  let id = "";
  const agent = fakeAgent("claude", (stage) => {
    if (stage === "plan") addNote(cwd, id, "use the existing refresh helper", "test");
    return ok(stage);
  });
  const env = makeEnv(makeCtx([agent]), cwd);
  const origNote = env.io.note;
  // capture the id as soon as the run announces itself
  env.io = { ...env.io, note: (m: string) => ((id = /go-[\w-]+/.exec(m)?.[0] ?? id), origNote(m)) };
  const { progress: p } = await startRun(env, opts());
  const prompts = agent.calls.map((c) => c.prompt);
  const withNote = prompts.filter((t) => t.includes("use the existing refresh helper"));
  assert.equal(withNote.length, 1, "delivered to exactly one stage");
  assert.match(agent.calls[agent.stages.indexOf("implement")].prompt, /refresh helper/);
  assert.equal(readProgress(cwd, p.id)!.notesDelivered, 1);
});

test("go say refuses a finished run and empty text", async () => {
  const cwd = tempCwd();
  const { progress: p } = await startRun(makeEnv(makeCtx([fakeAgent()]), cwd), opts());
  assert.throws(() => cmdSay(makeIo(cwd), p.id, "more", "cli"), /done/);
  assert.throws(() => cmdSay(makeIo(cwd), p.id, "  ", "cli"), /usage/);
});

test("--key: a second start with the same key returns the first run and runs no agent", async () => {
  const cwd = tempCwd();
  const agent = fakeAgent();
  const first = await startRun(makeEnv(makeCtx([agent]), cwd), opts({ key: "issue-42", origin: "trigger" }));
  const calls = agent.calls.length;
  const second = await startRun(makeEnv(makeCtx([agent]), cwd), opts({ key: "issue-42" }));
  assert.equal(second.existing, true);
  assert.equal(second.progress.id, first.progress.id);
  assert.equal(agent.calls.length, calls);
  assert.equal(readProgress(cwd, first.progress.id)!.origin, "trigger");
});

test("go later: relative and absolute times; refuses a done run", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseWhen("+30m", now), now + 1800000);
  assert.equal(parseWhen("+2h", now), now + 7200000);
  assert.equal(parseWhen("2026-01-02T00:00:00Z", now), Date.parse("2026-01-02T00:00:00Z"));
  assert.equal(parseWhen("soon", now), undefined);
  const cwd = tempCwd();
  const { progress: p } = await startRun(makeEnv(makeCtx([fakeAgent()]), cwd), opts());
  assert.throws(() => cmdLater(makeIo(cwd), p.id, "+1h", false), /done/);
});

test("statusline uninstall puts the wrapped command back, or removes ours", () => {
  const dir = tempCwd();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ theme: "x", statusLine: { type: "command", command: buildCommand('hud --a "b"', "mola statusline") } }));
  const plan = planUninstall(file);
  assert.equal(plan.installed, true);
  assert.deepEqual(plan.after, { type: "command", command: 'hud --a "b"' });
  applyUninstall(plan);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { theme: "x", statusLine: { type: "command", command: 'hud --a "b"' } });

  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command: "mola statusline" } }));
  applyUninstall(planUninstall(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  assert.equal(planUninstall(file).installed, false);
});
