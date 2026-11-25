/**
 * policy-guard (FRAMEWORK §13.4): the only door to a protected branch.
 *
 *   mola guard receipt --review <review.md> --reviewer <id> --reviewer-model <route> --author-model <route>
 *                      [--verify <verify.md>] [--ref HEAD]
 *   mola guard check [--ref HEAD]
 *   mola land <branch> [--into main] [--local] [--yes]
 *
 * hooks/guard-git.mjs refuses commits and pushes on protected refs and names
 * `mola land`; this is that command. `--local` fast-forwards the protected ref
 * with a one-shot land token the guard consumes; the default pushes the branch
 * and opens a PR. Every outward or ref-moving step passes the approval gate
 * (`mola.tool.before`); `--yes` is the only skip.
 */

import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Io, PluginContext } from "@mola/plugin-sdk";
import { ExitCode, MolaError, MolaEvents, definePlugin, loadRoutingFile, writeJsonAtomic } from "@mola/plugin-sdk";
import {
  familyFrom,
  git,
  openBlocking,
  parseReview,
  readReceipt,
  receiptPath,
  receiptProblems,
  topLevel,
  treeOf,
  type ReviewReceipt,
} from "./receipt.js";

export * from "./receipt.js";

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** The routing table's family matcher (role groups count as their leading family), when the table loads. */
function tableMatcher(): ((route: string) => string | null) | undefined {
  const { table } = loadRoutingFile();
  if (!table) return undefined;
  return (route: string) => {
    const lower = route.toLowerCase();
    const role = Object.values(table.roles ?? {}).find((r) => r.group.toLowerCase() === lower);
    if (role?.leads) return role.leads;
    const model = lower.includes("/") ? lower.slice(lower.indexOf("/") + 1) : lower;
    for (const [name, fam] of Object.entries(table.families)) {
      if (name === "group") continue;
      if (fam.match.some((m) => model.includes(m.toLowerCase()))) return name;
    }
    return null;
  };
}

export function writeReceipt(
  cwd: string,
  o: { review: string; reviewer: string; reviewerModel: string; authorModel: string; verify?: string; ref?: string },
  matcher = tableMatcher(),
): { receipt: ReviewReceipt; file: string; problems: string[] } {
  const top = topLevel(cwd);
  const reviewFile = path.resolve(cwd, o.review);
  let text: string;
  try {
    text = fs.readFileSync(reviewFile, "utf8");
  } catch {
    throw new MolaError("NO_INPUT", `cannot read the review: ${o.review}`, ExitCode.NoInput);
  }
  if (o.verify && !fs.existsSync(path.resolve(cwd, o.verify))) throw new MolaError("NO_INPUT", `no such verify artifact: ${o.verify}`, ExitCode.NoInput);
  const ref = o.ref ?? "HEAD";
  const { tree, commit } = treeOf(top, ref);
  const parsed = parseReview(text);
  const open = openBlocking(parsed);
  const receipt: ReviewReceipt = {
    schemaVersion: 1,
    tree,
    commit,
    ref,
    reviewer: o.reviewer,
    reviewerModel: o.reviewerModel,
    reviewerFamily: familyFrom(o.reviewerModel, matcher),
    authorModel: o.authorModel,
    authorFamily: familyFrom(o.authorModel, matcher),
    verdict: parsed.verdict,
    findings: { total: parsed.findings.length, blocking: open.length, open: open.map((f) => f.where || f.line.slice(0, 80)) },
    review: path.relative(top, reviewFile).split(path.sep).join("/"),
    ...(o.verify ? { verify: path.relative(top, path.resolve(cwd, o.verify)).split(path.sep).join("/") } : {}),
    createdAt: new Date().toISOString(),
  };
  const problems = receiptProblems(receipt);
  const file = receiptPath(top, tree);
  // a receipt that does not count is never written: the file's presence must mean "may land"
  if (problems.length === 0) writeJsonAtomic(file, receipt);
  return { receipt, file, problems };
}

function gitCommonDir(top: string): string {
  const r = git(top, ["rev-parse", "--git-common-dir"]);
  return path.resolve(top, r.out);
}

/** One-shot token for hooks/guard-git.mjs: random, 10 minutes, consumed on first use. */
export function mintLandToken(top: string, now = Date.now()): string {
  const token = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(path.join(gitCommonDir(top), "mola-land-token"), JSON.stringify({ token, expires: now + TOKEN_TTL_MS }), { mode: 0o600 });
  return token;
}

function clearLandToken(top: string): void {
  for (const f of ["mola-land-token", "mola-land-grant"]) {
    try {
      fs.unlinkSync(path.join(gitCommonDir(top), f));
    } catch {
      // gone
    }
  }
}

async function gate(ctx: PluginContext, io: Io, argv: string[], cwd: string, yes: boolean): Promise<void> {
  await ctx.events.runWaterfall(MolaEvents.ToolBefore, {
    tool: argv[0],
    argv,
    callId: `land:${crypto.createHash("sha256").update(JSON.stringify(argv)).digest("hex").slice(0, 12)}`,
    cwd,
    yes: yes || io.yes,
  });
}

export interface LandOptions {
  branch: string;
  into: string;
  local: boolean;
  yes: boolean;
}

export interface LandDeps {
  /** runs gh; tests replace it */
  gh(args: string[], cwd: string): { ok: boolean; out: string; err: string };
}

const realGh: LandDeps["gh"] = (args, cwd) => {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.error?.message ?? "").trim() };
};

export async function land(ctx: PluginContext, io: Io, o: LandOptions, deps: LandDeps = { gh: realGh }): Promise<{ did: string[] }> {
  const top = topLevel(io.cwd);
  const { tree, commit } = treeOf(top, o.branch);
  const problems = receiptProblems(readReceipt(top, tree), { needVerify: true });
  if (problems.length > 0) {
    throw new MolaError("POLICY_DENIED", `refused: ${o.branch} (${commit.slice(0, 10)}, tree ${tree.slice(0, 10)}) cannot land:\n  - ${problems.join("\n  - ")}`, ExitCode.NoPerm);
  }
  const did: string[] = [];
  if (o.local) {
    const target = git(top, ["rev-parse", "--verify", "-q", `refs/heads/${o.into}`]);
    if (!target.ok) throw new MolaError("NO_INPUT", `no local branch ${o.into}`, ExitCode.NoInput);
    if (!git(top, ["merge-base", "--is-ancestor", target.out, commit]).ok) {
      throw new MolaError("POLICY_DENIED", `refused: ${o.into} is not an ancestor of ${o.branch}; rebase ${o.branch} on ${o.into}, review again, then land`, ExitCode.NoPerm);
    }
    const current = git(top, ["symbolic-ref", "--short", "-q", "HEAD"]).out;
    const argv = current === o.into ? ["git", "merge", "--ff-only", commit] : ["git", "update-ref", `refs/heads/${o.into}`, commit, target.out];
    await gate(ctx, io, argv, top, o.yes);
    const token = mintLandToken(top);
    try {
      const r = git(top, argv.slice(1), { MOLA_LAND_TOKEN: token });
      if (!r.ok) throw new MolaError("INTERNAL_ERROR", `${argv.join(" ")} failed: ${r.err}`, ExitCode.Error);
    } finally {
      clearLandToken(top);
    }
    did.push(`${o.into}: ${target.out.slice(0, 10)} → ${commit.slice(0, 10)} (fast-forward, local)`);
    return { did };
  }
  const push = ["git", "push", "-u", "origin", `${o.branch}:refs/heads/${o.branch}`];
  await gate(ctx, io, push, top, o.yes);
  const pr = git(top, push.slice(1));
  if (!pr.ok) throw new MolaError("UPSTREAM_UNAVAILABLE", `git push failed: ${pr.err}`, ExitCode.Unavailable);
  did.push(`pushed ${o.branch} to origin`);
  const ghArgs = ["pr", "create", "--base", o.into, "--head", o.branch, "--fill"];
  await gate(ctx, io, ["gh", ...ghArgs], top, o.yes);
  const r = deps.gh(ghArgs, top);
  if (!r.ok) throw new MolaError("UPSTREAM_UNAVAILABLE", `gh pr create failed: ${r.err}`, ExitCode.Unavailable);
  did.push(`opened ${r.out || "a pull request"}`);
  return { did };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["guard", "receipt"],
      description: "record an independent review of a commit's tree (refused: same model family, open blocking findings)",
      async handler(args, io) {
        const f = args.flags;
        const review = str(f.review);
        const reviewer = str(f.reviewer);
        const reviewerModel = str(f["reviewer-model"]);
        const authorModel = str(f["author-model"]);
        if (!review || !reviewer || !reviewerModel || !authorModel) {
          throw new MolaError(
            "USAGE_ERROR",
            "usage: mola guard receipt --review <review.md> --reviewer <id> --reviewer-model <route> --author-model <route> [--verify <verify.md>] [--ref HEAD]",
            ExitCode.Usage,
          );
        }
        const verify = str(f.verify);
        const ref = str(f.ref);
        const res = writeReceipt(io.cwd, { review, reviewer, reviewerModel, authorModel, ...(verify ? { verify } : {}), ...(ref ? { ref } : {}) });
        io.data({ ...res, written: res.problems.length === 0 });
        if (res.problems.length > 0) {
          io.out(`no receipt: ${res.problems.join("; ")}`);
          return ExitCode.NoPerm;
        }
        io.out(`receipt for tree ${res.receipt.tree.slice(0, 12)} (${res.receipt.reviewerFamily} reviewed ${res.receipt.authorFamily}): ${res.file}`);
        return ExitCode.Ok;
      },
    });
    ctx.commands.register({
      path: ["guard", "check"],
      description: "does the commit's tree have a review receipt that counts, and if not, why",
      async handler(args, io) {
        const top = topLevel(io.cwd);
        const ref = str(args.flags.ref) ?? "HEAD";
        const { tree, commit } = treeOf(top, ref);
        const r = readReceipt(top, tree);
        const problems = receiptProblems(r, { needVerify: true });
        io.data({ ref, commit, tree, ok: problems.length === 0, problems, receipt: r ?? null });
        io.out(problems.length === 0 ? `ok: ${ref} may land (reviewed by ${r!.reviewer}, ${r!.reviewerFamily})` : `not yet: ${problems.join("; ")}`);
        return problems.length === 0 ? ExitCode.Ok : ExitCode.Error;
      },
    });
    ctx.commands.register({
      path: ["land"],
      description: "land a reviewed branch: push + PR (default) or --local fast-forward of a protected branch",
      async handler(args, io) {
        const branch = args.positionals[0];
        if (!branch || args.positionals.length > 1) throw new MolaError("USAGE_ERROR", "usage: mola land <branch> [--into main] [--local] [--yes]", ExitCode.Usage);
        const res = await land(ctx, io, { branch, into: str(args.flags.into) ?? "main", local: args.flags.local === true, yes: args.flags.yes === true });
        io.data(res);
        for (const l of res.did) io.out(l);
        return ExitCode.Ok;
      },
    });
  },
});
