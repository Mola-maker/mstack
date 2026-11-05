---
name: m-ship
description: "Take finished work from branch to an open, clean PR: sync upstream, run the real tests, get an independent review, write the PR doc, push, then babysit CI and comments. Use when ready to commit or open a PR, or the user says \"提PR/提交/推到上游/merge\"."
whenToUse: "Code changes are done and need committing, pushing, or a PR; or a PR is open and needs to be driven to green."
---

# m-ship

Move a finished change from a feature branch to an open pull request with real verification evidence, and keep it green afterwards. Nothing is "done" until the PR is open, CI passes, and review feedback is answered (principles 4 and 6).

## When to use

Use it: when you are ready to commit/push/open a PR; to fix failing CI; to act on PR comments.

Not this skill: the change isn't written → `m-think`/`m-plan`; you want review *without* shipping → `m-review`; after merge you need deploy verification → that is out of scope (stop at an open, green PR).

## Procedure

1. **Sync upstream.** `git fetch`, then rebase or merge the base branch into your branch; resolve conflicts. Confirm the target branch is correct (e.g. a version branch), then verify the fork point by asking only if genuinely unknown.
2. **Test for real.** Read the repo's own commands (package.json / Makefile / Cargo.toml / AGENTS.md). Run test, lint, typecheck — then exercise the main path once for real (run the CLI/server/script). On failure, fix and rerun; never write "should pass".
3. **Independent review.** Spawn one reviewer (`m-review`'s angles) for correctness bugs only. Fix confirmed findings and re-test.
4. **Commit.** Small, bisectable commits whose messages say *why*; group changes with their tests. Check `git diff --cached --stat` for secrets or large binaries before committing.
5. **PR doc** (repo's language; follow its template): background/what+why, key files, **how it was tested** (commands + real output summarized), risks/uncovered, `Closes #n`.
6. **Push and open.** `git push -u origin <branch>`, then `gh pr create` — a draft unless the user asked for ready. Report the URL.
7. **Babysit to green.** Watch remote CI (`gh pr checks`); fix one actionable failure at a time (see `references/ci-and-comments.md`), push, re-check. Answer review comments you agree with; for judgment calls reply with what you would have done rather than guessing.

## Output

- The PR URL and a one-line "N issues fixed, M deferred" summary in Chinese.
- The test evidence: commands run, with real output summarized.
- Commit SHAs for each fix applied while babysitting.

## Stop conditions

- Stop and ask before force-push, before rewriting history on a shared branch, before skipping hooks, before enabling auto-merge, and before changing a test's expected value just to get a pass.
- Stop and hand back after three fix→push→re-check rounds that still are not green.
- Stop when the next fix would force a design decision — put it to the user.

## Harness notes

- Claude Code: `Agent` for the reviewer; `gh` for PRs/CI.
- DSH: `subagent` for the reviewer; `gh pr`/`gh run` via Bash.
- Codex: `codex exec` a self-contained reviewer prompt; `gh` CLI for the rest.
