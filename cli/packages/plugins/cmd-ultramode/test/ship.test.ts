/**
 * Ship tests for ultramode (unit 4): the real `ship <slug>` flow — branch
 * + commit on `ultramode/<slug>`, prepared-PR fallback without a grant,
 * duplicate-PR stop, per-action ship gates, and the CI poll verdicts
 * (shipped / blocked / running). Exec is scripted git/gh; no real process
 * ever spawns and no real PR is created.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MolaEvents, PolicyDenial } from "@mola/plugin-sdk";
import plugin, { runShip, slugifyGoal } from "../src/index.js";
import { parseChecks, parsePrCreateOutput, parsePrListJson, renderCommitMessage, renderPrBody, parseReview } from "../src/ship.js";
import { errOf, makeFakeCtx, makeIo, type FakeCtx } from "./fake.js";

const SLUG = "ship-the-fix";
const GOAL = "ship the fix";
const BRANCH = `ultramode/${SLUG}`;
const SHA = "abc1234deadbeef";
const PR_URL = "https://github.com/acme/repo/pull/42";
const REVIEW_PATH = `/fake/ws/.mstack/reviews/${SLUG}.md`;
const GOAL_PATH = `/fake/ws/.mstack/goals/${SLUG}.md`;
const STATE_PATH = `/fake/ws/.mstack/goals/${SLUG}.state.json`;

function goodReview(): string {
  return [
    `# Review: ${SLUG}`,
    "",
    "Reviewer: m-reviewer",
    "",
    "## Findings",
    "",
    "- none blocking",
    "",
    "repro: pnpm -r test → 480 pass, 5 skipped, 0 fail",
    "",
    "APPROVE",
    "",
  ].join("\n");
}

function goalFile(): string {
  return [
    `# Goal: ${GOAL}`,
    "",
    "## Sub-goals (ordered by risk)",
    "",
    "1. [ ] ship it",
    "",
    "## Amendments",
    "",
    "(none)",
    "",
    "## Closeout",
    "",
    "(not yet closed — the loop is still running)",
    "",
  ].join("\n");
}

interface Scenario {
  branchExists?: boolean;
  currentBranch?: string;
  checkoutCode?: number;
  commitCode?: number;
  commitOut?: string;
  pushCode?: number;
  prList?: string;
  prCreateOut?: string;
  checks?: string | ((call: number) => string);
}

function scriptedExec(scenario: Scenario = {}) {
  let checksCall = 0;
  return async (argv: string[]) => {
    const [cmd, sub, ...rest] = argv;
    if (cmd === "git" && sub === "rev-parse" && rest[0] === "--abbrev-ref") {
      return { code: 0, stdout: `${scenario.currentBranch ?? "feature-x"}\n`, stderr: "" };
    }
    if (cmd === "git" && sub === "rev-parse" && rest[0] === "--verify") {
      return { code: scenario.branchExists ? 0 : 1, stdout: "", stderr: "" };
    }
    if (cmd === "git" && sub === "checkout") {
      return { code: scenario.checkoutCode ?? 0, stdout: "", stderr: scenario.checkoutCode ? "fatal: a branch named 'ultramode/ship-the-fix' already exists" : "" };
    }
    if (cmd === "git" && sub === "add") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "git" && sub === "commit") {
      return { code: scenario.commitCode ?? 0, stdout: scenario.commitOut ?? "[ultramode/ship-the-fix abc1234] ship the fix\n", stderr: "" };
    }
    if (cmd === "git" && sub === "rev-parse" && rest[0] === "HEAD") {
      return { code: 0, stdout: `${SHA}\n`, stderr: "" };
    }
    if (cmd === "git" && sub === "push") {
      return { code: scenario.pushCode ?? 0, stdout: "", stderr: scenario.pushCode ? "error: failed to push" : "" };
    }
    if (cmd === "gh" && sub === "pr" && rest[0] === "list") {
      return { code: 0, stdout: scenario.prList ?? "[]", stderr: "" };
    }
    if (cmd === "gh" && sub === "pr" && rest[0] === "create") {
      return { code: 0, stdout: `${scenario.prCreateOut ?? PR_URL}\n`, stderr: "" };
    }
    if (cmd === "gh" && sub === "pr" && rest[0] === "checks") {
      checksCall++;
      const out = typeof scenario.checks === "function" ? scenario.checks(checksCall) : (scenario.checks ?? "build pass\ntest pass\n");
      return { code: 0, stdout: out, stderr: "" };
    }
    throw new Error(`unscripted exec: ${argv.join(" ")}`);
  };
}

function activate(scenario: Scenario = {}) {
  const f = makeFakeCtx({ exec: scriptedExec(scenario) });
  const seenYes: Array<boolean | undefined> = [];
  f.ctx.events.hook(MolaEvents.ToolBefore, (value) => {
    const call = (value ?? {}) as { argv?: string[]; yes?: boolean };
    const cmdline = (call.argv ?? []).join(" ");
    const denied = /\bgh\s+pr\s+create\b/.test(cmdline) || /\bgit\s+push\b/.test(cmdline);
    if (!denied) return value;
    seenYes.push(call.yes);
    if (call.yes) return value;
    throw new PolicyDenial("fake classifier: outward call requires approval");
  });
  plugin.activate(f.ctx);
  const cmd = f.commands.find((c) => c.path.join(" ") === "ultramode")!;
  assert.ok(cmd, "ultramode command is registered");
  f.files.set(REVIEW_PATH, goodReview());
  f.files.set(GOAL_PATH, goalFile());
  f.kv.lastOutcome = {
    slug: SLUG,
    goal: GOAL,
    outcome: "done",
    status: "done",
    exitCode: 0,
    agent: "dsh",
    modelRoute: "group/smart-split",
    at: "2026-11-11T00:00:00.000Z",
  };
  return { ...f, cmd, seenYes };
}

async function grant(f: ReturnType<typeof activate>) {
  const io = makeIo();
  assert.equal(await f.cmd.handler({ positionals: ["grant", SLUG], flags: {} }, io), 0);
}

function shipOf(io: ReturnType<typeof makeIo>) {
  return (io.dataValue as Record<string, unknown>).ship as Record<string, unknown>;
}

test("ultramode ship: happy path ends shipped with the PR URL recorded", async () => {
  const f = activate();
  await grant(f);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship", SLUG], flags: {} }, io);
  assert.equal(code, 0);
  const ship = shipOf(io);
  assert.equal(ship.verdict, "shipped");
  assert.equal(ship.prUrl, PR_URL);
  assert.equal(ship.prNumber, 42);
  assert.equal(ship.branch, BRANCH);
  assert.equal(ship.commit, SHA);
  assert.equal(ship.pushed, true);
  assert.deepEqual(f.seenYes, [true, true], "push and pr-create each passed the ship gate with grant-derived yes");
  const push = f.execCalls.find((c) => c.argv.join(" ") === `git push -u origin ${BRANCH}`);
  assert.ok(push, "pushed the ultramode branch");
  const create = f.execCalls.find((c) => c.argv[0] === "gh" && c.argv[2] === "create")!;
  assert.ok(create, "created the PR");
  assert.equal(create.argv[create.argv.indexOf("--title") + 1], GOAL);
  const body = create.argv[create.argv.indexOf("--body") + 1];
  assert.match(body, /## Goal/);
  assert.match(body, /Reviewer: m-reviewer — APPROVE/);
  assert.match(body, /repro: pnpm -r test/);
  assert.match(body, /Agent: dsh/);
  assert.match(body, /Route: group\/smart-split/);
  assert.match(body, /review: passed/);
  assert.doesNotMatch(body, /generated (by|with) ai|ai[- ]generated|claude|chatgpt/i);
  const state = JSON.parse(f.files.get(STATE_PATH)!);
  assert.equal(state.ship.verdict, "shipped");
  assert.equal(state.ship.prUrl, PR_URL);
  assert.match(f.files.get(GOAL_PATH)!, /ship: shipped/);
  assert.match(io.outLines.join("\n"), new RegExp(`shipped — ${PR_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("ultramode ship: no grant ends prepared only with zero push/pr-create calls", async () => {
  const f = activate();
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship", SLUG], flags: {} }, io);
  assert.equal(code, 0);
  const ship = shipOf(io);
  assert.equal(ship.verdict, "prepared");
  assert.equal(ship.pushed, false);
  assert.equal(ship.commit, SHA);
  assert.equal(ship.branch, BRANCH);
  assert.ok(f.execCalls.every((c) => c.argv[0] !== "gh"), "no gh call ran without a grant");
  assert.ok(!f.execCalls.some((c) => c.argv[1] === "push"), "no git push ran without a grant");
  assert.deepEqual(f.seenYes, [], "the classifier was never reached without a grant");
  const prBodyPath = `/fake/ws/.mstack/goals/${SLUG}.pr.md`;
  assert.equal(ship.prBodyPath, prBodyPath);
  const body = f.files.get(prBodyPath)!;
  assert.match(body, /## Goal/);
  assert.match(body, /ship: no grant — prepared PR only/);
  assert.equal(JSON.parse(f.files.get(STATE_PATH)!).ship.verdict, "prepared");
  assert.match(io.outLines.join("\n"), /prepared only — committed .* on ultramode\/ship-the-fix, nothing pushed/);
});

test("ultramode ship: nothing-to-commit still prepares (HEAD is the commit)", async () => {
  const f = activate({ commitCode: 1, commitOut: "nothing to commit, working tree clean\n" });
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship", SLUG], flags: {} }, io);
  assert.equal(code, 0);
  assert.equal(shipOf(io).verdict, "prepared");
  assert.equal(shipOf(io).commit, SHA);
});

test("ultramode ship: review-gate denial ends at 77 with no exec calls", async () => {
  const f = activate();
  f.files.delete(REVIEW_PATH);
  await grant(f);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship", SLUG], flags: {} }, io);
  assert.equal(code, 77);
  assert.equal(shipOf(io).verdict, "denied");
  assert.equal(shipOf(io).gate, "review");
  assert.deepEqual(f.execCalls, [], "no git/gh ran before the review gate passed");
  assert.match(f.files.get(GOAL_PATH)!, /gate denied: review/);
});

test("ultramode ship: duplicate PR reports the existing URL and runs no pr-create", async () => {
  const f = activate({ prList: JSON.stringify([{ number: 7, url: "https://github.com/acme/repo/pull/7" }]) });
  await grant(f);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship", SLUG], flags: {} }, io);
  assert.equal(code, 0);
  const ship = shipOf(io);
  assert.equal(ship.verdict, "duplicate");
  assert.equal(ship.prUrl, "https://github.com/acme/repo/pull/7");
  assert.equal(ship.prNumber, 7);
  assert.ok(!f.execCalls.some((c) => c.argv[0] === "gh" && c.argv[2] === "create"), "no pr-create ran");
  assert.ok(!f.execCalls.some((c) => c.argv[1] === "push"), "no push ran for an existing PR");
});

test("ultramode ship: failing checks end blocked naming the failing check", async () => {
  const f = activate({ checks: "build pass\nlint fail\n" });
  await grant(f);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship", SLUG], flags: {} }, io);
  assert.equal(code, 1);
  const ship = shipOf(io);
  assert.equal(ship.verdict, "blocked");
  assert.deepEqual(ship.failing, ["lint"]);
  assert.equal(ship.prUrl, PR_URL);
  assert.match(io.outLines.join("\n"), /blocked — .* \(failing: lint\)/);
  assert.equal(JSON.parse(f.files.get(STATE_PATH)!).ship.verdict, "blocked");
});

test("ultramode ship: checks still running at the cap end running with the PR URL", async () => {
  const f = activate({ checks: "build pending\ntest pending\n" });
  await grant(f);
  const io = makeIo();
  const code = await runShip(f.ctx, io, SLUG, { pollIntervalMs: 5, pollTimeoutMs: 20 });
  assert.equal(code, 1);
  const ship = shipOf(io);
  assert.equal(ship.verdict, "running");
  assert.equal(ship.prUrl, PR_URL);
  assert.match(io.outLines.join("\n"), /running — .*pull\/42/);
});

test("ultramode ship: branch cannot be created from main — stops, never pushes main", async () => {
  const f = activate({ currentBranch: "main", checkoutCode: 1 });
  await grant(f);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship", SLUG], flags: {} }, io);
  assert.equal(code, 1);
  const ship = shipOf(io);
  assert.equal(ship.verdict, "failed");
  assert.equal(ship.stage, "branch");
  assert.match(String(ship.reason), /refusing to push main/);
  assert.ok(!f.execCalls.some((c) => c.argv[1] === "push"), "no push ran");
  assert.match(f.files.get(GOAL_PATH)!, /ship failed: branch/);
});

test("ultramode ship: push failure stops with a closeout line and no PR create", async () => {
  const f = activate({ pushCode: 1 });
  await grant(f);
  const io = makeIo();
  const code = await f.cmd.handler({ positionals: ["ship", SLUG], flags: {} }, io);
  assert.equal(code, 1);
  const ship = shipOf(io);
  assert.equal(ship.verdict, "failed");
  assert.equal(ship.stage, "push");
  assert.ok(!f.execCalls.some((c) => c.argv[0] === "gh" && c.argv[2] === "create"), "no pr-create ran after a failed push");
  assert.match(f.files.get(GOAL_PATH)!, /ship failed: push/);
});

test("ultramode ship: bare ship with no slug is a usage error", async () => {
  const f = activate();
  const io = makeIo();
  await assert.rejects(
    f.cmd.handler({ positionals: ["ship"], flags: {} }, io),
    (e: unknown) => {
      const err = errOf(e);
      assert.equal(err.code, "USAGE_ERROR");
      assert.equal(err.exitCode, 64);
      return true;
    },
  );
});

test("ultramode ship: slug is kebab-case and truncated", () => {
  assert.equal(slugifyGoal("Fix the flaky test in CI!!"), "fix-the-flaky-test-in-ci");
});

test("ship parsers: checks table, PR list, PR create output", () => {
  assert.deepEqual(parseChecks("build pass\ntest pass\n"), { complete: true, failing: [], running: [] });
  assert.deepEqual(parseChecks("build pass\nlint fail\n"), { complete: false, failing: ["lint"], running: [] });
  assert.deepEqual(parseChecks("build pending\n"), { complete: false, failing: [], running: ["build"] });
  assert.deepEqual(parseChecks("No checks reported"), { complete: true, failing: [], running: [] });
  assert.deepEqual(parseChecks("All checks were successful"), { complete: true, failing: [], running: [] });
  assert.deepEqual(parsePrListJson("[]"), undefined);
  assert.deepEqual(parsePrListJson(JSON.stringify([{ number: 7, url: "https://github.com/acme/repo/pull/7" }])), {
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
  });
  assert.throws(() => parsePrListJson("not json"), /Unexpected token/);
  assert.deepEqual(parsePrCreateOutput("https://github.com/acme/repo/pull/42\n"), {
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
  });
  assert.equal(parsePrCreateOutput("no url here"), undefined);
});

test("ship rendering: PR body and commit message carry goal, review, routing, gates", () => {
  const review = parseReview(goodReview());
  assert.equal(review.reviewer, "m-reviewer");
  assert.equal(review.verdict, "APPROVE");
  assert.match(review.evidence, /repro: pnpm -r test/);
  const body = renderPrBody({ goal: GOAL, outcome: "done", review, agent: "dsh", modelRoute: "group/smart-split", granted: true });
  assert.match(body, /## Goal\n\nship the fix/);
  assert.match(body, /Agent: dsh/);
  assert.match(body, /ship: passed \(recorded ultramode grant\)/);
  const msg = renderCommitMessage({ goal: GOAL, outcome: "done", review, granted: false });
  assert.equal(msg.split("\n")[0], GOAL);
  assert.match(msg, /Review: m-reviewer APPROVE/);
  assert.match(msg, /ship prepared only/);
});

export type { FakeCtx };
