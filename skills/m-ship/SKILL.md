---
name: m-ship
description: "Branch to clean PR: sync upstream, real tests, independent review, PR doc, push, babysit CI. Use for 提PR/提交/推到上游."
whenToUse: "Code changes are done and need committing, pushing, or a PR; or a PR is open and needs to be driven to green."
---

# m-ship

Move a finished change from a feature branch to an open pull request with real verification evidence, and keep it green afterwards. Nothing is "done" until the PR is open, CI passes, and review feedback is answered (principles 4 and 6).

## When to use

Use it: when you are ready to commit/push/open a PR; to fix failing CI; to act on PR comments.

Not this skill: the change isn't written → `m-think`/`m-plan`; you want review *without* shipping → `m-review`; after merge you need deploy verification → that is out of scope (stop at an open, green PR).

## Procedure

Using m-ship: <one-line purpose> — say this first, before any tool call.

**Rule: no PR called ready without fresh test output from this branch and a verdict from a reviewer who did not write it.**
No exceptions: a CI re-run is not a fix; your own review, a passing suite and a green CI are not an independent verdict; do not edit a test's expected value, skip hooks (`--no-verify`) or mark a check not-required to get past a red.

| You will be tempted to think… | Reality |
|---|---|
| "CI is red, re-run it until it passes." | A suspected flake gets exactly one fresh run. The same failure twice is not a flake (research/round3/pstack-craft.md T4). |
| "The failing file is not in my diff, so not my problem." | First check the base: is your branch behind it, and does the test fail at the merge-base too? (`references/ci-and-comments.md`; research/round3/pstack-craft.md T4). |
| "I ran the tests and read the diff myself." | Self-review, tests and CI are not an independent verdict (pstack-craft T9). Without a reviewer, record `BLOCKED: independent review`. |

Red flags — stop and re-check: you typed "should pass"; you pressed re-run a second time; you are about to add `--no-verify` or `--force`; the PR doc's testing section holds a command you did not run in this branch.

1. **Sync upstream.** `git fetch`, then rebase or merge the base branch into your branch; resolve conflicts. Confirm the target branch is correct (e.g. a version branch), then verify the fork point by asking only if genuinely unknown.
2. **Test for real.** Read the repo's own commands (package.json / Makefile / Cargo.toml / AGENTS.md). Run test, lint, typecheck — then exercise the main path once for real (run the CLI/server/script). On failure, fix and rerun; never write "should pass".
3. **Independent review.** Spawn one reviewer (`m-review`'s angles), and one `m-verifier` run for the test claims, for correctness bugs only. Fix confirmed findings and re-test.
4. **Commit.** Small, bisectable commits whose messages say *why*; group changes with their tests. Check `git diff --cached --stat` for secrets or large binaries before committing.
5. **PR doc** (repo's language; follow its template): background/what+why, key files, **how it was tested** (commands + real output summarized), risks/uncovered, `Closes #n`.
6. **Push and open.** `git push -u origin <branch>`, then `gh pr create` — a draft unless the user asked for ready. Report the URL.
7. **Babysit to green.** Watch remote CI (`gh pr checks`); fix one actionable failure at a time (see `references/ci-and-comments.md`), push, re-check. CI flake rule: a suspected flake or infrastructure failure gets one fresh run, never a job-level retry loop; failing the same way twice means it is a real failure. A failure in code your diff does not touch: check the base first with `git merge-base` (details in the reference). Answer review comments you agree with; for judgment calls reply with what you would have done rather than guessing.

Ruling record: any judgement call the steps do not cover is one line in the PR doc's risks section, `Ruling: decision | reason | cost if wrong`.

Gate function — before each claim to the user:

| claim | evidence required | evidence that is NOT enough |
|---|---|---|
| tests pass | the repo's test command run on this branch after the last edit, exit code read | an earlier run; a sub-agent said so |
| reviewed | a verdict from an agent that did not write the change | self-review; green CI |
| CI green | `gh pr checks` output with every check passing | one check passing; a re-run you did not read |

## Output

- The PR URL and a one-line "N issues fixed, M deferred" summary in Chinese.
- The test evidence: commands run, with real output summarized.
- Commit SHAs for each fix applied while babysitting.

## Stop conditions

- Stop and ask before force-push, before rewriting history on a shared branch, before skipping hooks, before enabling auto-merge, and before changing a test's expected value just to get a pass.
- Stop and hand back after three fix→push→re-check rounds that still are not green, or when one failure repeats on its second fresh run.
- Stop when the next fix would force a design decision — put it to the user.

## Harness notes

- Claude Code: `Agent` for the reviewer and the test claims: `subagent_type: "mstack:m-verifier"` (returns PASS / FAIL / INCOMPLETE with an evidence table) for verification, `mstack:m-reviewer` for the review; `gh` for PRs/CI.
- DSH: `subagent` for the reviewer and the `m-verifier` run; `gh pr`/`gh run` via Bash.
- Codex: `codex exec` a self-contained reviewer prompt; `gh` CLI for the rest.
