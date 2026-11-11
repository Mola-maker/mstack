/**
 * cmd-ultramode shipping (unit 4): branch model, PR body, CI poll.
 *
 * Data shapes first (design §5-6):
 *
 * - ShipRecord: one ship attempt — `{ slug, verdict, branch, commit?,
 *   prUrl?, prNumber?, prBodyPath?, failing?, pushed, at }`. Verdicts:
 *   `shipped` (PR open, all checks green), `blocked` (a check failed),
 *   `running` (checks still running at the poll cap), `prepared` (no
 *   grant: committed locally, PR body written, nothing pushed),
 *   `duplicate` (a PR for the branch already exists), `denied` (a gate
 *   stopped the ship at 77).
 * - Branch model: the mode owns `ultramode/<slug>`, created from the
 *   current HEAD (or switched to if it already exists). Only that branch
 *   is ever pushed; master/main are never pushed.
 * - PR body: goal, outcome, reviewer + verdict + evidence from the
 *   review file, routing (agent and route), gates passed. No AI branding.
 *
 * Pure helpers live here so tests can assert on behaviour, not internals:
 * `gh pr checks` is parsed from its plain-text table (a failing token
 * blocks, a pending token keeps polling, anything else that parses to a
 * check with no failing/pending token is green).
 */

import type { ExecResult } from "@mola/plugin-sdk";
import { REVIEW_EVIDENCE_RES } from "./gates.js";

export type ShipVerdict = "shipped" | "blocked" | "running" | "prepared" | "duplicate" | "denied";

export interface ShipRecord {
  slug: string;
  verdict: ShipVerdict;
  branch: string;
  commit?: string;
  prUrl?: string;
  prNumber?: number;
  prBodyPath?: string;
  failing?: string[];
  reason?: string;
  gate?: string;
  pushed: boolean;
  at: string;
}

export interface ReviewSummary {
  reviewer: string;
  verdict: string;
  evidence: string;
}

export function branchName(slug: string): string {
  return `ultramode/${slug}`;
}

/** Reviewer, verdict (last non-empty line) and first evidence line. */
export function parseReview(text: string): ReviewSummary {
  const lines = text.split("\n");
  const reviewerLine = lines.find((l) => /^reviewer\s*:/i.test(l));
  const reviewer = reviewerLine?.split(":").slice(1).join(":").trim() ?? "(unknown)";
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const verdict = nonEmpty[nonEmpty.length - 1] ?? "(none)";
  const evidence = lines.find((l) => REVIEW_EVIDENCE_RES.some((re) => re.test(l)))?.trim() ?? "(none cited)";
  return { reviewer, verdict, evidence };
}

export interface PrBodyInput {
  goal: string;
  outcome?: string;
  review: ReviewSummary;
  agent?: string;
  modelRoute?: string;
  granted: boolean;
}

export function renderPrBody(input: PrBodyInput): string {
  return [
    "## Goal",
    "",
    input.goal,
    "",
    "## Outcome",
    "",
    input.outcome ?? "(no routed run recorded)",
    "",
    "## Review",
    "",
    `Reviewer: ${input.review.reviewer} — ${input.review.verdict}`,
    `Evidence: ${input.review.evidence}`,
    "",
    "## Routing",
    "",
    `Agent: ${input.agent ?? "(unknown)"}`,
    `Route: ${input.modelRoute ?? "(unknown)"}`,
    "",
    "## Gates",
    "",
    `- review: passed (reviewer ${input.review.reviewer}, ${input.review.verdict})`,
    input.granted
      ? "- ship: passed (recorded ultramode grant)"
      : "- ship: no grant — prepared PR only, nothing pushed",
    "",
  ].join("\n");
}

export interface CommitMessageInput {
  goal: string;
  outcome?: string;
  review: ReviewSummary;
  granted: boolean;
}

/** First line is the goal objective; the body is the closeout summary plus gates evidence. */
export function renderCommitMessage(input: CommitMessageInput): string {
  return [
    input.goal,
    "",
    `Outcome: ${input.outcome ?? "(no routed run recorded)"}`,
    `Review: ${input.review.reviewer} ${input.review.verdict} — ${input.review.evidence}`,
    `Gates: review passed; ship ${input.granted ? "passed (recorded grant)" : "prepared only (no grant)"}`,
    "",
  ].join("\n");
}

/** First entry of `gh pr list --json number,url`; undefined when the list is empty. Throws on unparsable output. */
export function parsePrListJson(text: string): { number: number; url: string } | undefined {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const first = parsed[0] as { number?: unknown; url?: unknown };
  if (typeof first.number !== "number" || typeof first.url !== "string") {
    throw new Error(`gh pr list returned an entry without number/url: ${text.trim()}`);
  }
  return { number: first.number, url: first.url };
}

/** PR number and URL from `gh pr create` stdout (it prints the PR URL). */
export function parsePrCreateOutput(text: string): { number: number; url: string } | undefined {
  const match = /(https?:\/\/\S+\/pull\/(\d+))/.exec(text);
  if (!match) return undefined;
  return { url: match[1].replace(/[),.]+$/, ""), number: Number(match[2]) };
}

export interface ChecksParse {
  complete: boolean;
  failing: string[];
  running: string[];
}

const FAILING_RE = /\b(fail|failed|failing|failure|error|errored|cancelled|canceled|timed_out|timed out|action_required)\b/i;
const RUNNING_RE = /\b(pending|queued|in_progress|in progress|running|waiting|requested|expected|stale)\b/i;
const PASSING_RE = /\b(pass|passed|passing|success|successful|skipped|neutral)\b/i;

/** Parse one `gh pr checks` text table. A failing check blocks; a pending one keeps polling. */
export function parseChecks(text: string): ChecksParse {
  if (/no checks/i.test(text)) return { complete: true, failing: [], running: [] };
  if (/all checks (were )?successful/i.test(text)) return { complete: true, failing: [], running: [] };
  const failing: string[] = [];
  const running: string[] = [];
  let parsed = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[✓✔✗✘●○]\s*/, "");
    if (!line) continue;
    if (/^name\b/i.test(line) || /some checks are still/i.test(line)) {
      if (/still/i.test(line)) running.push("(checks still running)");
      continue;
    }
    parsed++;
    const name = line.split(/\s+/)[0] ?? line;
    if (FAILING_RE.test(line)) failing.push(name);
    else if (RUNNING_RE.test(line)) running.push(name);
    else if (!PASSING_RE.test(line)) running.push(name);
  }
  if (parsed === 0) return { complete: text.trim() === "", failing: [], running: text.trim() === "" ? [] : ["(unparsed output)"] };
  return { complete: failing.length === 0 && running.length === 0, failing, running };
}

export interface PollOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `gh pr checks <number>` until every check completes. A failed check
 * ends the poll as blocked; the cap ends it as running. `gh pr checks`
 * exits non-zero when a check fails, so its exit code is never treated as
 * an exec failure here — only its parsed output decides.
 */
export async function pollChecks(
  exec: (argv: string[]) => Promise<ExecResult>,
  prNumber: number,
  opts: PollOptions = {},
): Promise<{ verdict: "shipped" | "blocked" | "running"; failing?: string[] }> {
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeout = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  let first = true;
  for (;;) {
    if (!first && Date.now() >= deadline) return { verdict: "running" };
    first = false;
    const res = await exec(["gh", "pr", "checks", String(prNumber)]);
    const parsed = parseChecks(`${res.stdout}\n${res.stderr}`);
    if (parsed.failing.length > 0) return { verdict: "blocked", failing: parsed.failing };
    if (parsed.complete) return { verdict: "shipped" };
    if (Date.now() >= deadline) return { verdict: "running" };
    await sleep(interval);
  }
}
