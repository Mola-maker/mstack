import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ALLOWED_ROUTES,
  DEFAULT_BANNED_ROUTES,
  classifyRoute,
  globToRegExp,
  stripMagpiePrefix,
} from "@mola/plugin-cmd-model";

test("the whitelist allows the magpie group/* and auto/* routes", () => {
  for (const route of ["group/smart-split", "group/claude-cheap", "auto/kimi-k3", "auto/deepseek-v4-pro"]) {
    const v = classifyRoute(route);
    assert.deepEqual(v, { ok: true }, route);
  }
});

test("deepseek/* direct is banned with ROUTE_BANNED semantics", () => {
  for (const route of ["deepseek/deepseek-chat", "deepseek/deepseek-v4-pro"]) {
    const v = classifyRoute(route);
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.reason, "banned");
      assert.match(v.message, /banned/);
    }
  }
});

test("raw provider routes are not in the whitelist either", () => {
  const v = classifyRoute("claude/claude-sonnet-5-5");
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, "not-allowed");
});

test("the lists are config, not code — overrides are honored", () => {
  const v = classifyRoute("deepseek/deepseek-chat", ["deepseek/*"], []);
  assert.deepEqual(v, { ok: true }, "an explicit policy override can allow a provider route");
  const v2 = classifyRoute("group/smart-split", ["auto/*"]);
  assert.equal(v2.ok, false);
});

test("defaults match ADR-0003 §2", () => {
  assert.deepEqual(DEFAULT_ALLOWED_ROUTES, ["group/*", "auto/*"]);
  assert.deepEqual(DEFAULT_BANNED_ROUTES, ["deepseek/*"]);
});

test("globToRegExp: * stays within one segment, ** crosses", () => {
  assert.ok(globToRegExp("group/*").test("group/smart-split"));
  assert.ok(!globToRegExp("group/*").test("group/a/b"));
  assert.ok(globToRegExp("group/**").test("group/a/b"));
  assert.ok(!globToRegExp("group/smart-split").test("group/smart-split-2"));
  assert.ok(globToRegExp("deepseek/deepseek-v4-pro[1M]").test("deepseek/deepseek-v4-pro[1M]"), "brackets are literal");
});

test("stripMagpiePrefix exposes the bare route id", () => {
  assert.equal(stripMagpiePrefix("magpie/group/smart-split"), "group/smart-split");
  assert.equal(stripMagpiePrefix("kimi-code-cn/k3"), "kimi-code-cn/k3");
  assert.equal(stripMagpiePrefix(undefined), undefined);
});
