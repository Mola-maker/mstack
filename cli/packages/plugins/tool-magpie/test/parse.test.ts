import test from "node:test";
import assert from "node:assert/strict";
import {
  agentIdFromName,
  extractFields,
  extractModel,
  machineOf,
  matchVisibleRoutes,
  parseMagpieAgent,
  parseMagpieLs,
  parseMagpieRoutes,
  visibleRouteNames,
} from "@mola/plugin-tool-magpie";
import { MAGPIE_DSH, MAGPIE_LS, MAGPIE_MODELS_DSH } from "./fixtures.js";

test("parseMagpieLs reads the real `magpie ls` table", () => {
  const rows = parseMagpieLs(MAGPIE_LS);
  assert.equal(rows.length, 23, "all 23 rows are agent rows");
  const codex = rows.find((r) => r.name === "Codex")!;
  assert.equal(codex.id, "codex");
  assert.equal(codex.model, "kimi-code-cn/k3");
  assert.equal(codex.configPath, "~\\.codex\\config.toml");
  assert.deepEqual(codex.fields, { effort: "high" });

  const claude = rows.find((r) => r.name === "Claude Code")!;
  assert.equal(claude.model, undefined, "— means no model pinned");
  assert.deepEqual(claude.fields, { effort: "xhigh" });

  const providerRow = rows.find((r) => r.name === "Claude Desktop")!;
  assert.equal(providerRow.model, "provider", "the `provider` placeholder survives");
});

test("parseMagpieLs maps magpie display names to magpie agent ids", () => {
  const rows = parseMagpieLs(MAGPIE_LS);
  assert.equal(rows.find((r) => r.name === "Kimi Code")!.id, "kimi");
  assert.equal(rows.find((r) => r.name === "Grok Build")!.id, "grok");
  assert.equal(rows.find((r) => r.name === "Antigravity CLI")!.id, "agy");
  assert.equal(rows.find((r) => r.name === "OpenCode")!.id, "opencode");
});

test("parseMagpieLs keeps both DeepSeek Harness profiles apart", () => {
  const rows = parseMagpieLs(MAGPIE_LS);
  const win = rows.find((r) => r.name === "DeepSeek Harness")!;
  const wsl = rows.find((r) => r.name === "DeepSeek Harness · WSL Ubuntu")!;
  assert.equal(win.id, "dsh");
  assert.equal(win.model, "magpie/group/claude-cheap");
  assert.equal(wsl.id, "dsh@wsl:Ubuntu", "suffix matches the id `magpie dsh@wsl:Ubuntu` accepts");
  assert.equal(wsl.model, "magpie/group/smart-split");
  assert.ok(wsl.configPath!.endsWith("cordis.patch.yml"));
  assert.equal(machineOf(wsl.id), "wsl:Ubuntu");
  assert.equal(machineOf(win.id), "local");
});

test("agentIdFromName handles WSL suffixes and unknown names", () => {
  assert.equal(agentIdFromName("DeepSeek Harness · WSL Ubuntu"), "dsh@wsl:Ubuntu");
  assert.equal(agentIdFromName("DeepSeek Harness"), "dsh");
  assert.equal(agentIdFromName("Some New Thing"), "some-new-thing");
});

test("parseMagpieAgent reads the single-agent form", () => {
  const row = parseMagpieAgent(MAGPIE_DSH)!;
  assert.equal(row.name, "DeepSeek Harness");
  assert.equal(row.model, "magpie/group/claude-cheap");
  assert.deepEqual(row.fields, { thinking: "high" });
});

test("extractModel covers the column variants", () => {
  assert.equal(extractModel("magpie/group/smart-split  ·  thinking —"), "magpie/group/smart-split");
  assert.equal(extractModel("kimi-code-cn/k3  ·  effort high"), "kimi-code-cn/k3");
  assert.equal(extractModel("provider —"), "provider");
  assert.equal(extractModel("—  ·  effort —"), undefined);
  assert.equal(extractModel(""), undefined);
});

test("extractFields keeps the real field pairs and drops dashes", () => {
  assert.deepEqual(extractFields("magpie/group/claude-cheap  ·  thinking high"), { thinking: "high" });
  assert.deepEqual(extractFields("—  ·  effort xhigh"), { effort: "xhigh" });
  assert.deepEqual(extractFields("—  ·  thinking —"), {});
});

test("parseMagpieRoutes reads the route rows of `magpie models dsh`", () => {
  const routes = parseMagpieRoutes(MAGPIE_MODELS_DSH);
  assert.ok(routes.includes("group/smart-split"));
  assert.ok(routes.includes("auto/kimi-k3"));
  assert.ok(routes.includes("auto/minimax-m3.1-flash"), "dots survive in route ids");
  assert.ok(routes.includes("deepseek/deepseek-v4-pro"));
  assert.equal(routes.length, 18, "14 group/auto + 4 deepseek rows");
  assert.ok(!routes.some((r) => r.startsWith("no family")), "narrative lines are not routes");
});

test("the visible set is matched against route ids in normalized form", () => {
  const routes = parseMagpieRoutes(MAGPIE_MODELS_DSH);
  const names = visibleRouteNames(MAGPIE_MODELS_DSH);
  assert.ok(names.includes("auto-kimi-k3"), "magpie writes the visible set with dashes");
  const visible = matchVisibleRoutes(names, routes);
  assert.ok(visible.includes("group/smart-split"));
  assert.ok(visible.includes("auto/kimi-k3"));
  assert.ok(visible.includes("auto/minimax-m3.1-flash"), "auto-minimax-m3-1-flash → auto/minimax-m3.1-flash");
  assert.ok(!visible.includes("deepseek/deepseek-v4-pro"), "the bare `deepseek` token is not a route id");
});
