/**
 * Gate tests for ultramode (unit 3): the review gate inspects the evidence
 * file, the ship gate needs a recorded grant (never --yes), and grant/revoke
 * round-trips. A fake classifier-like listener on mola.tool.before mirrors
 * policy-approval: it denies push / pr-create unless the waterfall value
 * carries yes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MolaEvents, PolicyDenial } from "@mola/plugin-sdk";
import plugin, { slugifyGoal } from "../src/index.js";
import { grantKey } from "../src/gates.js";
import { makeFakeCtx, makeIo, type FakeAgent } from "./fake.js";

const SLUG = "ship-the-fix";
const REVIEW_PATH = `/fake/ws/.mstack/reviews/${SLUG}.md`;

function goodReview(reviewer = "m-reviewer", evidence = "repro: pnpm -r test → 480 pass, 5 skipped, 0 fail"): string {
  return [
    `# Review: ${SLUG}`,
    "",
    `Reviewer: ${reviewer}`,
    "",
    "## Findings",
    "",
    "- none blocking",
    "",
    evidence,
    "",
    "APPROVE",
    "",
  ].join("\n");
}

function activate(agents: FakeAgent[] = []) {
  const f = makeFakeCtx({ agents });
  const seenYes: Array<boolean | undefined> = [];
  f.ctx.events.hook(MolaEvents.ToolBefore, (value) => {
    const call = (value ?? {}) as { argv?: string[]; yes?: boolean };
    const cmdline = (call.argv ?? []).join(" ");
    const denied = /\bgh\s+pr\s+create\b/.test(cmdline) || /\bgit\s+push\b/.test(cmdline);
    if (!denied) return value;
    seenYes.push(call.yes);
    if (call.yes) {
      f.ctx.events.emit(MolaEvents.ApprovalGranted, { approver: "--yes" });
      return value;
    }
    throw new PolicyDenial("fake classifier: outward call requires approval");
  });
  plugin.activate(f.ctx);
  const cmd = f.commands.find((c) => c.path.join(" ") === "ultramode")!;
  assert.ok(cmd, "ultramode command is registered");
  return { ...f, cmd, seenYes };
}

async function shipCheck(
  f: ReturnType<typeof activate>,
  slug: string,
  ioOverrides: Record<string, unknown> = {},
) {
  const io = makeIo(ioOverrides);
  const code = await f.cmd.handler({ positionals: ["ship"], flags: { check: slug } }, io);
  return { code, io };
}

test("ultramode gates: both gates register as waterfall listeners", () => {
  const f = activate();
  assert.ok((f.hooks.get(MolaEvents.UltramodeReview) ?? []).length >= 1, "review gate hooked");
  assert.ok((f.hooks.get(MolaEvents.UltramodeShip) ?? []).length >= 1, "ship gate hooked");
});

test("review gate: denies when the review file is missing", async () => {
  const f = activate();
  await assert.rejects(
    f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug: SLUG, cwd: "/fake/ws" }),
    /no review file at .*ship-the-fix\.md/,
  );
});

test("review gate: denies when no reviewer is named", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview().replace("Reviewer: m-reviewer\n", ""));
  await assert.rejects(
    f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug: SLUG, cwd: "/fake/ws" }),
    /no reviewer named/,
  );
});

test("review gate: denies when the reviewer is the writer", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview("dsh"));
  await assert.rejects(
    f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug: SLUG, cwd: "/fake/ws", writer: "dsh" }),
    /reviewer "dsh" is the writer/,
  );
});

test("review gate: denies on a REQUEST CHANGES verdict", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview().replace("\nAPPROVE\n", "\nREQUEST CHANGES\n"));
  await assert.rejects(
    f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug: SLUG, cwd: "/fake/ws" }),
    /verdict is not APPROVE/,
  );
});

test("review gate: denies when no verdict is present", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview().replace("\nAPPROVE\n", "\n"));
  await assert.rejects(
    f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug: SLUG, cwd: "/fake/ws" }),
    /verdict is not APPROVE/,
  );
});

test("review gate: denies when no evidence is cited", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview("m-reviewer", "looks fine to me"));
  await assert.rejects(
    f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug: SLUG, cwd: "/fake/ws" }),
    /no evidence cited/,
  );
});

test("review gate: passes on a good review (repro evidence)", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview());
  const out = await f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, {
    slug: SLUG,
    cwd: "/fake/ws",
    writer: "dsh",
  });
  assert.equal((out as Record<string, unknown>).slug, SLUG);
});

test("review gate: passes on a .mstack/ path as evidence when the path exists", async () => {
  const f = activate();
  f.files.set("/fake/ws/.mstack/runs/run-1/decision.json", JSON.stringify({ runId: "run-1" }));
  f.files.set(REVIEW_PATH, goodReview("m-reviewer", "evidence: .mstack/runs/run-1/decision.json"));
  await f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug: SLUG, cwd: "/fake/ws" });
});

test("review gate: passes on a backticked .mstack/ path and a :line-range suffix when the file exists", async () => {
  const f = activate();
  f.files.set("/fake/ws/.mstack/runs/run-1/decision.json", JSON.stringify({ runId: "run-1" }));
  f.files.set(REVIEW_PATH, goodReview("m-reviewer", "evidence: `.mstack/runs/run-1/decision.json:12-20`"));
  await f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug: SLUG, cwd: "/fake/ws" });
});

test("review gate: passes on a .mstack/ path with a :line suffix when the file exists", async () => {
  const f = activate();
  f.files.set("/fake/ws/.mstack/runs/run-1/decision.json", JSON.stringify({ runId: "run-1" }));
  f.files.set(REVIEW_PATH, goodReview("m-reviewer", "evidence: .mstack/runs/run-1/decision.json:15"));
  await f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug: SLUG, cwd: "/fake/ws" });
});

test("review gate: denies when the only cited .mstack/ path does not exist on disk", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview("m-reviewer", "evidence: .mstack/runs/run-1/decision.json"));
  await assert.rejects(
    f.ctx.events.runWaterfall(MolaEvents.UltramodeReview, { slug: SLUG, cwd: "/fake/ws" }),
    /cited evidence path "\.mstack\/runs\/run-1\/decision\.json" does not exist/,
  );
});

test("ship gate: ship --check denies with no grant (good review present)", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview());
  const { code, io } = await shipCheck(f, SLUG);
  assert.equal(code, 77);
  const check = (io.dataValue as Record<string, unknown>).shipCheck as Record<string, unknown>;
  assert.equal(check.ok, false);
  assert.equal(check.gate, "ship");
  assert.match(String(check.reason), /no ultramode grant/);
  const last = f.kv.lastOutcome as Record<string, unknown>;
  assert.equal(last.outcome, "denied");
  assert.equal(last.exitCode, 77);
  assert.deepEqual(f.seenYes, [], "the classifier was never reached without a grant");
});

test("ship gate: denies after revoke", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview());
  const io = makeIo();
  assert.equal(await f.cmd.handler({ positionals: ["grant", SLUG], flags: {} }, io), 0);
  assert.equal(await f.cmd.handler({ positionals: ["revoke", SLUG], flags: {} }, io), 0);
  const { code } = await shipCheck(f, SLUG);
  assert.equal(code, 77);
});

test("ship gate: denies for the wrong workspace", async () => {
  const f = activate();
  const io = makeIo();
  assert.equal(await f.cmd.handler({ positionals: ["grant", SLUG], flags: {} }, io), 0);
  const otherReview = `/other/ws/.mstack/reviews/${SLUG}.md`;
  f.files.set(otherReview, goodReview());
  const { code, io: checkIo } = await shipCheck(f, SLUG, { cwd: "/other/ws" });
  assert.equal(code, 77);
  const check = (checkIo.dataValue as Record<string, unknown>).shipCheck as Record<string, unknown>;
  assert.match(String(check.reason), /no ultramode grant/);
});

test("ship gate: denies with io.yes=true and no grant", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview());
  const { code, io } = await shipCheck(f, SLUG, { yes: true });
  assert.equal(code, 77);
  const check = (io.dataValue as Record<string, unknown>).shipCheck as Record<string, unknown>;
  assert.match(String(check.reason), /no ultramode grant/);
  assert.ok(
    !f.emitted.some((e) => e.event === MolaEvents.ApprovalGranted),
    "--yes without a grant emits no approval",
  );
});

test("ship gate: passes with a grant — waterfall got yes=true, and the probe emits no approval record", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview());
  const io = makeIo();
  assert.equal(await f.cmd.handler({ positionals: ["grant", SLUG], flags: {} }, io), 0);
  const { code, io: checkIo } = await shipCheck(f, SLUG);
  assert.equal(code, 0);
  assert.deepEqual(f.seenYes, [true], "the classifier saw yes derived from the grant");
  assert.ok(
    !f.emitted.some(
      (e) =>
        e.event === MolaEvents.ApprovalGranted &&
        String((e.data as Record<string, unknown>).approver ?? "").startsWith("ultramode-grant:"),
    ),
    "ship --check is a probe: it ships nothing, so the mode emits no approval record for it (the fake classifier's own --yes emission is not the mode's)",
  );
  const check = (checkIo.dataValue as Record<string, unknown>).shipCheck as Record<string, unknown>;
  assert.equal(check.ok, true);
});

test("grant: workspace-scoped — a grant in A does not authorize B, and revoke in B leaves A alone", async () => {
  const f = activate();
  f.files.set(REVIEW_PATH, goodReview());
  f.files.set(`/other/ws/.mstack/reviews/${SLUG}.md`, goodReview());
  const io = makeIo();
  assert.equal(await f.cmd.handler({ positionals: ["grant", SLUG], flags: {} }, io), 0);
  assert.ok(f.kv[grantKey(SLUG, "/fake/ws")], "A's grant is recorded under A's workspace key");
  assert.equal(f.kv[grantKey(SLUG, "/other/ws")], undefined, "no grant key exists for B");
  const { code: bCode, io: bIo } = await shipCheck(f, SLUG, { cwd: "/other/ws" });
  assert.equal(bCode, 77, "B is not authorized by A's grant");
  const bCheck = (bIo.dataValue as Record<string, unknown>).shipCheck as Record<string, unknown>;
  assert.match(String(bCheck.reason), /no ultramode grant/);
  const revokeIo = makeIo({ cwd: "/other/ws" });
  assert.equal(await f.cmd.handler({ positionals: ["revoke", SLUG], flags: {} }, revokeIo), 0);
  assert.equal((revokeIo.dataValue as Record<string, unknown>).hadGrant, false, "revoke in B found no grant");
  assert.ok(f.kv[grantKey(SLUG, "/fake/ws")], "A's grant survives a revoke in B");
  const { code: aCode } = await shipCheck(f, SLUG);
  assert.equal(aCode, 0, "A still passes after the revoke in B");
  // and a grant in B is a separate record that authorizes B only
  const grantBIo = makeIo({ cwd: "/other/ws" });
  assert.equal(await f.cmd.handler({ positionals: ["grant", SLUG], flags: {} }, grantBIo), 0);
  assert.ok(f.kv[grantKey(SLUG, "/other/ws")], "B's grant is recorded under B's key");
  assert.notEqual(grantKey(SLUG, "/fake/ws"), grantKey(SLUG, "/other/ws"));
  const { code: bCode2 } = await shipCheck(f, SLUG, { cwd: "/other/ws" });
  assert.equal(bCode2, 0, "B passes with its own grant");
});

test("grant/revoke: roundtrip records and deletes the grant key", async () => {
  const f = activate();
  const io = makeIo();
  assert.equal(await f.cmd.handler({ positionals: ["grant", SLUG], flags: {} }, io), 0);
  const grant = f.kv[grantKey(SLUG, "/fake/ws")] as Record<string, unknown>;
  assert.equal(grant.slug, SLUG);
  assert.equal(grant.workspace, "/fake/ws");
  assert.equal(grant.grantedBy, "trace-test-0000-0000");
  assert.equal(grant.scope, "ship");
  assert.ok(typeof grant.at === "string" && grant.at.length > 0);
  assert.equal(await f.cmd.handler({ positionals: ["revoke", SLUG], flags: {} }, io), 0);
  assert.equal(f.kv[grantKey(SLUG, "/fake/ws")], undefined);
  const data = io.dataValue as Record<string, unknown>;
  assert.equal(data.revoked, true);
  assert.equal(data.hadGrant, true);
});

test("ship --check denial: records the outcome and writes the closeout line", async () => {
  const agent: FakeAgent = { id: "dsh", results: [{ exitCode: 0, finalText: "done" }], calls: [] };
  const f = activate([agent]);
  const io = makeIo();
  const slug = slugifyGoal("ship the fix");
  assert.equal(slug, SLUG);
  assert.equal(await f.cmd.handler({ positionals: ["ship the fix"], flags: {} }, io), 0);
  const { code } = await shipCheck(f, SLUG);
  assert.equal(code, 77);
  const last = f.kv.lastOutcome as Record<string, unknown>;
  assert.equal(last.goal, "ship the fix");
  const goal = f.files.get(`/fake/ws/.mstack/goals/${SLUG}.md`)!;
  assert.match(goal, /gate denied: review/);
  assert.match(goal, /\| ship --check \| failed \|/);
});
