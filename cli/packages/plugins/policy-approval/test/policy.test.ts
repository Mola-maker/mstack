/**
 * policy-approval tests. The gates are exercised through a fake bus with the
 * same waterfall semantics as core (each listener rewrites or throws; the
 * rejection is the denial path). No processes, no config files.
 */

import test from "node:test";
import assert from "node:assert/strict";
import plugin, { checkModelRoute, classifyToolCall, routePolicyFromConfig } from "../src/index.js";
import { makeFakeCtx, makeIo, errOf } from "./fake.js";

function activate(config: Record<string, unknown> = {}) {
  const f = makeFakeCtx({ config });
  plugin.activate(f.ctx);
  return f;
}

// ------------------------------------------------------------ route whitelist

test("route whitelist: group/* and auto/* pass", () => {
  for (const route of ["group/smart-split", "group/claude-cheap", "auto/kimi-k3", "auto/gemini-3.8-flash"]) {
    assert.deepEqual(checkModelRoute(route), { ok: true, route }, route);
  }
});

test("route whitelist: deepseek/* → ROUTE_BANNED, other non-whitelisted → POLICY_DENIED", () => {
  const banned = checkModelRoute("deepseek/deepseek-chat");
  assert.equal(banned.ok, false);
  assert.equal((banned as { code: string }).code, "ROUTE_BANNED");
  assert.match((banned as { message: string }).message, /deepseek\/\*/);

  const off = checkModelRoute("magpie/grok/grok-4.7");
  assert.equal(off.ok, false);
  assert.equal((off as { code: string }).code, "POLICY_DENIED");

  // `*` stays within one segment: deepseek/a/b is still banned by deepseek/*
  assert.equal(checkModelRoute("deepseek/reasoner/v3").ok, false);
  // a route merely containing "deepseek" as a group id is fine
  assert.equal(checkModelRoute("group/deepseek-ish").ok, true);
});

test("route whitelist: policy is configurable; banned is checked before allowed", () => {
  const custom = checkModelRoute("auto/kimi-k3", {
    allowedHeadless: ["group/*"],
    bannedHeadless: ["auto/*", "deepseek/*"],
  });
  assert.equal(custom.ok, false);
  assert.equal((custom as { code: string }).code, "ROUTE_BANNED");
});

// ---------------------------------------------------------- argv classifier

test("classifier: outward and destructive commands are held", () => {
  const denied = [
    ["git", "push", "origin", "main"],
    ["git", "-C", "/repo", "push", "--force"],
    ["git", "merge", "agent/task-1"],
    ["gh", "pr", "create", "--fill"],
    ["gh", "pr", "merge", "12", "--squash"],
    ["gh", "release", "create", "v1"],
    ["gh", "repo", "delete", "x/y"],
    ["npm", "publish"],
    ["pnpm", "publish", "--access", "public"],
    ["cargo", "publish"],
    ["rm", "-rf", "/tmp/x"],
    ["rm", "-fr", "build"],
    ["rm", "--recursive", "--force", "dist"],
    // the classifier sees through the bash -lc wrapper dispatch uses
    ["bash", "-lc", "cd /mnt/e/mstack; git push origin main"],
  ];
  for (const argv of denied) {
    const v = classifyToolCall({ tool: "process", argv });
    assert.equal(v.action, "deny", argv.join(" "));
  }
});

test("classifier: ordinary work passes", () => {
  const allowed = [
    ["git", "status", "--porcelain"],
    ["git", "commit", "-m", "wip"],
    ["gh", "pr", "view", "12", "--json"],
    ["node", "--test"],
    ["bash", "-lc", "dsh --profile mola-cli --patch o.yml --json - < tasks/b1.md"],
    ["npm", "test"],
    ["rm", "-r", "dist"],
    ["rm", "file.txt"],
  ];
  for (const argv of allowed) {
    assert.equal(classifyToolCall({ tool: "process", argv }).action, "allow", argv.join(" "));
  }
});

// ------------------------------------------------------------------ wiring

test("pre-dispatch gate: banned route throws ROUTE_BANNED with exit 77", async () => {
  const f = activate();
  const err = errOf(
    await f.ctx.events
      .runWaterfall("mola.task.pre-dispatch", { modelRoute: "deepseek/deepseek-chat" })
      .catch((e) => e),
  );
  assert.equal(err.code, "ROUTE_BANNED");
  assert.equal(err.exitCode, 77);
});

test("pre-dispatch gate: whitelisted routes pass through untouched", async () => {
  const f = activate();
  const value = { agent: "dsh", modelRoute: "group/smart-split" };
  const out = await f.ctx.events.runWaterfall("mola.task.pre-dispatch", value);
  assert.deepEqual(out, value);
});

test("pre-dispatch gate: a missing modelRoute is a policy denial", async () => {
  const f = activate();
  const err = errOf(
    await f.ctx.events.runWaterfall("mola.task.pre-dispatch", {}).catch((e) => e),
  );
  assert.equal(err.code, "POLICY_DENIED");
  assert.equal(err.exitCode, 77);
});

test("pre-dispatch gate: policy routes can be overridden from config", async () => {
  const f = activate({
    "policy.modelRoutes.allowedHeadless": ["magpie/**"],
    "policy.modelRoutes.bannedHeadless": ["deepseek/*"],
  });
  const out = await f.ctx.events.runWaterfall("mola.task.pre-dispatch", { modelRoute: "magpie/grok/grok-4.7" });
  assert.deepEqual(out, { modelRoute: "magpie/grok/grok-4.7" });
  const err = errOf(
    await f.ctx.events.runWaterfall("mola.task.pre-dispatch", { modelRoute: "group/smart-split" }).catch((e) => e),
  );
  assert.equal(err.code, "POLICY_DENIED");
});

test("tool.before gate: denial without --yes → PolicyDenial + approval.denied on the bus", async () => {
  const f = activate();
  const err = errOf(
    await f.ctx.events
      .runWaterfall("mola.tool.before", { tool: "process", argv: ["git", "push"], yes: false })
      .catch((e) => e),
  );
  assert.equal(err.code, "POLICY_DENIED");
  assert.equal(err.exitCode, 77);
  assert.deepEqual(
    f.emitted.map((e) => e.event),
    ["mola.approval.denied"],
  );
  assert.match((f.emitted[0].data as { reason: string }).reason, /--yes/);
});

test("tool.before gate: --yes lets the held action through and emits approval.granted", async () => {
  const f = activate();
  const value = { tool: "process", argv: ["git", "push", "origin", "main"], yes: true };
  const out = await f.ctx.events.runWaterfall("mola.tool.before", value);
  assert.deepEqual(out, value);
  assert.deepEqual(
    f.emitted.map((e) => e.event),
    ["mola.approval.granted"],
  );
  assert.equal((f.emitted[0].data as { approver: string }).approver, "--yes");
});

test("tool.before gate: safe commands pass silently with no approval events", async () => {
  const f = activate();
  const value = { tool: "dsh", argv: ["bash", "-lc", "dsh --profile mola-cli …"], yes: false };
  const out = await f.ctx.events.runWaterfall("mola.tool.before", value);
  assert.deepEqual(out, value);
  assert.deepEqual(f.emitted, []);
});

test("routePolicyFromConfig: falls back to the ADR-0003 defaults", () => {
  const f = activate();
  const policy = routePolicyFromConfig(f.ctx.config);
  assert.deepEqual(policy.allowedHeadless, ["group/*", "auto/*"]);
  assert.deepEqual(policy.bannedHeadless, ["deepseek/*"]);
});

test("denial error shape: the router maps it to the exit-77 envelope", async () => {
  const f = activate();
  const thrown = await f.ctx.events
    .runWaterfall("mola.tool.before", { argv: ["gh", "pr", "merge", "1"] })
    .then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
  const err = errOf(thrown);
  assert.equal(err.code, "POLICY_DENIED");
  assert.equal(err.exitCode, 77);
  void makeIo; // io shape exercised by the command plugins' own tests
});
