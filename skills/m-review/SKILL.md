---
name: m-review
description: "Multi-angle defect review by someone other than the author; verify feedback before applying. Use for review一下/审一下/看看这个PR."
whenToUse: "A change or branch needs a correctness/security/quality audit before merge, or the user asks for code review."
---

# m-review

Find what is actually wrong with a change, ranked by severity, with enough detail to act on. Reviews are advisory: they inform, never gate. The reviewer must be a separate context from the author (principle 6), and every finding must be verified against real code before it is reported.

## When to use

Use it: after a feature or task completes, before merge, on "review this diff", or when a branch looks risky and you want fresh eyes.

Do not use it (hand off instead):
- The change isn't written yet → `m-think` / `m-plan`.
- You want to fix the bugs found → this skill reports; `m-debug` and `m-ship` act on findings.
- The author's same active context is doing the review → spawn a separate `subagent` or another model (never self-review).

## Procedure

1. **Establish scope.** Get the change: `git diff <base>...HEAD` (or `git diff` for uncommitted work) plus untracked files (`git ls-files --others --exclude-standard`). Identify the merge base and what the work was supposed to do (plan, task, ticket, spec). Read the whole diff before commenting.
2. **Dispense parallel reviewers.** Do not run the five angles in one pass. Spawn one independent reviewer per angle below, each given the diff plus scope but *not* your conclusions. Each reviewer returns findings as `file:line`, `problem`, `failure scenario` (what breaks in production or a test, how an attacker or user triggers it). Use `subagent` (DSH) / `Agent` (Claude Code); for a small diff (<50 lines) a single pass is acceptable.
3. **Verify before reporting.** For each candidate finding, re-check it against the code: reproduce the path, confirm the `file:line` exists, and drop anything that is already handled elsewhere in the diff or that cannot actually fail. A plausible-sounding finding that does not reproduce is noise.
4. **Rank and report.** Merge findings (dedupe by location/root cause), order most severe first, keep each axis's verdict separate, and mark anything that could not be assessed. "No findings" is a valid result.
5. **Persist.** Write the summary to `.mstack/reviews/<date>-<slug>.md`.

### Reviewer angles

Refer to `references/review-template.md` for the full prompt template and the five angle prompts. The five angles:

1. **Correctness** — logic, edge cases, error paths, off-by-one, wrong types.
2. **Concurrency / resources** — races, deadlocks, leaks, unbounded growth, lifecycle bugs.
3. **API / compatibility** — breaking changes, changed contracts, miss-ing migrations, version/platform drift.
4. **Tests / edges** — untested behavior, wrong assertions, missing boundary cases, flaky tests.
5. **Security** — trust boundaries, injection, authz, secrets, destructive operations.

## Output

- Findings, most-severe first, each as `file:line` + `problem` + a concrete `failure scenario`.
- What was checked and found clean (per angle).
- What could not be assessed.
- Answer every finding to the author as one line problem + one line fix, with technical reasoning (never performative agreement). Push back with `file:line` or test evidence when a finding is wrong.

## Stop conditions

- Stop and ask when the diff cannot be established (missing base, ambiguous branch) or when scope is unclear.
- Stop reporting and hand back when a finding would need the author's context to judge (ask, don't guess).
- Abandon a finding once it fails to reproduce or is already handled in the diff — do not pad the list.

## Harness notes

- Claude Code: spawn reviewers with `Agent` (`run_in_background` where available); gh CLI for PR context.
- DSH: `subagent` / `subagent_fork` for reviewers; `git diff` via Bash.
- Codex: `codex exec` a self-contained reviewer prompt with the diff path passed in.
