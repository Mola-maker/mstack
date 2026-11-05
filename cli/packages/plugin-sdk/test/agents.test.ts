/**
 * agents.ts tests: the B2 run-surface contract pieces that are pure data —
 * the runnable-agent guard, the UnsupportedCapability error, quota-failure
 * normalization and the magpie usage CSV parse. Adapter behavior is tested in
 * the agent-* plugin packages.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  UnsupportedCapability,
  detectQuotaFailure,
  isRunnableAgent,
  parseMagpieUsageCsv,
  parseNdjson,
  firstString,
} from "@mola/plugin-sdk";
import { ExitCode } from "@mola/plugin-sdk";
import type { AgentAdapter, HeadlessAgentAdapter } from "@mola/plugin-sdk";

test("isRunnableAgent: detection-only adapters are not runnable", () => {
  const probeOnly: AgentAdapter = { id: "magpie", detect: async () => ({ available: false }) };
  assert.equal(isRunnableAgent(probeOnly), false);

  const runnable = {
    id: "dsh",
    detect: async () => ({ available: true }),
    capabilities: { headless: true },
    run: async () => ({ exitCode: 0, finalText: "" }),
    resume: async () => ({ exitCode: 0, finalText: "" }),
  } as unknown as HeadlessAgentAdapter;
  assert.equal(isRunnableAgent(runnable), true);
});

test("UnsupportedCapability: exit 69, machine-readable code + capability", () => {
  const err = new UnsupportedCapability("codex", "resume", "exec resume flags not captured");
  assert.equal(err.code, "UNSUPPORTED_CAPABILITY");
  assert.equal(err.exitCode, ExitCode.Unavailable);
  assert.equal(err.capability, "resume");
  assert.equal(err.agentId, "codex");
  assert.match(err.message, /codex does not support resume/);
});

test("detectQuotaFailure: 402, 429 and quota-shaped text normalize; other text does not", () => {
  assert.deepEqual(detectQuotaFailure("API error: 402 payment required", "group/smart-split"), {
    provider: "magpie",
    route: "group/smart-split",
    status: 402,
  });
  assert.equal(detectQuotaFailure("Too many requests: 429")?.status, 429);
  assert.equal(detectQuotaFailure("Rate limit exceeded, retry later")?.status, 402);
  assert.equal(detectQuotaFailure("insufficient quota balance")?.status, 402);
  assert.equal(detectQuotaFailure("file not found: README.md"), undefined);
});

test("parseMagpieUsageCsv: columns matched by name, unknown headers ⇒ []", () => {
  const csv = [
    "agent,model,input_tokens,output_tokens,cost_usd,time,status",
    "claude,auto/claude-sonnet-5-5,1234,567,0.42,2026-11-06T10:00:00Z,200",
    "codex,kimi-code-cn/k3,100,20,0.01,2026-11-06T10:01:00Z,200",
  ].join("\n");
  const rows = parseMagpieUsageCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].agent, "claude");
  assert.equal(rows[0].model, "auto/claude-sonnet-5-5");
  assert.equal(rows[0].inputTokens, 1234);
  assert.equal(rows[0].outputTokens, 567);
  assert.equal(rows[0].costUsd, 0.42);
  assert.equal(rows[0].source, "magpie");

  assert.deepEqual(parseMagpieUsageCsv("a,b\n1,2"), []);
  assert.deepEqual(parseMagpieUsageCsv("agent,model\nclaude,auto/x"), []);
  assert.deepEqual(parseMagpieUsageCsv(""), []);
});

test("parseNdjson + firstString: lenient stream-bridge primitives", () => {
  const events = parseNdjson('noise\n{"type":"a","text":"hi"}\n{bad json}\n{"type":"b"}\n');
  assert.equal(events.length, 2);
  assert.equal(firstString(events[0], ["result", "text", "message"]), "hi");
  assert.equal(firstString(events[1], ["result", "text", "message"]), undefined);
});
