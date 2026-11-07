---
name: m-review
description: "Multi-angle defect review by someone other than the author; verify feedback before applying. Use for review一下/审一下/看看这个PR."
whenToUse: "A change or branch needs a correctness/security/quality audit before merge, or the user asks for code review."
---

# m-review

Find what is actually wrong with a change, ranked by severity, with enough detail to act. The reviewer is a separate context from the author (principle 6). A finding counts only when a command reproduced it. m-review does not edit or merge. It ends with one verdict — `APPROVE` or `REQUEST CHANGES` — and under `REQUEST CHANGES` lists the blocking findings. The caller (`m-goal`, `m-ship`, or the user) gates on that verdict; `REQUEST CHANGES` is a rejected review.

Intent and standards are their own verdicts, not more defect bullets. Intent: does the diff meet the plan or spec? Standards: does it follow the repo's own rules? Do not cross-rank those axes.

## When to use / not use

Use it after the change exists, before merge, on "review this diff", or when a branch looks risky.

Do not use it (hand off instead):

- Nothing is written yet → `m-think` / `m-plan`.
- You want the bugs fixed → this skill reports; `m-debug` and `m-ship` act.
- The author's own context would be the reviewer → spawn someone else. Never self-review.
- The only question is whether tests pass → `m-verify`.
- Several workers produced candidate patches → `m-dispatch` clusters exact diffs and sends the set to a verifier. That verifier follows the comparison rules below; do not start a second panel unless a full review was asked for.

## Procedure

First line you say: `Using m-review: find defects another context can reproduce.`

```
NO FINDING WITHOUT A REPRO COMMAND AND ITS OUTPUT.
```

Closed loopholes: "looks risky", a finding about a line the diff did not add, a verdict formed after reading the author's rationale, and extra findings added because the list looks short. None of them is a finding. Breaking the letter of this rule is breaking its spirit.

1. **Establish scope.** Take `git diff <base>...HEAD`, or `git diff` plus `git ls-files --others --exclude-standard`. Untracked files are in scope. Name the base and the plan or spec. Read the whole diff before commenting.
2. **Apply the scope rules** in `references/review-template.md` before any reviewer starts. Report only lines the diff adds or replaces. An intentional break whose blast radius is explicit goes under Cleared. Pre-existing code outside the diff is out of scope.
3. **Census consumers.** List exported symbols, protocols, and data formats the diff adds, changes, or removes, plus callers outside the diff. Attach one command you ran and its output. An empty search is a result; do not invent a caller.
4. **Pick a tier and spawn reviewers.** Thresholds are in the template's tier table: fewer than 5 files and no auth, crypto, or destructive change → sonnet floor; 5–20 files with no such risk stays on that floor; more than 20 files, or any of those risks → opus and the security angle. Read the template and fill its prompt before the first spawn. One reviewer per angle that applies. Do not pass your conclusions or the author's name. On the floor tier one reviewer may cover every applicable angle, but each axis still gets its own verdict. Skip devex and feature-gate when the template says they are not applicable.
5. **Require a repro.** Each finding is `file:line | problem | failure scenario` plus `repro: <command> → <actual output>`. Classify with `node "<this skill dir>/scripts/split-findings.mjs" <report.md> --diff <diff>`, run from the project root. `<this skill dir>` is the directory this SKILL.md was loaded from (Claude Code shows it as the skill base directory; in the mstack repo it is `skills/m-review`). If that script cannot be found, classify by hand and say so in the report. The script parses; it does not run the repro. It treats untracked files (`git ls-files --others --exclude-standard`) as in scope, so an empty `git diff` does not drop a finding in a new file. No repro → Unconfirmed, and it does not count. Confirmed but outside the diff and not untracked (script exit 1) → drop it.
6. **Refute high-risk survivors.** Critical, security, auth, crypto, destructive, or data-loss findings go to a refuter whose only job is to disprove them. Promote only survivors. Record how many were killed. Prompt in the template.
7. **Compare in both orders.** When two patches are compared, run A-then-B and B-then-A. Keep a preference only if both orders agree. Hide author identity and any hint that one side is correct. Put every surviving candidate in the same prompt. Bind the verdict to the repro, not to which writeup is longer.
8. **Merge and persist.** Dedupe by location and root cause. Keep each axis's verdict separate. Write `.mstack/reviews/<date>-<slug>.md`. End that file, and the user-facing summary, with the verdict in Output.

## Output

User-facing summary in Chinese (§4): one-line conclusion → what you found (`file:line`) → how you checked (command + output) → what you did not assess.

Also include:

- One verdict per axis you ran: `pass` / `issues` / `not-assessed` / `not-applicable`. Intent quotes the criterion sentence. Standards names the file and the rule.
- Confirmed findings, most severe first, each with the repro field.
- Unconfirmed and Cleared, both excluded from the conclusion.
- The consumer census plus its command and output.
- Refuter drop count.
- To the author: one line for the problem, one line for the fix. Push back with `file:line` or a test when a finding is wrong.
- **Verdict (last line).** `APPROVE` when no confirmed in-scope finding remains and no axis is `issues`. `REQUEST CHANGES` otherwise; under it list each blocking finding as `file:line` and each axis marked `issues`. Unconfirmed and Cleared do not block. `not-assessed` and `not-applicable` do not block by themselves. The caller gates on this line.

### Rationalizations seen in this repo

| You will be tempted to think… | Reality |
|---|---|
| "The diff is empty, so there is nothing to flag in the new file." | Untracked files are in scope; the classifier once dropped every finding in them (reviews/2026-11-06-round2.md #3). |

**Red flags, check the repro before you write it down:** the finding has no command output; it is about code outside the diff; your reviewer prompt names the author or says the answer; you are agreeing because the other writeup is longer.

## Stop conditions

Exactly three things end the review early, and each produces output instead of a question:

1. The base or the diff cannot be established → write `REVIEW BLOCKED: <what failed>` and end.
2. Intent has no criterion to judge against → intent `not-assessed`, quote what is missing. Standards and defect review continue.
3. Reviewer and refuter still disagree after one refute pass → report both sides marked `disputed`. Never promote a disputed finding to confirmed.

Everything else is decided inside the review and logged in the report file as `Ruling: decision | reason | cost if wrong`. Cap the loop at 5 review rounds per change; after that, report the open findings and stop.

## Harness notes

- Matching agent: `m-reviewer` (Claude Code `subagent_type: "mstack:m-reviewer"`, opus, no Write/Edit). Pick a judge from a family other than the author's.
- Claude Code: spawn with `Agent`. Prefer a type that denies Write and Edit. Locally installed reviewer definitions for `code-reviewer` and `verifier` set `disallowedTools: Write, Edit` (read from those files, not from a live tool call). Pass the type string the session actually lists. A stock install may reject the bare name — say so, and use a listed type with the same deny list (`explore` has it in that same set). Bash is not in the deny list, so the prompt must forbid shell writes. Set `model` to the tier (`sonnet` or `opus`); if the tool rejects the slug, report the error and use the closest slug it names. Use `run_in_background` when the tool offers it. `gh` for PR context.
- DSH: `subagent` / `subagent_fork`. No tool-deny flag is documented for those calls; forbid edits in the prompt and do not give the reviewer a writable worktree. For a high-risk refuter, use another model family (`subagent_codex` or `subagent_claude_code`) when one is available. If it is not, say so and continue with a different context (see `references/decisions.md`).
- Codex: `codex exec "<task>"` with the diff path inside the prompt. No further flags are documented here.
