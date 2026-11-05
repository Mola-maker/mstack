import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openJsonStateStore } from "@mola/core";

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
