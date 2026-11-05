import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openJsonStateStore, openSqliteStateStore, openStateStore } from "@mola/core";

// node:sqlite is Node >=22.5 (unflagged); on older runners the JSON fallback
// applies and the SQLite cases are skipped
const hasSqlite: boolean = await import("node:sqlite").then(
  () => true,
  () => false,
);

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mola-state-"));
}

test("state: run history persists across reopen, capped at 500", () => {
  const dir = tmp();
  const file = path.join(dir, "state.json");
  const s1 = openJsonStateStore(file);
  s1.recordRun({ traceId: "t1", argv: ["doctor"], command: "doctor", exitCode: 0, startedAt: "2026-01-01", durationMs: 5 });
  s1.flush();
  const s2 = openJsonStateStore(file);
  const runs = s2.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].traceId, "t1");
  assert.equal(runs[0].exitCode, 0);

  for (let i = 0; i < 600; i++) {
    s2.recordRun({ traceId: `r${i}`, argv: [], command: "x", exitCode: 0, startedAt: "", durationMs: 0 });
  }
  s2.flush();
  const s3 = openJsonStateStore(file);
  assert.equal(s3.runs(1000).length, 500);
});

test("state: per-plugin KV namespaces are isolated", () => {
  const dir = tmp();
  const file = path.join(dir, "state.json");
  const s = openJsonStateStore(file);
  s.namespace("a").set("k", 1);
  s.namespace("b").set("k", 2);
  assert.equal(s.namespace("a").get("k"), 1);
  assert.equal(s.namespace("b").get("k"), 2);
  s.namespace("a").delete("k");
  assert.equal(s.namespace("a").get("k"), undefined);
  assert.deepEqual(s.namespace("b").keys(), ["k"]);
  s.flush();
  const s2 = openJsonStateStore(file);
  assert.equal(s2.namespace("b").get("k"), 2);
});

test("state: corrupt file is not fatal", () => {
  const dir = tmp();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{ nope", "utf8");
  const s = openJsonStateStore(file);
  assert.deepEqual(s.runs(), []);
});

test("state: sqlite store persists runs and kv across reopen", { skip: !hasSqlite }, () => {
  const dir = tmp();
  const db = path.join(dir, "state.db");
  const s1 = openSqliteStateStore(db);
  s1.recordRun({ traceId: "t1", argv: ["doctor"], command: "doctor", exitCode: 0, startedAt: "2026-01-01", durationMs: 5 });
  s1.namespace("mola-cmd-model").set("route:dsh", "group/smart-split");
  s1.flush();

  const s2 = openSqliteStateStore(db);
  assert.equal(s2.runs().length, 1);
  assert.equal(s2.runs()[0].traceId, "t1");
  assert.deepEqual(s2.runs()[0].argv, ["doctor"]);
  assert.equal(s2.namespace("mola-cmd-model").get<string>("route:dsh"), "group/smart-split");
  assert.deepEqual(s2.namespace("mola-cmd-model").keys(), ["route:dsh"]);
  assert.equal(s2.namespace("mola-other").get("route:dsh"), undefined);
});

test("state: sqlite run history is capped at 500", { skip: !hasSqlite }, () => {
  const dir = tmp();
  const s = openSqliteStateStore(path.join(dir, "state.db"));
  for (let i = 0; i < 600; i++) {
    s.recordRun({ traceId: `r${i}`, argv: [], command: "x", exitCode: 0, startedAt: "", durationMs: 0 });
  }
  assert.equal(s.runs(1000).length, 500);
  assert.deepEqual(s.runs(3).map((r) => r.traceId), ["r597", "r598", "r599"]);
});

test("state: openStateStore migrates a B1 state.json on first open", { skip: !hasSqlite }, () => {
  const dir = tmp();
  const legacy = {
    schemaVersion: 1,
    runs: [{ traceId: "old-1", argv: ["dispatch"], command: "dispatch", exitCode: 0, startedAt: "2026-01-01", durationMs: 9 }],
    kv: { "mola-cmd-dispatch": { "run:old-1": { runId: "old-1", exitCode: 0 } } },
  };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(legacy), "utf8");

  const s = openStateStore(dir);
  assert.equal(s.runs().length, 1);
  assert.equal(s.runs()[0].traceId, "old-1");
  const snap = s.namespace("mola-cmd-dispatch").get<{ runId: string }>("run:old-1");
  assert.equal(snap?.runId, "old-1");
  assert.ok(fs.existsSync(path.join(dir, "state.json.migrated")), "legacy file kept as backup");
  assert.ok(!fs.existsSync(path.join(dir, "state.json")), "state.json retired after migration");

  // second open must not re-migrate or duplicate
  const s2 = openStateStore(dir);
  assert.equal(s2.runs().length, 1);
  s2.recordRun({ traceId: "new-1", argv: [], command: "doctor", exitCode: 0, startedAt: "", durationMs: 1 });
  assert.equal(openStateStore(dir).runs().length, 2);
});

test("state: openStateStore falls back to JSON when sqlite cannot open", { skip: !hasSqlite }, () => {
  const dir = tmp();
  // a directory where state.db belongs makes DatabaseSync throw → JSON fallback
  fs.mkdirSync(path.join(dir, "state.db"));
  const s = openStateStore(dir);
  s.recordRun({ traceId: "t1", argv: [], command: "doctor", exitCode: 0, startedAt: "", durationMs: 0 });
  s.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(raw.runs.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, "state.json.migrated")));
});

test("state: openStateStore without node:sqlite uses the JSON store", { skip: hasSqlite }, () => {
  const dir = tmp();
  const s = openStateStore(dir);
  s.recordRun({ traceId: "t1", argv: [], command: "doctor", exitCode: 0, startedAt: "", durationMs: 0 });
  assert.ok(fs.existsSync(path.join(dir, "state.json")));
});
