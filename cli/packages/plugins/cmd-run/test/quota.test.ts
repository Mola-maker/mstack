/**
 * Quota-ladder tests (ADR-0003 §4). The ladder walk is driven through
 * `runLadder` with a scripted attempt function — no agent, no magpie.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { RunResult } from "@mola/plugin-sdk";
import { normalizePolicy } from "../src/policy.js";
import {
  allowedAlternates,
  makeQuotaWaitRunner,
  planLadder,
  providerOfRoute,
  quotaWaitArgv,
  summarize,
} from "../src/quota.js";
import { runLadder } from "../src/index.js";

const QUOTA_RESULT: RunResult = {
  exitCode: 1,
  finalText: "QUOTA: 402 insufficient balance",
  quotaFailure: { provider: "magpie", route: "group/smart-split", status: 402 },
};

const OK_RESULT: RunResult = { exitCode: 0, finalText: "done" };

test("quota: the provider of a route is its prefix", () => {
  assert.equal(providerOfRoute("group/smart-split"), "group");
  assert.equal(providerOfRoute("auto/kimi-k3"), "auto");
  assert.equal(providerOfRoute(undefined), "magpie");
});

test("quota: the wait command is `magpie quota wait <provider> --timeout <d>`", () => {
  const argv = quotaWaitArgv("group", 60, "magpie");
  assert.deepEqual(argv, ["magpie", "quota", "wait", "group", "--timeout", "60"]);
});

test("quota: the ladder plan comes from the policy, unknown steps are ignored", () => {
  const policy = normalizePolicy({
    fallback: {
      onQuotaFailure: ["retry-same-route-once", "not-a-step", "switch-route", "report"],
      alternateRoutes: ["auto/kimi-k3", "group/smart-split"],
    },
  });
  const plan = planLadder(policy, ["claude"], "group/smart-split");
  assert.deepEqual(plan.steps, ["retry-same-route-once", "switch-route", "report"]);
  // the primary route is not repeated as an alternate
  assert.deepEqual(plan.alternateRoutes, ["auto/kimi-k3"]);
});

test("quota: a banned alternate route is skipped, never used", () => {
  const policy = normalizePolicy({
    fallback: { alternateRoutes: ["auto/kimi-k3", "deepseek/deepseek-chat", "group/claude-cheap"] },
  });
  assert.deepEqual(allowedAlternates(policy, policy.fallback.alternateRoutes), [
    "auto/kimi-k3",
    "group/claude-cheap",
  ]);
});

test("ladder: the first attempt succeeds — the ladder does not walk", async () => {
  const policy = normalizePolicy({});
  const calls: Array<{ agent: string; route: string }> = [];
  const walk = await runLadder({
    attempt: async (agent, route) => {
      calls.push({ agent, route });
      return OK_RESULT;
    },
    primary: { agent: "dsh", route: "group/smart-split" },
    fallbacks: [{ agent: "claude", modelRoute: "group/smart-split" }],
    policy,
    wait: async () => ({ ok: true }),
  });
  assert.equal(calls.length, 1);
  assert.equal(walk.exhausted, false);
  assert.equal(walk.result?.finalText, "done");
});

test("ladder: a 402 retries once on the same route, then switches route", async () => {
  const policy = normalizePolicy({
    fallback: {
      onQuotaFailure: ["retry-same-route-once", "switch-route", "report"],
      alternateRoutes: ["auto/kimi-k3"],
    },
  });
  const calls: Array<{ agent: string; route: string }> = [];
  const walk = await runLadder({
    attempt: async (agent, route) => {
      calls.push({ agent, route });
      return calls.length < 2 ? QUOTA_RESULT : OK_RESULT;
    },
    primary: { agent: "dsh", route: "group/smart-split" },
    fallbacks: [],
    policy,
    wait: async () => ({ ok: true }),
  });
  assert.deepEqual(calls, [
    { agent: "dsh", route: "group/smart-split" }, // the retry on the same route
    { agent: "dsh", route: "auto/kimi-k3" }, // the alternate route
  ]);
  assert.equal(walk.exhausted, false);
  assert.deepEqual(
    walk.attempts.map((a) => a.step),
    ["retry-same-route-once", "switch-route"],
  );
});

test("ladder: every allowed alternate route is tried, the banned ones are skipped", async () => {
  const policy = normalizePolicy({
    fallback: {
      onQuotaFailure: ["switch-route", "report"],
      alternateRoutes: ["auto/kimi-k3", "deepseek/deepseek-chat", "group/claude-cheap"],
    },
  });
  const calls: string[] = [];
  const walk = await runLadder({
    attempt: async (_agent, route) => {
      calls.push(route);
      return route === "group/claude-cheap" ? OK_RESULT : QUOTA_RESULT;
    },
    primary: { agent: "dsh", route: "group/smart-split" },
    fallbacks: [],
    policy,
    wait: async () => ({ ok: true }),
  });
  assert.deepEqual(calls, ["auto/kimi-k3", "group/claude-cheap"]);
  assert.equal(walk.exhausted, false);
});

test("ladder: the quota wait runs before the route switch", async () => {
  const policy = normalizePolicy({
    fallback: {
      onQuotaFailure: ["magpie-quota-wait", "switch-route", "report"],
      alternateRoutes: ["auto/kimi-k3"],
    },
  });
  const waits: string[] = [];
  const walk = await runLadder({
    attempt: async () => QUOTA_RESULT,
    primary: { agent: "dsh", route: "group/smart-split" },
    fallbacks: [],
    policy,
    wait: async (provider) => {
      waits.push(provider);
      return { ok: true };
    },
  });
  assert.deepEqual(waits, ["group"]);
  assert.equal(walk.attempts[0].step, "magpie-quota-wait");
  assert.equal(walk.attempts[1].step, "retry-same-route-once");
  assert.equal(walk.exhausted, true);
});

test("ladder: the agent switch uses the decision's fallbacks", async () => {
  const policy = normalizePolicy({
    fallback: { onQuotaFailure: ["switch-agent", "report"] },
  });
  const calls: Array<{ agent: string; route: string }> = [];
  const walk = await runLadder({
    attempt: async (agent, route) => {
      calls.push({ agent, route });
      return agent === "claude" ? OK_RESULT : QUOTA_RESULT;
    },
    primary: { agent: "dsh", route: "group/smart-split" },
    fallbacks: [{ agent: "claude", modelRoute: "group/claude-cheap" }],
    policy,
    wait: async () => ({ ok: true }),
  });
  assert.deepEqual(calls, [{ agent: "claude", route: "group/claude-cheap" }]);
  assert.equal(walk.exhausted, false);
});

test("ladder: every fallback agent of the decision is tried", async () => {
  const policy = normalizePolicy({
    fallback: { onQuotaFailure: ["switch-agent", "report"] },
  });
  const calls: string[] = [];
  const walk = await runLadder({
    attempt: async (agent) => {
      calls.push(agent);
      return agent === "codex" ? OK_RESULT : QUOTA_RESULT;
    },
    primary: { agent: "dsh", route: "group/smart-split" },
    fallbacks: [
      { agent: "claude", modelRoute: "group/claude-cheap" },
      { agent: "codex", modelRoute: "group/smart-split" },
    ],
    policy,
    wait: async () => ({ ok: true }),
  });
  assert.deepEqual(calls, ["claude", "codex"]);
  assert.equal(walk.exhausted, false);
});

test("ladder: the fallback agent is tried after the primary one fails", async () => {
  const policy = normalizePolicy({
    fallback: { onQuotaFailure: ["switch-agent", "report"] },
  });
  const calls: Array<{ agent: string; route: string }> = [];
  const walk = await runLadder({
    attempt: async (agent, route) => {
      calls.push({ agent, route });
      return agent === "claude" ? OK_RESULT : QUOTA_RESULT;
    },
    primary: { agent: "dsh", route: "group/smart-split" },
    fallbacks: [{ agent: "claude", modelRoute: "group/claude-cheap" }],
    policy,
    wait: async () => ({ ok: true }),
  });
  assert.deepEqual(calls, [{ agent: "claude", route: "group/claude-cheap" }]);
  assert.equal(walk.exhausted, false);
  assert.equal(walk.result?.finalText, "done");
});

test("ladder: an exhausted ladder reports (no result, exhausted true)", async () => {
  const policy = normalizePolicy({
    fallback: { onQuotaFailure: ["retry-same-route-once", "report"] },
  });
  const walk = await runLadder({
    attempt: async () => QUOTA_RESULT,
    primary: { agent: "dsh", route: "group/smart-split" },
    fallbacks: [],
    policy,
    wait: async () => ({ ok: false }),
  });
  assert.equal(walk.exhausted, true);
  assert.equal(walk.result, undefined);
});

test("quota: summarize marks the ladder exhausted when the last attempt failed", () => {
  const outcome = summarize([
    { step: "retry-same-route-once", agent: "dsh", modelRoute: "group/smart-split", ok: false },
  ]);
  assert.equal(outcome.exhausted, true);
  assert.equal(
    summarize([{ step: "switch-route", agent: "dsh", modelRoute: "auto/kimi-k3", ok: true }]).exhausted,
    false,
  );
});

test("quota: the wait runner spawns `magpie quota wait <provider> --timeout <d>`", async () => {
  // magpie is MOCKED here (the plugin's exec service) — never really spawned
  const calls: string[][] = [];
  const exec = {
    async exec(argv: string[]) {
      calls.push(argv);
      return { code: 0, stdout: "quota window reset", stderr: "" };
    },
  };
  const runner = makeQuotaWaitRunner(exec as never);
  const res = await runner.wait("group", 45);

  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(-5), ["quota", "wait", "group", "--timeout", "45"]);
  assert.match(calls[0][0], /^magpie(\.exe)?$/);
});

test("quota: an unreachable magpie is reported, the ladder moves on", async () => {
  const exec = {
    async exec() {
      throw new Error("ENOENT: magpie");
    },
  };
  const runner = makeQuotaWaitRunner(exec as never);
  const res = await runner.wait("group", 60);
  assert.equal(res.ok, false);
  assert.match(String(res.detail), /ENOENT/);
});

test("quota: a failing magpie wait carries its stderr into the ladder record", async () => {
  const exec = {
    async exec() {
      return { code: 1, stdout: "", stderr: "quota still exhausted" };
    },
  };
  const runner = makeQuotaWaitRunner(exec as never);
  const res = await runner.wait("group", 60);
  assert.equal(res.ok, false);
  assert.equal(res.detail, "quota still exhausted");
});
