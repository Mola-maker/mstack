import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pendingNotes, saveCheckpoint, writeProgress, type RunProgress } from "@mola/plugin-sdk";
import { startWeb } from "@mola/plugin-cmd-web";

function gitRun(status: RunProgress["status"] = "running"): { cwd: string; id: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mola-web-t3-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(cwd, "a.txt"), "1\n");
  g("add", "-A");
  g("commit", "-qm", "i");
  const id = "go-web";
  saveCheckpoint(cwd, id, "base");
  fs.writeFileSync(path.join(cwd, "a.txt"), "2\n");
  saveCheckpoint(cwd, id, "implement");
  const now = new Date().toISOString();
  writeProgress({ schemaVersion: 1, id, intent: "x", cwd, status, startedAt: now, updatedAt: now, stage: "implement", stages: [], workers: [], costUsd: 0 });
  return { cwd, id };
}

test("say queues a note (invisible text stripped); refused on a done run", async () => {
  const { cwd, id } = gitRun();
  const w = await startWeb({ port: 0, cwds: [cwd] });
  const base = `http://127.0.0.1:${w.port}`;
  try {
    const r = await fetch(`${base}/api/runs/${id}/say`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "keep the API​ stable" }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, queued: 1, removedInvisible: 1 });
    assert.equal(pendingNotes(cwd, id)[0].by, "web");
    const d = await fetch(`${base}/api/runs/${id}/diff`);
    const body = (await d.json()) as { diff: string };
    assert.match(body.diff, /\+2/);
  } finally {
    await w.close();
  }
  const done = gitRun("done");
  const w2 = await startWeb({ port: 0, cwds: [done.cwd] });
  try {
    const r = await fetch(`http://127.0.0.1:${w2.port}/api/runs/${done.id}/say`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"text":"x"}' });
    assert.equal(r.status, 409);
  } finally {
    await w2.close();
  }
});

test("token: header works, the printed URL keeps it in the fragment, SSE takes a one-use ticket", async () => {
  const { cwd } = gitRun();
  const w = await startWeb({ port: 0, host: "127.0.0.1", token: "s3cret", cwds: [cwd] });
  const base = `http://127.0.0.1:${w.port}`;
  try {
    assert.match(w.url, /#token=s3cret$/);
    assert.equal((await fetch(`${base}/api/runs`)).status, 401);
    assert.equal((await fetch(`${base}/api/runs`, { headers: { Authorization: "Bearer s3cret" } })).status, 200);
    assert.equal((await fetch(`${base}/api/ticket`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const t = (await (await fetch(`${base}/api/ticket`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer s3cret" }, body: "{}" })).json()) as { ticket: string };
    // a ticket opens the stream once, and only the stream
    assert.equal((await fetch(`${base}/api/runs?ticket=${t.ticket}`)).status, 401);
    const ac = new AbortController();
    const s = await fetch(`${base}/api/stream?ticket=${t.ticket}`, { signal: ac.signal });
    assert.equal(s.status, 200);
    ac.abort();
    assert.equal((await fetch(`${base}/api/stream?ticket=${t.ticket}`)).status, 401);
  } finally {
    await w.close();
  }
});

test("launch strips invisible characters before the task reaches the run", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mola-web-l-"));
  const got: string[] = [];
  const w = await startWeb({ port: 0, cwds: [cwd], startRun: (r) => (got.push(r.task), { exited: Promise.resolve() }) });
  try {
    const r = await fetch(`http://127.0.0.1:${w.port}/api/launch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "fix​ it" + String.fromCodePoint(0xe0049) }) });
    assert.equal(r.status, 202);
    assert.deepEqual(got, ["fix it"]);
  } finally {
    await w.close();
  }
});
