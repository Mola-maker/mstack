import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { aggregate, priceOf, readLedger, scanClaude, scanCodex, updateLedger } from "../src/index.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mola-usage-"));
process.env.MOLA_HOME = path.join(home, "mola");

function claudeRoot(): string {
  const root = path.join(home, "claude");
  const dir = path.join(root, "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const row = (id: string, ts: string, model: string, u: Record<string, number>) =>
    JSON.stringify({ type: "assistant", timestamp: ts, cwd: "/w", requestId: "r" + id, message: { id, model, usage: u } });
  fs.writeFileSync(
    path.join(dir, "s.jsonl"),
    [
      row("m1", "2026-03-01T10:00:00Z", "claude-opus-5-5", { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 }),
      // the same message written twice counts once
      row("m1", "2026-03-01T10:00:01Z", "claude-opus-5-5", { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 }),
      row("m2", "2026-03-02T10:00:00Z", "claude-haiku-5-5", { input_tokens: 5, output_tokens: 5 }),
      JSON.stringify({ type: "user", timestamp: "2026-03-01T10:00:00Z", message: { content: "usage of words" } }),
      "not json",
    ].join("\n"),
  );
  return root;
}

function codexRoot(): string {
  const root = path.join(home, "codex");
  const dir = path.join(root, "sessions", "2026", "03", "01");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "rollout-a.jsonl"),
    [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-6", cwd: "/w" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-03-01T11:00:00Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 10 } } } }),
    ].join("\n"),
  );
  return root;
}

test("scan: Claude rows dedupe by message, Codex cached tokens split out of input", () => {
  const c = scanClaude(claudeRoot(), 0);
  assert.equal(c.length, 2);
  const x = scanCodex(codexRoot(), 0);
  assert.deepEqual([x[0].model, x[0].input, x[0].cacheRead, x[0].output], ["gpt-6", 200, 800, 60]);
});

test("ledger keeps rows across scans, never twice, and prunes past retention", () => {
  const rows = [...scanClaude(claudeRoot(), 0), ...scanCodex(codexRoot(), 0)];
  const now = Date.parse("2026-03-05T00:00:00Z");
  assert.equal(updateLedger(rows, 92, now).added, 3);
  assert.equal(updateLedger(rows, 92, now).added, 0);
  // the transcripts are gone (Claude deleted them): the ledger still has them
  assert.equal(updateLedger([], 92, now).total, 3);
  assert.equal(updateLedger([], 2, now).total, 0);
  assert.equal(readLedger().length, 0);
});

test("aggregate: prices by exact id or longest prefix; unpriced still counts tokens; cache hit share", () => {
  const rows = [...scanClaude(claudeRoot(), 0), ...scanCodex(codexRoot(), 0)];
  const prices = { claude: { input: 1, output: 1 }, "claude-opus": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12 } };
  assert.equal(priceOf("claude-opus-5-5", prices), prices["claude-opus"]);
  const b = aggregate(rows, "model", prices);
  const opus = b.find((x) => x.key === "claude-opus-5-5")!;
  assert.equal(Number(opus.cost.toFixed(6)), Number(((10 * 10 + 100 * 50 + 900 * 1 + 90 * 12) / 1e6).toFixed(6)));
  assert.equal(Math.round(opus.cacheHit * 100), 90);
  const gpt = b.find((x) => x.key === "gpt-6")!;
  assert.equal(gpt.unpriced, 1);
  assert.equal(gpt.output, 60);
  assert.deepEqual(aggregate(rows, "day", prices).map((x) => x.key), ["2026-03-02", "2026-03-01"]);
});
