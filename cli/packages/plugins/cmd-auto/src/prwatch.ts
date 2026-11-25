/**
 * PR watches: `mola serve` reads the PR every `everySec` (default 120 s) with
 * `gh pr view` and wakes on what changed since the last read:
 *   - a check that newly fails, or every check finished and passed;
 *   - the branch starting to conflict;
 *   - a comment or review from someone else (your own never wake);
 *   - merge or close (one last wake, then the watch ends).
 * The first read is the baseline: old comments and old failures do not wake.
 * A watch also ends after 10 wakes in a row that brought only comments, or 8
 * failed reads in a row. A wake is news, not a merge decision.
 */

export interface PrWatch {
  id: string;
  cwd: string;
  pr: number;
  repo?: string;
  /** a go run to hand each wake to (note + resume) */
  run?: string;
  /** or: start a new go run per wake with this prompt */
  prompt?: string;
  auto: boolean;
  everySec: number;
  createdAt: string;
  lastReadAt?: string;
  snapshot?: PrSnapshot;
  commentOnlyWakes: number;
  readFailures: number;
  wakes: number;
  ended?: string;
}

export interface PrSnapshot {
  state: string;
  mergeable: string;
  head: string;
  failing: string[];
  pending: number;
  allPassed: boolean;
  seen: string[];
}

export interface PrWake {
  kinds: ("check-failed" | "checks-passed" | "conflict" | "comment" | "merged" | "closed")[];
  lines: string[];
  /** set when the watch should end after this wake */
  end?: string;
}

interface GhAuthor {
  login?: string;
}
interface GhPr {
  state?: string;
  mergeable?: string;
  headRefOid?: string;
  comments?: { id?: string; url?: string; author?: GhAuthor; body?: string; createdAt?: string }[];
  reviews?: { id?: string; author?: GhAuthor; body?: string; state?: string; submittedAt?: string }[];
  statusCheckRollup?: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[];
}

export const PR_FIELDS = "state,mergeable,headRefOid,comments,reviews,statusCheckRollup";
export const MAX_COMMENT_ONLY = 10;
export const MAX_READ_FAILURES = 8;

const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

export function snapshotOf(pr: GhPr): PrSnapshot & { items: { key: string; who: string; text: string }[] } {
  const failing: string[] = [];
  let pending = 0;
  let total = 0;
  for (const c of pr.statusCheckRollup ?? []) {
    total++;
    const name = c.name ?? c.context ?? "check";
    const status = (c.status ?? "").toUpperCase();
    const result = (c.conclusion ?? c.state ?? "").toUpperCase();
    if (status && status !== "COMPLETED") pending++;
    else if (result === "PENDING" || result === "EXPECTED") pending++;
    else if (FAIL.has(result)) failing.push(name);
  }
  const items: { key: string; who: string; text: string }[] = [];
  for (const c of pr.comments ?? []) items.push({ key: `c:${c.id ?? c.url ?? c.createdAt}`, who: c.author?.login ?? "?", text: c.body ?? "" });
  for (const r of pr.reviews ?? []) items.push({ key: `r:${r.id ?? r.submittedAt}`, who: r.author?.login ?? "?", text: `${r.state ?? "REVIEW"}: ${r.body ?? ""}` });
  return {
    state: (pr.state ?? "OPEN").toUpperCase(),
    mergeable: (pr.mergeable ?? "UNKNOWN").toUpperCase(),
    head: pr.headRefOid ?? "",
    failing: failing.sort(),
    pending,
    allPassed: total > 0 && pending === 0 && failing.length === 0,
    seen: items.map((i) => i.key),
    items,
  };
}

/** Compare a fresh read to the last snapshot. Undefined: nothing to wake for. */
export function compare(prev: PrSnapshot | undefined, pr: GhPr, self: string | undefined): { next: PrSnapshot; wake?: PrWake } {
  const cur = snapshotOf(pr);
  const { items, ...next } = cur;
  if (!prev) return { next };
  const wake: PrWake = { kinds: [], lines: [] };
  if (cur.state === "MERGED" && prev.state !== "MERGED") {
    wake.kinds.push("merged");
    wake.lines.push("the PR was merged");
    wake.end = "merged";
  } else if (cur.state === "CLOSED" && prev.state !== "CLOSED") {
    wake.kinds.push("closed");
    wake.lines.push("the PR was closed without merging");
    wake.end = "closed";
  }
  const sameHead = cur.head === prev.head;
  const newlyFailing = cur.failing.filter((f) => !(sameHead && prev.failing.includes(f)));
  if (newlyFailing.length > 0) {
    wake.kinds.push("check-failed");
    wake.lines.push(`checks failed: ${newlyFailing.join(", ")} (read the logs: gh pr checks ${"<n>"}; gh run view --log-failed)`);
  }
  if (cur.allPassed && !(prev.allPassed && sameHead)) {
    wake.kinds.push("checks-passed");
    wake.lines.push("every check finished and passed");
  }
  if (cur.mergeable === "CONFLICTING" && prev.mergeable !== "CONFLICTING") {
    wake.kinds.push("conflict");
    wake.lines.push("the branch now conflicts with its base");
  }
  const fresh = items.filter((i) => !prev.seen.includes(i.key) && (!self || i.who.toLowerCase() !== self.toLowerCase()));
  if (fresh.length > 0) {
    wake.kinds.push("comment");
    for (const f of fresh.slice(0, 5)) wake.lines.push(`@${f.who}: ${f.text.replace(/\s+/g, " ").slice(0, 400)}`);
    if (fresh.length > 5) wake.lines.push(`… and ${fresh.length - 5} more`);
  }
  next.seen = [...new Set([...prev.seen, ...next.seen])];
  return wake.kinds.length ? { next, wake } : { next };
}

/** Advance the counters for one read; returns why the watch ends, if it does. */
export function account(w: PrWatch, wake: PrWake | undefined): string | undefined {
  if (!wake) return undefined;
  w.wakes++;
  if (wake.end) return wake.end;
  const commentOnly = wake.kinds.every((k) => k === "comment");
  w.commentOnlyWakes = commentOnly ? w.commentOnlyWakes + 1 : 0;
  if (w.commentOnlyWakes >= MAX_COMMENT_ONLY) return `${MAX_COMMENT_ONLY} wakes in a row brought only comments`;
  return undefined;
}

export function wakeText(w: PrWatch, wake: PrWake): string {
  return [`PR #${w.pr}${w.repo ? ` (${w.repo})` : ""}: ${wake.kinds.join(", ")}`, ...wake.lines.map((l) => `- ${l.replace("<n>", String(w.pr))}`)].join("\n");
}
