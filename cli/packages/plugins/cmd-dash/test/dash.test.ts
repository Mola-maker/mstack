/**
 * mola dash — snapshot from the registries other plugins already filled in.
 * No live magpie, superagent, or agent process: every probe is a fake.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command, DoctorCheck, Io, PluginContext } from "@mola/plugin-sdk";
import { openStateStore } from "@mola/core";
import { writeProgress, type RunProgress } from "@mola/plugin-sdk";
import plugin, { collectDash, renderDash, watchInterval, type DashSnapshot } from "@mola/plugin-cmd-dash";

function io(json = false): Io & { outLines: string[]; dataValue: unknown } {
  const outLines: string[] = [];
  let dataValue: unknown;
  return {
    json,
    quiet: false,
    traceId: "trace-dash",
    cwd: "/tmp",
    yes: false,
    data(v) {
      dataValue = v;
    },
    out(line) {
      outLines.push(line);
    },
    note() {},
    error() {},
    outLines,
    get dataValue() {
      return dataValue;
    },
  };
}

function ctxOf(opts: {
  agents?: PluginContext["agents"]["list"] extends () => infer R ? R : never;
  superagent?: unknown;
  checks?: DoctorCheck[];
}): { ctx: PluginContext; command: () => Command } {
  let command: Command | undefined;
  const ctx = {
    agents: {
      list: () => opts.agents ?? [],
      get: () => undefined,
      register: () => () => {},
    },
    tools: {
      list: () => [],
      get: (id: string) => (id === "superagent" ? opts.superagent : undefined),
      register: () => () => {},
    },
    doctor: {
      list: () => opts.checks ?? [],
      registerCheck: () => () => {},
    },
    commands: {
      register: (c: Command) => {
        command = c;
        return () => {};
      },
    },
  } as unknown as PluginContext;
  return { ctx, command: () => command! };
}

const healthyChecks: DoctorCheck[] = [
  { id: "magpie.healthcheck", run: () => ({ ok: true, message: "magpie healthcheck ok" }) },
  { id: "tool.rtk", run: () => ({ ok: true, message: "rtk 0.28.0" }) },
  { id: "tool.git", run: () => ({ ok: false, message: "git not found on PATH" }) },
  { id: "tool.gh", run: () => ({ ok: true, message: "gh 2.40 (logged in)" }) },
];

test("watchInterval: default 5, rejects zero, absent means don't watch", () => {
  assert.equal(watchInterval(undefined), undefined);
  assert.equal(watchInterval(false), undefined);
  assert.equal(watchInterval(true), 5);
  assert.equal(watchInterval("2"), 2);
  assert.throws(() => watchInterval("0"), (err: { exitCode?: number }) => err.exitCode === 64);
  assert.throws(() => watchInterval("soon"), (err: { exitCode?: number }) => err.exitCode === 64);
});

test("collectDash reuses agents, the superagent tool and doctor checks", async () => {
  const { ctx } = ctxOf({
    agents: [
      {
        id: "dsh",
        detect: async () => ({ available: true, health: "ok", version: "0.2.1", detail: "wsl:Ubuntu" }),
      },
      {
        id: "omp",
        detect: async () => ({ available: false, health: "broken", detail: "Bun SyntaxError" }),
      },
    ],
    superagent: {
      id: "superagent",
      probe: async () => ({ ok: false }),
      instances: () => [{ name: "layerfs", url: "http://127.0.0.1:3082", port: 3082 }],
      api: () => ({
        state: async () => ({
          setup: { problem: { code: "repositoryUnset", detail: "no repo", place: "github" } },
          load: { running: 0, queued: 2, maxWorkers: 3 },
          paused: true,
          health: {},
        }),
        sources: async () => [{ id: "github", stats: { received: 3 } }, { id: "feishu", stats: { received: 0 } }],
      }),
    },
    checks: healthyChecks,
  });
  const snap = await collectDash(ctx, () => [
    {
      time: "2026-11-06 01:02:03",
      agent: "dsh",
      route: "group/smart-split",
      exit: "0",
      duration: "1.5s",
      runId: "trace-abc-123",
    },
  ]);
  assert.deepEqual(
    snap.agents.map((a) => a.id),
    ["dsh", "omp"],
  );
  assert.equal(snap.superagents[0].paused, true);
  assert.equal(snap.superagents[0].setupOk, false);
  assert.match(snap.superagents[0].problem ?? "", /repositoryUnset/);
  assert.match(snap.superagents[0].fix ?? "", /configure\.mjs/);
  assert.equal(snap.superagents[0].tickets, 3); // messages received across Sources, not the Source count
  assert.equal(snap.superagents[0].queued, 2);
  // failures first in the human screen, not in the json (json keeps check order)
  assert.equal(snap.health[0].id, "magpie.healthcheck");
  assert.equal(snap.health[2].ok, false);

  const text = renderDash(snap).join("\n");
  assert.match(text, /Agents/);
  assert.match(text, /Superagents/);
  assert.match(text, /Recent runs/);
  assert.match(text, /Health/);
  assert.match(text, /dsh/);
  assert.match(text, /Bun SyntaxError/);
  assert.match(text, /repositoryUnset/);
  assert.match(text, /configure\.mjs/);
  assert.match(text, /group\/smart-split/);
  assert.match(text, /tool\.git/);
  assert.doesNotMatch(text, /\x1b\[/, "plain palette emits no ANSI");
  // git failed, so its row is above the passing checks
  assert.ok(text.indexOf("tool.git") < text.indexOf("magpie.healthcheck"));
});

test("dash --json is one snapshot and writes no human lines", async () => {
  const { ctx, command } = ctxOf({ checks: healthyChecks });
  plugin.activate(ctx);
  const handle = io(true);
  const code = await command().handler({ positionals: [], flags: {} }, handle);
  assert.equal(code, 0);
  assert.deepEqual(handle.outLines, []);
  const data = handle.dataValue as DashSnapshot;
  assert.ok(Array.isArray(data.agents));
  assert.ok(Array.isArray(data.superagents));
  assert.ok(Array.isArray(data.runs));
  assert.equal(data.health.length, 4);
});

test("dash --watch off a TTY prints once and returns", async () => {
  const { ctx, command } = ctxOf({ checks: healthyChecks });
  plugin.activate(ctx);
  const handle = io(false);
  const code = await command().handler({ positionals: [], flags: { watch: "30" } }, handle);
  assert.equal(code, 0);
  assert.equal(handle.outLines.filter((l) => l === "mola dash").length, 1);
});

test("dash reads the last runs from the rec-runs state namespace", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mola-dash-"));
  const prev = process.env.MOLA_HOME;
  process.env.MOLA_HOME = home;
  try {
    const store = openStateStore(home);
    store.namespace("mola-rec-runs").set("run:trace-1", {
      runId: "trace-1",
      startedAt: "2026-11-06T01:02:03.000Z",
      agent: "dsh",
      modelRoute: "group/smart-split",
      exitCode: 0,
      durationMs: 1500,
    });
    const { ctx, command } = ctxOf({ checks: healthyChecks });
    plugin.activate(ctx);
    const handle = io(false);
    const code = await command().handler({ positionals: [], flags: {} }, handle);
    assert.equal(code, 0);
    const text = handle.outLines.join("\n");
    assert.match(text, /dsh/);
    assert.match(text, /group\/smart-split/);
    assert.match(text, /1\.5s/);
  } finally {
    if (prev === undefined) delete process.env.MOLA_HOME;
    else process.env.MOLA_HOME = prev;
  }
});

function goRun(cwd: string, id: string, status: RunProgress["status"]): void {
  const now = new Date().toISOString();
  writeProgress({
    schemaVersion: 1,
    id,
    intent: "ship it",
    cwd,
    status,
    startedAt: now,
    updatedAt: now,
    stage: "verify",
    stages: [
      { name: "plan", status: "done", costUsd: 0.1 },
      { name: "verify", status: "running", costUsd: 0.32 },
    ],
    workers: [
      { id: "w1", stage: "verify", status: "working", model: "sonnet", startedAt: now, costUsd: 0.32 },
      { id: "w2", stage: "plan", status: "done", model: "opus", startedAt: now, updatedAt: now, costUsd: 0.1 },
    ],
    costUsd: 0,
    ...(status === "blocked" ? { blocked: { reason: "needs push approval" } } : {}),
  });
}

test("dash shows a Go runs section and --json carries goRuns", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mola-dash-go-"));
  goRun(cwd, "run-a", "running");
  goRun(cwd, "run-b", "blocked");
  goRun(cwd, "run-c", "done");
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    const { ctx, command } = ctxOf({ checks: healthyChecks });
    plugin.activate(ctx);
    const human = io(false);
    await command().handler({ positionals: [], flags: {} }, human);
    const text = human.outLines.join("\n");
    assert.match(text, /Go runs/);
    assert.match(text, /go ▸ verify \(2\/2\) · 1 agent · \$0\.42/);
    assert.match(text, /go ⏸ verify: needs push approval/);
    assert.match(text, /working\s+verify\s+sonnet/);
    assert.match(text, /done\s+plan\s+opus/);
    assert.equal(text.match(/go [▸⏸]/g)?.length, 2, "done run is not listed");

    const js = io(true);
    await command().handler({ positionals: [], flags: {} }, js);
    const data = js.dataValue as DashSnapshot;
    assert.equal(data.goRuns.length, 2);
    assert.deepEqual(data.goRuns.map((r) => r.id).sort(), ["run-a", "run-b"]);
    assert.equal(data.goRuns[0].workers.length, 2);
    assert.equal(data.goRuns[0].workers[0].model.length > 0, true);
  } finally {
    process.chdir(prev);
  }
});
