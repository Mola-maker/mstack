/**
 * RSI loop tests for ultramode (unit 5): rounds, saturation, the round
 * cap, interrogation dropping uncited claims, the judge pass, the grill
 * (at most 3 questions with defaults, recorded as assumptions), counters
 * in the state file, and the closeout on every exit path. The agents are
 * scripted fakes; no real process is ever spawned.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchesAnyGlob } from "@mola/core";
import plugin, { slugifyGoal } from "../src/index.js";
import {
  RSI_DEFAULT_ROUND_CAP,
  grillQuestions,
  interrogateClaims,
  parseClaims,
  runRsiLoop,
  type PassResult,
  type RsiRunPass,
} from "../src/rsi.js";
import { makeFakeCtx, makeIo, type FakeAgent } from "./fake.js";

const SLUG = "ship-the-fix";
const GOAL = "ship the fix";
const GOAL_PATH = `/fake/ws/.mstack/goals/${SLUG}.md`;
const STATE_PATH = `/fake/ws/.mstack/goals/${SLUG}.state.json`;

function seedGoal(f: { files: Map<string, string> }): void {
  const at = new Date().toISOString();
  f.files.set(
    GOAL_PATH,
    [
      `# Goal: ${GOAL}`,
      "",
      `- Created: ${at}`,
      "- Budget: attempt cap 1 per task, min rounds 1, round cap 1, token budget none",
      "- Stop conditions: the single routed pass ends",
      "",
      "## Sub-goals (ordered by risk)",
      "",
      "1. [ ] Run the goal once",
      "",
      "## Checkpoints",
      "",
      "| ts | decision | why | evidence | result |",
      "|----|----------|-----|----------|--------|",
      `| ${at} | goal created | ultramode run started | mola ultramode "${GOAL}" | active |`,
      "",
      "## Amendments",
      "",
      "(none)",
      "",
      "## Closeout",
      "",
      "(not yet closed — the loop is still running)",
      "",
    ].join("\n"),
  );
  f.files.set(
    STATE_PATH,
    JSON.stringify(
      {
        slug: SLUG,
        status: "active",
        startCommit: null,
        minRounds: 1,
        rounds: 1,
        tokensUsed: 0,
        budgetPct: 0,
        failures: {},
        lastProgressAt: null,
        updatedAt: at,
      },
      null,
      2,
    ) + "\n",
  );
}

function activate(agents: FakeAgent[] = []) {
  const f = makeFakeCtx({ agents });
  plugin.activate(f.ctx);
  const cmd = f.commands.find((c) => c.path.join(" ") === "ultramode")!;
  assert.ok(cmd, "ultramode command is registered");
  return { ...f, cmd };
}

/** Scripted pass: research channels answer from `byChannel`, the judge from `judgeText`. */
function scriptedPass(
  byChannel: (channel: string, round: number) => string,
  opts: { judgeText?: (round: number) => string; failAt?: { round: number; channel: string; exitCode: number } } = {},
): RsiRunPass {
  return async (prompt, channel, round) => {
    void prompt;
    if (opts.failAt && opts.failAt.round === round && opts.failAt.channel === channel) {
      return { exitCode: opts.failAt.exitCode, finalText: "boom" };
    }
    if (channel === "judge") {
      return { exitCode: 0, finalText: opts.judgeText ? opts.judgeText(round) : "no drops" };
    }
    return { exitCode: 0, finalText: byChannel(channel, round) };
  };
}

const SHARED_FINDINGS = (channel: string): string =>
  channel === "web"
    ? "- Shared claim — https://example.com/a — 2026-11-11"
    : channel === "docs"
      ? "- Shared claim — https://docs.example.com/a — 2026-11-11\n- Other claim — https://github.com/x/y — 2026-11-11"
      : "- Other claim — https://github.com/x/y — 2026-11-11";

test("rsi: parseClaims keeps the source; interrogateClaims drops the uncited and confirms the cross-validated", () => {
  const text = [
    "- Shared claim — https://example.com/a — 2026-11-11",
    "- Guessed claim",
    "- Other claim — .mstack/runs/abc/decision.json",
  ].join("\n");
  const claims = parseClaims(text, "web");
  assert.equal(claims.length, 3);
  assert.equal(claims[1].source, "");
  const { surviving, dropped, newFindings } = interrogateClaims(claims, new Set());
  assert.equal(surviving.length, 2);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].text, "Guessed claim");
  assert.match(dropped[0].reason, /no cited file, line, or test output/);
  assert.equal(newFindings, 2);
  // a second channel citing the same claim confirms it
  const again = interrogateClaims(parseClaims("- Shared claim — https://docs.example.com/a", "docs"), new Set());
  assert.equal(again.surviving.length, 1);
  const merged = interrogateClaims(
    [...parseClaims(text, "web"), ...parseClaims("- Shared claim — https://docs.example.com/a", "docs")],
    new Set(),
  );
  assert.equal(merged.surviving.find((c) => c.text === "Shared claim")!.confirmed, true);
  assert.equal(merged.surviving.find((c) => c.text === "Other claim")!.confirmed, false);
});

test("rsi: grill asks at most 3 questions, each with a recommended default", () => {
  const questions = grillQuestions(GOAL);
  assert.ok(questions.length <= 3);
  assert.equal(questions.length, 3);
  for (const q of questions) {
    assert.ok(q.question.length > 0);
    assert.ok(q.default.length > 0);
  }
});

test("rsi: saturation stops the loop with no further rounds, counters land in the state file, closeout is written", async () => {
  const f = activate();
  seedGoal(f);
  const io = makeIo();
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: scriptedPass(SHARED_FINDINGS),
  });
  assert.equal(result.stopReason, "saturated");
  assert.equal(result.rounds, 2);
  assert.equal(result.findings, 2);
  assert.equal(result.dropped, 0);
  assert.equal(result.exitCode, 0);

  const round1 = f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-1.md");
  const round2 = f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-2.md");
  assert.ok(round1, "round 1 evidence is written");
  assert.ok(round2, "round 2 evidence is written");
  assert.match(round1!, /Shared claim/);
  assert.match(round1!, /confirmed/);
  assert.match(round2!, /stop: saturated/);
  assert.equal(f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-3.md"), undefined);

  const state = JSON.parse(f.files.get(STATE_PATH)!);
  assert.equal(state.rsi.stopReason, "saturated");
  assert.equal(state.rsi.rounds, 2);
  assert.equal(state.rsi.findings, 2);
  assert.deepEqual(state.rsi.newFindingsByRound, [2, 0]);
  assert.equal(state.rsi.tokensUsed, 0);
  assert.equal(state.rsi.budgetTokens, null);
  assert.equal(state.rsi.roundCap, RSI_DEFAULT_ROUND_CAP);
  assert.deepEqual(state.rsi.channels, ["web", "docs", "github"]);
  assert.equal(state.status, "done");

  const goal = f.files.get(GOAL_PATH)!;
  assert.match(goal, /- status: done/);
  assert.match(goal, /RSI saturated after 2 round/);
  assert.match(goal, /## Assumptions \(grill, round 1\)/);
  const questions = goal.match(/^- Q: /gm) ?? [];
  assert.ok(questions.length <= 3);
  assert.equal(questions.length, 3);
  assert.match(goal, /Default assumed:/);
  assert.match(goal, /attackable premises, not settled facts/);
  assert.match(goal, /## Research findings/);
  assert.match(goal, /refine round 1: 2 new finding/);
});

test("rsi: a judge drop in round 2 removes the round-1 claim from findings", async () => {
  const f = activate();
  seedGoal(f);
  const io = makeIo();
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: scriptedPass(SHARED_FINDINGS, { judgeText: (round) => (round === 2 ? "- DROP: Shared claim" : "no drops") }),
  });
  assert.equal(result.stopReason, "saturated");
  assert.equal(result.rounds, 2);
  assert.equal(result.findings, 1, "the claim the judge dropped in round 2 no longer counts");
  assert.equal(JSON.parse(f.files.get(STATE_PATH)!).rsi.findings, 1);
  const round2 = f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-2.md")!;
  assert.match(round2, /Shared claim — dropped by the judge pass/);
  assert.doesNotMatch(round2.split("## Findings (surviving)")[1].split("## Dropped")[0], /Shared claim/);
});

test("rsi: a checkpoint row still lands when the goal file has no ## Amendments anchor", async () => {
  const f = activate();
  seedGoal(f);
  const goal = f.files.get(GOAL_PATH)!;
  f.files.set(GOAL_PATH, goal.replace("\n\n## Amendments\n\n(none)\n", "\n"));
  assert.doesNotMatch(f.files.get(GOAL_PATH)!, /## Amendments/);
  const io = makeIo();
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: scriptedPass(SHARED_FINDINGS),
    roundCap: 1,
  });
  assert.equal(result.stopReason, "round-cap");
  assert.match(f.files.get(GOAL_PATH)!, /refine round 1: 2 new finding/, "the row is appended at the end instead of dropped");
});

test("rsi: round cap stops the loop at the cap when every round adds a finding", async () => {
  const f = activate();
  seedGoal(f);
  const io = makeIo();
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: scriptedPass((channel, round) =>
      channel === "web" ? `- Round ${round} claim — https://example.com/r${round}` : "",
    ),
    roundCap: 3,
  });
  assert.equal(result.stopReason, "round-cap");
  assert.equal(result.rounds, 3);
  assert.equal(result.findings, 3);
  assert.deepEqual(JSON.parse(f.files.get(STATE_PATH)!).rsi.newFindingsByRound, [1, 1, 1]);
  assert.ok(f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-3.md"));
  assert.equal(f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-4.md"), undefined);
  assert.match(f.files.get(GOAL_PATH)!, /RSI stopped at the round cap \(3\)/);
});

test("rsi: --rounds 1 caps the loop at one round", async () => {
  const f = activate();
  seedGoal(f);
  const io = makeIo();
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: scriptedPass(SHARED_FINDINGS),
    roundCap: 1,
  });
  assert.equal(result.stopReason, "round-cap");
  assert.equal(result.rounds, 1);
});

test("rsi: a claim without cited evidence is dropped by interrogation and never kept as fact", async () => {
  const f = activate();
  seedGoal(f);
  const io = makeIo();
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: scriptedPass((channel) =>
      channel === "web"
        ? "- Shared claim — https://example.com/a\n- Guessed claim"
        : "- Shared claim — https://docs.example.com/a",
    ),
  });
  assert.equal(result.stopReason, "saturated");
  assert.equal(result.findings, 1);
  // dropped counts per round: the same uncited claim is dropped in round 1 and again in round 2
  assert.equal(result.dropped, 2);
  const round1 = f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-1.md")!;
  assert.match(round1, /## Dropped \(no cited file, line, or test output\)/);
  assert.match(round1, /Guessed claim — no cited file, line, or test output/);
  const findingsSection = round1.split("## Findings (surviving)")[1].split("## Dropped")[0];
  assert.doesNotMatch(findingsSection, /Guessed claim/);
  assert.doesNotMatch(f.files.get(GOAL_PATH)!, /Guessed claim/);
});

test("rsi: the judge pass drops a claim and the drop is recorded", async () => {
  const f = activate();
  seedGoal(f);
  const io = makeIo();
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: scriptedPass(SHARED_FINDINGS, { judgeText: () => "- DROP: Shared claim" }),
  });
  assert.equal(result.stopReason, "saturated");
  assert.equal(result.findings, 1);
  assert.equal(result.dropped, 2);
  const round1 = f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-1.md")!;
  assert.match(round1, /## Dropped by the judge/);
  assert.match(round1, /Shared claim — dropped by the judge pass/);
});

test("rsi: a failed research round stops the loop with a closeout and no retry", async () => {
  const f = activate();
  seedGoal(f);
  const io = makeIo();
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: scriptedPass(SHARED_FINDINGS, { failAt: { round: 1, channel: "docs", exitCode: 3 } }),
  });
  assert.equal(result.stopReason, "failed");
  assert.equal(result.rounds, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-1.md"), undefined);
  assert.match(f.files.get(GOAL_PATH)!, /- status: failed/);
  assert.match(f.files.get(GOAL_PATH)!, /RSI stopped: a research round failed/);
  assert.equal(JSON.parse(f.files.get(STATE_PATH)!).rsi.stopReason, "failed");
});

test("rsi: a denied route stops at 77 with a closeout", async () => {
  const f = activate();
  seedGoal(f);
  const io = makeIo();
  const deniedPass: RsiRunPass = async () => {
    const err = new Error("route banned") as Error & { code: string; exitCode: number };
    err.code = "ROUTE_BANNED";
    err.exitCode = 77;
    throw err;
  };
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: deniedPass,
  });
  assert.equal(result.stopReason, "denied");
  assert.equal(result.exitCode, 77);
  assert.match(f.files.get(GOAL_PATH)!, /- status: failed/);
  assert.match(f.files.get(GOAL_PATH)!, /RSI stopped: a routed pass was denied/);
});

test("rsi: a failing judge never blocks the loop — the evidence verdict stands and the skip is recorded", async () => {
  const f = activate();
  seedGoal(f);
  const io = makeIo();
  const pass: RsiRunPass = async (_prompt, channel) => {
    if (channel === "judge") return { exitCode: 2, finalText: "judge down" };
    return { exitCode: 0, finalText: SHARED_FINDINGS(channel) };
  };
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: pass,
  });
  assert.equal(result.stopReason, "saturated");
  assert.equal(result.findings, 2);
  assert.match(
    f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-1.md")!,
    /judge: skipped \(the judge pass failed/,
  );
});

test("ultramode rsi: the subcommand routes every pass through the router and saturates", async () => {
  // 3 channels + 1 judge per round, 2 rounds: one scripted result per
  // call (the fake throws on exhaustion rather than repeating a result).
  const roundText = "- Shared claim — https://example.com/a\n- Other claim — https://github.com/x/y";
  const agent: FakeAgent = {
    id: "dsh",
    results: [
      { exitCode: 0, finalText: roundText },
      { exitCode: 0, finalText: roundText },
      { exitCode: 0, finalText: roundText },
      { exitCode: 0, finalText: "no drops" },
      { exitCode: 0, finalText: roundText },
      { exitCode: 0, finalText: roundText },
      { exitCode: 0, finalText: roundText },
      { exitCode: 0, finalText: "no drops" },
    ],
    calls: [],
  };
  const f = activate([agent]);
  seedGoal(f);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["rsi", SLUG], flags: {} }, io);
  assert.equal(code, 0);
  assert.equal(slugifyGoal(GOAL), SLUG);
  const data = io.dataValue as Record<string, unknown>;
  const rsi = data.rsi as Record<string, unknown>;
  assert.equal(rsi.stopReason, "saturated");
  assert.equal(rsi.rounds, 2);
  assert.equal(rsi.findings, 2);
  // 3 channels + 1 judge per round, 2 rounds
  assert.equal(agent.calls.length, 8);
  assert.ok(f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-2.md"));
  assert.match(f.files.get(GOAL_PATH)!, /- status: done/);
  const state = JSON.parse(f.files.get(STATE_PATH)!);
  assert.equal(state.rsi.stopReason, "saturated");
});

test("ultramode rsi: no goal file is a usage error", async () => {
  const f = activate([{ id: "dsh", results: [{ exitCode: 0, finalText: "ok" }], calls: [] }]);
  const io = makeIo();
  await assert.rejects(
    f.cmd.handler({ positionals: ["rsi", "missing-goal"], flags: {} }, io),
    (e: unknown) => {
      const err = e as { code: string; exitCode: number; message: string };
      assert.equal(err.code, "USAGE_ERROR");
      assert.equal(err.exitCode, 64);
      assert.match(err.message, /no goal file/);
      return true;
    },
  );
});

test("ultramode rsi: a configured budget cap is recorded and never fires (the router reports no tokens)", async () => {
  const f = activate();
  seedGoal(f);
  const io = makeIo();
  const pass: RsiRunPass = async (_prompt: string, channel: string): Promise<PassResult> => {
    if (channel === "judge") return { exitCode: 0, finalText: "no drops" };
    return { exitCode: 0, finalText: SHARED_FINDINGS(channel) };
  };
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: pass,
    budgetTokens: 1000,
  });
  assert.equal(result.stopReason, "saturated");
  const state = JSON.parse(f.files.get(STATE_PATH)!);
  assert.equal(state.rsi.budgetTokens, 1000);
  assert.equal(state.rsi.tokensUsed, 0);
  assert.match(f.files.get(GOAL_PATH)!, /token accounting unavailable/);
});

test("rsi: the RSI loop writes only under the manifest fs.write globs (round files live under .mstack/research/)", async () => {
  // The manifest sits at the package root; the compiled test is several
  // levels deeper than the source, so walk up until it is found.
  let dir = new URL(".", import.meta.url);
  let manifestText: string | undefined;
  for (let i = 0; i < 6 && manifestText === undefined; i++) {
    try {
      manifestText = await readFile(new URL("mola-plugin.json", dir), "utf8");
    } catch {
      dir = new URL("..", dir);
    }
  }
  assert.ok(manifestText, "mola-plugin.json found above the test file");
  const manifest = JSON.parse(manifestText) as { permissions: { "fs.write": string[]; "fs.read": string[] } };
  const writeGlobs = manifest.permissions["fs.write"];
  const readGlobs = manifest.permissions["fs.read"];
  assert.ok(writeGlobs.includes("**/.mstack/research/**"), "the manifest must allow writing round files");
  assert.ok(readGlobs.includes("**/.mstack/research/**"), "the manifest must allow reading round files");
  const f = activate();
  seedGoal(f);
  // Enforce the manifest globs on the fake fs with core's own matcher,
  // the way core's makeFsService does in production: a write or read
  // outside the globs throws instead of silently landing.
  const realWrite = f.ctx.fs.writeFile.bind(f.ctx.fs);
  f.ctx.fs.writeFile = (p: string, data: string) => {
    if (!matchesAnyGlob(p, writeGlobs)) throw new Error(`mola-cmd-ultramode: fs.write does not allow "${p}"`);
    realWrite(p, data);
  };
  const realRead = f.ctx.fs.readFile.bind(f.ctx.fs);
  f.ctx.fs.readFile = (p: string) => {
    if (!matchesAnyGlob(p, readGlobs)) throw new Error(`mola-cmd-ultramode: fs.read does not allow "${p}"`);
    return realRead(p);
  };
  const io = makeIo();
  const result = await runRsiLoop(f.ctx, io, {
    slug: SLUG,
    goal: GOAL,
    cwd: "/fake/ws",
    runPass: scriptedPass(SHARED_FINDINGS),
  });
  assert.equal(result.stopReason, "saturated");
  assert.ok(f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-1.md"), "round 1 evidence is written");
  assert.ok(f.files.get("/fake/ws/.mstack/research/ship-the-fix/round-2.md"), "round 2 evidence is written");
});
