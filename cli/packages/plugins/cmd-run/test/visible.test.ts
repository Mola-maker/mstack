/**
 * Visible-route tests (ADR-0003 §3 routeFit). The magpie output is a golden
 * fixture (the stable table shape from magpie-help.txt / magpie-routes.txt);
 * the exec is a scripted fake — magpie is never really called.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  matchVisibleRoutes,
  parseMagpieRoutes,
  probeVisibleRoutes,
  probeVisibleRoutesFor,
  visibleRouteNames,
} from "../src/visible.js";
import { makeFakeCtx } from "./fake.js";

/** The shape of `magpie models dsh` (magpie-routes.txt). */
const MAGPIE_MODELS_DSH = `  Routing groups
  group/smart-split             难题给强模型，简单的给便宜模型
  group/forcp                   forcp  low/high
  group/group-2                 无监管  max
  group/claude-cheap            claude-cheap  high
  group/claude-ultra            claude-ultra  low/medium/high
  auto/deepseek-v4-flash        DeepSeek V4 Flash  high
  auto/claude-sonnet-5-5        Claude Sonnet 5.5  low/medium/high/xhigh/max
  auto/kimi-k3                  Kimi K3  low/high
  auto/gemini-3.8-flash         Gemini 3.8 Flash  low/medium/high
  auto/minimax-m3.1-flash       MiniMax-M3.1-Flash  low/high/xhigh
  DeepSeek
  deepseek/deepseek-v4-pro[1M]  DeepSeek V4 Pro [1M]  none/low/high/max
  dsh is shown smart-split, forcp, group-2, claude-cheap, claude-ultra, auto-deepseek-v4-pro, auto-deepseek-v4-flash, auto-kimi-k3, auto-minimax-m3, auto-minimax-m3-1-flash, auto-gemini-3-8-flash, auto-claude-opus-5-5, auto-claude-sonnet-5-5, auto-gpt-6-luna, deepseek
`;

test("visible: the route ids are read from the group/auto rows", () => {
  const routes = parseMagpieRoutes(MAGPIE_MODELS_DSH);
  assert.ok(routes.includes("group/smart-split"));
  assert.ok(routes.includes("auto/kimi-k3"));
  assert.ok(routes.includes("auto/minimax-m3.1-flash"));
  assert.ok(routes.includes("deepseek/deepseek-v4-pro[1M]"));
});

test("visible: the display tokens are matched back to the real route ids", () => {
  const names = visibleRouteNames(MAGPIE_MODELS_DSH);
  assert.ok(names.includes("smart-split"));
  const routes = parseMagpieRoutes(MAGPIE_MODELS_DSH);
  const visible = matchVisibleRoutes(names, routes);
  assert.ok(visible.includes("group/smart-split"));
  assert.ok(visible.includes("auto/kimi-k3"));
  // the lossy display form "auto-minimax-m3-1-flash" maps back to the real id
  assert.ok(visible.includes("auto/minimax-m3.1-flash"));
});

test("visible: the probe reads the agent's visible set", async () => {
  const f = makeFakeCtx({
    exec: async (argv) => {
      assert.equal(argv[1], "models");
      assert.equal(argv[2], "dsh");
      return { code: 0, stdout: MAGPIE_MODELS_DSH, stderr: "" };
    },
  });
  const probe = await probeVisibleRoutes(f.ctx.process, "dsh", { binary: "magpie" });
  assert.equal(probe.unavailable, undefined);
  assert.ok(probe.routes.includes("group/smart-split"));
});

test("visible: an unreachable magpie is reported, never guessed", async () => {
  const f = makeFakeCtx({
    exec: async () => {
      throw new Error("ENOENT: magpie");
    },
  });
  const probe = await probeVisibleRoutes(f.ctx.process, "dsh", { binary: "magpie" });
  assert.equal(probe.routes.length, 0);
  assert.match(probe.unavailable ?? "", /ENOENT/);
});

test("visible: a failing magpie is reported with its stderr", async () => {
  const f = makeFakeCtx({
    exec: async () => ({ code: 1, stdout: "", stderr: "magpie: gateway down" }),
  });
  const probe = await probeVisibleRoutes(f.ctx.process, "dsh", { binary: "magpie" });
  assert.equal(probe.unavailable, "magpie: gateway down");
});

test("visible: the multi-agent probe maps the readable agents only", async () => {
  const f = makeFakeCtx({
    exec: async (argv) => {
      if (argv[2] === "dsh") return { code: 0, stdout: MAGPIE_MODELS_DSH, stderr: "" };
      throw new Error("ENOENT");
    },
  });
  const { map, unavailable } = await probeVisibleRoutesFor(f.ctx.process, ["dsh", "claude"], {
    binary: "magpie",
  });
  assert.ok(map.get("dsh")!.includes("group/smart-split"));
  assert.equal(map.has("claude"), false);
  assert.ok(unavailable.has("claude"));
});

test("probeVisibleRoutes: 'is shown every provider's models' makes every route visible; no line makes none", async () => {
  const table = "  Routing groups\n  group/smart-split             x\n  auto/kimi-k3                  y\n";
  const every = { exec: async () => ({ code: 0, stdout: table + "  codex is shown every provider's models · magpie visible codex <family>,… narrows it\n", stderr: "" }) } as never;
  assert.deepEqual((await probeVisibleRoutes(every, "codex", { binary: "magpie" })).routes, ["group/smart-split", "auto/kimi-k3"]);
  const none = { exec: async () => ({ code: 0, stdout: table, stderr: "" }) } as never;
  assert.deepEqual((await probeVisibleRoutes(none, "claude", { binary: "magpie" })).routes, []);
});
