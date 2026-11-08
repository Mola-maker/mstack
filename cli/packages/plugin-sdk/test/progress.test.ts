import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  activeProgress,
  decideApproval,
  formatProgressLine,
  listProgress,
  readApproval,
  readProgress,
  writeApproval,
  writeProgress,
  type RunProgress,
} from "@mola/plugin-sdk";

function sample(cwd: string, id: string, status: RunProgress["status"] = "running"): RunProgress {
  return {
    schemaVersion: 1,
    id,
    intent: "fix the flaky test",
    cwd,
    status,
    startedAt: new Date(Date.now() - 6 * 60000).toISOString(),
    updatedAt: "",
    stage: "verify",
    stages: [
      { name: "think", status: "skipped" },
      { name: "plan", status: "done", costUsd: 0.1 },
      { name: "implement", status: "done", costUsd: 0.25 },
      { name: "verify", status: "running", costUsd: 0.07 },
      { name: "review", status: "pending" },
    ],
    workers: [
      { id: "w1", stage: "verify", status: "working" },
      { id: "w2", stage: "verify", status: "working" },
      { id: "w3", stage: "implement", status: "done" },
    ],
    costUsd: 0,
  };
}

test("write/read/list/active progress round-trip", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mola-progress-"));
  writeProgress(sample(cwd, "a", "done"));
  writeProgress(sample(cwd, "b"));
  assert.equal(readProgress(cwd, "b")?.costUsd, 0.42);
  assert.deepEqual(listProgress(cwd).map((p) => p.id).sort(), ["a", "b"]);
  assert.equal(activeProgress(cwd)?.id, "b");
  assert.equal(listProgress(path.join(cwd, "missing")).length, 0);
});

test("formatProgressLine counts active stages and working agents", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mola-progress-"));
  const p = sample(cwd, "x");
  writeProgress(p);
  assert.equal(formatProgressLine(p), "go ▸ verify (3/4) · 2 agents · $0.42 · 6m");
  p.status = "blocked";
  p.blocked = { reason: "approve push" };
  assert.match(formatProgressLine(p), /^go ⏸ verify: approve push/);
});

test("approvals decide once", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mola-progress-"));
  writeApproval(cwd, { id: "ap1", runId: "r", stage: "ship", action: "push", status: "pending", createdAt: "t" });
  assert.equal(decideApproval(cwd, "r", "ap1", true, "web"), true);
  assert.equal(readApproval(cwd, "r", "ap1")?.status, "approved");
  assert.equal(decideApproval(cwd, "r", "ap1", false, "web"), false);
  assert.equal(decideApproval(cwd, "r", "nope", true, "web"), false);
});
