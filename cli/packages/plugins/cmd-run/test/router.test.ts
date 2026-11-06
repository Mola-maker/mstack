/**
 * Router tests: the filter step (health, capability, pinned agent/machine),
 * the score step (kind affinity, cost, route fit, machine rank, failure
 * memory) and the route selection. Pure functions — no processes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  collectCandidates,
  filterCandidates,
  hasCapabilities,
  kindAffinity,
  machineMatches,
  machineRank,
  permissionProfileFor,
  routeFit,
  routeForTaskKind,
  runnableAdapters,
  scoreCandidates,
  type RouteCandidate,
  type RouteRequest,
} from "../src/router.js";
import { normalizePolicy } from "../src/policy.js";
import { makeFakeAdapter, makeFakeCtx, TEST_CAPS } from "./fake.js";

function candidate(id: string, over: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    adapter: makeFakeAdapter({ id, results: [], calls: [] }),
    id,
    machine: "local",
    available: true,
    health: "ok",
    recentFailures: 0,
    ...over,
  };
}

const REQ: RouteRequest = { taskKind: "implement", prompt: "x", approval: "interactive" };

test("router: the filter drops broken, undetected, capability-less and unpinned candidates", () => {
  const candidates = [
    candidate("dsh", { adapter: makeFakeAdapter({ id: "dsh", results: [], calls: [], capabilities: { nativeHooks: true } }) }),
    candidate("claude", { health: "broken" }),
    candidate("codex", { available: false }),
    candidate("pi", { adapter: makeFakeAdapter({ id: "pi", results: [], calls: [], capabilities: { nativeHooks: false } }) }),
  ];
  const { kept, rejected } = filterCandidates(candidates, {
    ...REQ,
    requiresCapability: { nativeHooks: true },
  });
  assert.deepEqual(kept.map((k) => k.id), ["dsh"]);
  assert.equal(rejected.length, 3);
});

test("router: a pinned agent narrows the set to that agent", () => {
  const { kept, rejected } = filterCandidates([candidate("dsh"), candidate("claude")], {
    ...REQ,
    prefersAgent: "claude",
  });
  assert.deepEqual(kept.map((k) => k.id), ["claude"]);
  assert.equal(rejected[0].why, "agent pinned to claude");
});

test("router: a pinned machine is a prefix match (wsl matches wsl:Ubuntu)", () => {
  assert.equal(machineMatches("wsl:Ubuntu", "wsl"), true);
  assert.equal(machineMatches("local", "local"), true);
  assert.equal(machineMatches("local", "wsl"), false);
  const { kept } = filterCandidates(
    [candidate("dsh", { machine: "wsl:Ubuntu" }), candidate("claude", { machine: "local" })],
    { ...REQ, prefersMachine: "wsl" },
  );
  assert.deepEqual(kept.map((k) => k.id), ["dsh"]);
});

test("router: the policy's agent list drives the kind affinity", () => {
  const policy = normalizePolicy({ routes: { byTaskKind: { review: { agents: ["codex", "claude"] } } } });
  assert.ok(kindAffinity("review", "codex", policy) > kindAffinity("review", "claude", policy));
  assert.ok(kindAffinity("review", "codex", policy) > kindAffinity("review", "dsh", policy));
});

test("router: the machine preference ranks the preferred machine first", () => {
  const policy = normalizePolicy({ machinePreference: ["local", "wsl:Ubuntu"] });
  assert.ok(machineRank("local", policy) > machineRank("wsl:Ubuntu", policy));
  assert.ok(machineRank("wsl:Ubuntu", policy) > machineRank("jlu-pc", policy));
});

test("router: the score puts the best candidate first and records the breakdown", () => {
  const policy = normalizePolicy({ routes: { byTaskKind: { review: { agents: ["codex"] } } } });
  const ranked = scoreCandidates(
    [candidate("dsh"), candidate("codex"), candidate("claude")],
    { ...REQ, taskKind: "review" },
    policy,
    "group/smart-split",
  );
  assert.equal(ranked[0].id, "codex");
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].breakdown.kind > 0);
});

test("router: the failure memory pushes a failing agent down", () => {
  const policy = normalizePolicy({});
  const clean = scoreCandidates([candidate("codex"), candidate("claude")], { ...REQ, taskKind: "review" }, policy, "group/smart-split");
  const failing = scoreCandidates(
    [candidate("codex", { recentFailures: 3 }), candidate("claude")],
    { ...REQ, taskKind: "review" },
    policy,
    "group/smart-split",
  );
  assert.equal(clean[0].id, "codex");
  assert.equal(failing[0].id, "claude");
});

test("router: the route fit prefers a route the agent can see", () => {
  assert.equal(routeFit(["group/smart-split"], "group/smart-split"), 1);
  assert.ok(routeFit(["auto/kimi-k3"], "group/smart-split") < 0.5);
  assert.equal(routeFit(undefined, "group/smart-split"), 0.5); // unknown → neutral
  // a known-empty visible set is a poor fit, not a neutral one
  assert.ok(routeFit([], "group/smart-split") < 0.5);
});

test("router: the route for a task kind comes from the policy row, then the default row", () => {
  const policy = normalizePolicy({
    routes: { byTaskKind: { review: { route: "auto/kimi-k3" } }, default: { route: "group/claude-cheap" } },
  });
  assert.equal(routeForTaskKind("review", policy, "group/smart-split"), "auto/kimi-k3");
  assert.equal(routeForTaskKind("implement", policy, "group/smart-split"), "group/claude-cheap");
  assert.equal(routeForTaskKind("implement", normalizePolicy({}), "group/smart-split"), "group/smart-split");
});

test("router: the permission profile for a task kind falls back to the default", () => {
  const policy = normalizePolicy({
    defaults: { permissionProfile: "workspace-write" },
    routes: { byTaskKind: { plan: { permissionProfile: "plan" } } },
  });
  assert.equal(permissionProfileFor("plan", policy), "plan");
  assert.equal(permissionProfileFor("implement", policy), "workspace-write");
});

test("router: only the runnable adapters are candidates (a detect-only adapter is skipped)", () => {
  const runnable = makeFakeAdapter({ id: "dsh", results: [], calls: [] });
  const detectOnly = { id: "magpie", detect: async () => ({ available: true }) };
  const list = runnableAdapters([runnable, detectOnly]);
  assert.deepEqual(list.map((a) => a.id), ["dsh"]);
});

test("router: collectCandidates reports the detection health", async () => {
  const broken = makeFakeAdapter({ id: "omp", results: [], calls: [], broken: true });
  const ok = makeFakeAdapter({ id: "dsh", results: [], calls: [] });
  const candidates = await collectCandidates([broken, ok]);
  assert.equal(candidates[0].health, "broken");
  assert.equal(candidates[1].health, "ok");
});

test("router: the capability check compares each requested capability", () => {
  assert.equal(hasCapabilities(TEST_CAPS, { headless: true }), true);
  assert.equal(hasCapabilities(TEST_CAPS, { headless: false }), false);
  assert.equal(hasCapabilities(TEST_CAPS, { resume: true, listSessions: false }), true);
  assert.equal(hasCapabilities(TEST_CAPS, undefined), true);
});

test("router: the ctx.agents registry is the candidate source", async () => {
  const f = makeFakeCtx({ agents: [{ id: "dsh", results: [], calls: [] }] });
  const candidates = await collectCandidates(runnableAdapters(f.ctx.agents.list()));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, "dsh");
});
