import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Io, PluginContext } from "@mola/plugin-sdk";
import { familyFrom, land, openBlocking, parseReview, receiptProblems, readReceipt, treeOf, writeReceipt } from "../src/index.js";

const noTable = (): null => null;

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-guard-"));
  const g = (...a: string[]): string => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  g("checkout", "-qb", "agent/x");
  fs.writeFileSync(path.join(dir, "a.txt"), "2\n");
  g("commit", "-qam", "work");
  g("checkout", "-q", "main");
  fs.mkdirSync(path.join(dir, ".mstack"));
  fs.writeFileSync(path.join(dir, ".mstack", "verify.md"), "ok\n");
  return dir;
}

function io(cwd: string, yes = false): Io {
  return { json: false, quiet: true, yes, traceId: "t", cwd, data: () => {}, out: () => {}, note: () => {}, error: () => {} };
}

function ctx(denyAll = false): PluginContext & { gated: string[][] } {
  const gated: string[][] = [];
  return {
    gated,
    events: {
      async runWaterfall(_e: string, v: { argv: string[]; yes: boolean }) {
        gated.push(v.argv);
        if (denyAll || !v.yes) throw Object.assign(new Error("approval required"), { exitCode: 77 });
        return v;
      },
    },
  } as unknown as PluginContext & { gated: string[][] };
}

test("parseReview: REPRO or high/medium blocks; low/nit and unconfirmed do not; CLEARED closes", () => {
  const p = parseReview(
    [
      "FINDING src/a.ts:3 | off by one | empty list crashes",
      "REPRO node t.js -> TypeError",
      "FINDING src/b.ts:9 | maybe slow | big input",
      "FINDING: low src/c.ts:1 naming",
      "FINDING: high src/d.ts:4 auth bypass",
      "CLEARED src/d.ts:4 | fixed in 1a2b",
      "REQUEST CHANGES",
    ].join("\n"),
  );
  assert.deepEqual(p.findings.map((f) => f.blocking), [true, false, false, true]);
  assert.deepEqual(openBlocking(p).map((f) => f.where), ["src/a.ts:3"]);
  assert.equal(p.verdict, "REQUEST CHANGES");
});

test("familyFrom: table first, then the model word", () => {
  assert.equal(familyFrom("auto/claude-opus-5-5"), "claude");
  assert.equal(familyFrom("openai/gpt-6"), "gpt");
  assert.equal(familyFrom("group/m-think", (r) => (r === "group/m-think" ? "claude" : null)), "claude");
});

test("receipt: same family refused and not written; open blocking finding refused; clean review written", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "rev.md"), "CLEARED auth\nAPPROVE\n");
  const same = writeReceipt(dir, { review: "rev.md", reviewer: "r", reviewerModel: "auto/claude-opus-5-5", authorModel: "auto/claude-sonnet-5-5", ref: "agent/x" }, noTable);
  assert.match(same.problems.join(), /author's family/);
  assert.equal(fs.existsSync(same.file), false);

  fs.writeFileSync(path.join(dir, "bad.md"), "FINDING: high src/x.ts:1 broken\nAPPROVE\n");
  const bad = writeReceipt(dir, { review: "bad.md", reviewer: "r", reviewerModel: "gemini-3", authorModel: "claude-opus", ref: "agent/x" }, noTable);
  assert.match(bad.problems.join(), /blocking/);

  const good = writeReceipt(dir, { review: "rev.md", reviewer: "r", reviewerModel: "gemini-3", authorModel: "claude-opus", verify: ".mstack/verify.md", ref: "agent/x" }, noTable);
  assert.deepEqual(good.problems, []);
  const { tree } = treeOf(dir, "agent/x");
  assert.deepEqual(receiptProblems(readReceipt(dir, tree), { needVerify: true }), []);
});

test("land: refused without a receipt; --local fast-forwards main through the gate; receipt bound to the tree", async () => {
  const dir = repo();
  await assert.rejects(land(ctx(), io(dir, true), { branch: "agent/x", into: "main", local: true, yes: true }), /no review receipt/);

  fs.writeFileSync(path.join(dir, "rev.md"), "APPROVE\n");
  writeReceipt(dir, { review: "rev.md", reviewer: "r", reviewerModel: "gemini-3", authorModel: "claude-opus", verify: ".mstack/verify.md", ref: "agent/x" }, noTable);

  // without --yes the gate refuses and main does not move
  const before = execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim();
  await assert.rejects(land(ctx(), io(dir), { branch: "agent/x", into: "main", local: true, yes: false }), /approval/);
  assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim(), before);

  const c = ctx();
  const res = await land(c, io(dir, true), { branch: "agent/x", into: "main", local: true, yes: true });
  assert.match(res.did[0], /fast-forward/);
  assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim(), execFileSync("git", ["rev-parse", "agent/x"], { cwd: dir, encoding: "utf8" }).trim());
  assert.deepEqual(c.gated[0].slice(0, 3), ["git", "merge", "--ff-only"]);
  // the one-shot token is gone afterwards
  assert.equal(fs.existsSync(path.join(dir, ".git", "mola-land-token")), false);

  // a new commit on the branch has a new tree: the old receipt does not cover it
  execFileSync("git", ["checkout", "-q", "agent/x"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "3\n");
  execFileSync("git", ["commit", "-qam", "more"], { cwd: dir });
  await assert.rejects(land(ctx(), io(dir, true), { branch: "agent/x", into: "main", local: true, yes: true }), /no review receipt/);
});

test("land default: pushes the branch (never the protected ref) and opens a PR", async () => {
  const dir = repo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "mola-guard-remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  fs.writeFileSync(path.join(dir, "rev.md"), "APPROVE\n");
  writeReceipt(dir, { review: "rev.md", reviewer: "r", reviewerModel: "gemini-3", authorModel: "claude-opus", verify: ".mstack/verify.md", ref: "agent/x" }, noTable);
  const ghCalls: string[][] = [];
  const res = await land(ctx(), io(dir, true), { branch: "agent/x", into: "main", local: false, yes: true }, { gh: (a) => (ghCalls.push(a), { ok: true, out: "https://example/pr/1", err: "" }) });
  assert.deepEqual(ghCalls[0], ["pr", "create", "--base", "main", "--head", "agent/x", "--fill"]);
  assert.match(res.did.join("\n"), /pr\/1/);
  const heads = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], { cwd: remote, encoding: "utf8" }).trim();
  assert.equal(heads, "refs/heads/agent/x");
});
