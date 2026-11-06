/**
 * Policy tests: the JSONC layers, the merge order, the whitelist and the
 * route check. No file system is touched — the fs is an in-memory map.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  checkRoute,
  DEFAULT_ALLOWED_HEADLESS,
  DEFAULT_BANNED_HEADLESS,
  loadPolicy,
  normalizePolicy,
  projectPolicyPath,
  userPolicyPath,
} from "../src/policy.js";
import { makeFakeCtx } from "./fake.js";

function fsWith(files: Record<string, string>) {
  const f = makeFakeCtx();
  for (const [k, v] of Object.entries(files)) f.files.set(k, v);
  return f;
}

test("policy: the defaults are the ADR-0003 whitelist (group/* auto/*, deepseek/* banned)", () => {
  const p = normalizePolicy({});
  assert.deepEqual(p.modelRoutes.allowedHeadless, DEFAULT_ALLOWED_HEADLESS);
  assert.deepEqual(p.modelRoutes.bannedHeadless, DEFAULT_BANNED_HEADLESS);
  assert.equal(p.defaults.permissionProfile, "workspace-write");
  assert.equal(p.defaults.approval, "interactive");
});

test("policy: the user layer and the repo layer are merged, repo under user", () => {
  const home = path.resolve("/home/u/.mola"); // MOLA_HOME is resolved: E:home.mola on Windows
  const env = { MOLA_HOME: home } as NodeJS.ProcessEnv;
  const f = fsWith({
    [path.join(home, "policy.jsonc")]: JSON.stringify({
      defaults: { budgetUsdPerRun: 2, permissionProfile: "plan" },
      routes: { byTaskKind: { implement: { agents: ["dsh"], route: "group/smart-split" } } },
    }),
    [projectPolicyPath("/ws")]: JSON.stringify({
      routes: { byTaskKind: { implement: { route: "auto/kimi-k3" } } },
    }),
  });
  const p = loadPolicy(f.ctx.fs, "/ws", env);
  // the repo layer overrides the route, the user layer keeps the rest
  assert.equal(p.routes.byTaskKind.implement.route, "auto/kimi-k3");
  assert.deepEqual(p.routes.byTaskKind.implement.agents, ["dsh"]);
  assert.equal(p.defaults.permissionProfile, "plan");
  assert.equal(p.defaults.budgetUsdPerRun, 2);
  assert.equal(p.sources.length, 2);
});

test("policy: JSONC comments and trailing commas are accepted", () => {
  const home = path.resolve("/home/u/.mola"); // MOLA_HOME is resolved: E:home.mola on Windows
  const env = { MOLA_HOME: home } as NodeJS.ProcessEnv;
  const f = fsWith({
    [path.join(home, "policy.jsonc")]: `{
      // the user layer
      "defaults": { "budgetUsdPerRun": 1.5, },
      /* block comment */
      "machinePreference": ["local", "wsl:Ubuntu"],
    }`,
  });
  const p = loadPolicy(f.ctx.fs, "/ws", env);
  assert.equal(p.defaults.budgetUsdPerRun, 1.5);
  assert.deepEqual(p.machinePreference, ["local", "wsl:Ubuntu"]);
});

test("policy: an invalid JSONC file is a CONFIG_INVALID (exit 65)", () => {
  const home = path.resolve("/home/u/.mola"); // MOLA_HOME is resolved: E:home.mola on Windows
  const env = { MOLA_HOME: home } as NodeJS.ProcessEnv;
  const f = fsWith({ [path.join(home, "policy.jsonc")]: "{ this is not json" });
  assert.throws(
    () => loadPolicy(f.ctx.fs, "/ws", env),
    (err: any) => err.code === "CONFIG_INVALID" && err.exitCode === 65,
  );
});

test("policy: a missing layer is not an error (the defaults stand)", () => {
  const f = makeFakeCtx();
  const p = loadPolicy(f.ctx.fs, "/ws", { MOLA_HOME: "/nowhere" } as NodeJS.ProcessEnv);
  assert.equal(p.sources.length, 0);
  assert.deepEqual(p.modelRoutes.allowedHeadless, DEFAULT_ALLOWED_HEADLESS);
});

test("policy: the repo layer may tighten the whitelist but never loosen it", () => {
  const home = path.resolve("/home/u/.mola"); // MOLA_HOME is resolved: E:home.mola on Windows
  const env = { MOLA_HOME: home } as NodeJS.ProcessEnv;
  const f = fsWith({
    [path.join(home, "policy.jsonc")]: JSON.stringify({
      modelRoutes: { allowedHeadless: ["group/*", "auto/*"], bannedHeadless: ["deepseek/*"] },
    }),
    [projectPolicyPath("/ws")]: JSON.stringify({
      modelRoutes: { allowedHeadless: ["auto/*"], bannedHeadless: ["group/forcp"] },
    }),
  });
  const p = loadPolicy(f.ctx.fs, "/ws", env);
  // auto/* survives the intersection, group/* is dropped
  assert.ok(p.modelRoutes.allowedHeadless.includes("auto/*"));
  assert.ok(!p.modelRoutes.allowedHeadless.includes("group/*"));
  // the banned lists are unioned
  assert.ok(p.modelRoutes.bannedHeadless.includes("deepseek/*"));
  assert.ok(p.modelRoutes.bannedHeadless.includes("group/forcp"));
});

test("policy: the route check allows group/*|auto/* and bans deepseek/*", () => {
  const modelRoutes = { allowedHeadless: ["group/*", "auto/*"], bannedHeadless: ["deepseek/*"] };
  assert.equal(checkRoute("group/smart-split", modelRoutes).ok, true);
  assert.equal(checkRoute("auto/kimi-k3", modelRoutes).ok, true);
  const banned = checkRoute("deepseek/deepseek-chat", modelRoutes);
  assert.equal(banned.ok, false);
  assert.equal(banned.code, "ROUTE_BANNED");
  const outside = checkRoute("openai/gpt-4", modelRoutes);
  assert.equal(outside.ok, false);
  assert.equal(outside.code, "POLICY_DENIED");
});

test("policy: the paths are MOLA_HOME-aware", () => {
  assert.equal(userPolicyPath({ MOLA_HOME: "/tmp/m" } as NodeJS.ProcessEnv), path.join(path.resolve("/tmp/m"), "policy.jsonc"));
  assert.equal(projectPolicyPath("/ws"), path.join("/ws", ".mola", "policy.jsonc"));
});
