---
name: m-verify
description: "No 'done' without fresh evidence: run the real test/build, read the output, test behavior. Use before any success claim, 验证一下/跑通没."
whenToUse: "Before any success claim, commit, PR, or \"done\" — or whenever confidence that a feature or fix works is required."
---

# m-verify

The only acceptable proof that work is done is fresh evidence from the real artifact: a command you just ran whose output you read. Verdicts are per acceptance criterion — VERIFIED / PARTIAL / MISSING — each backed by the command that proved it. "Should work", confidence, and agent self-reports are not evidence.

## When to use / not use

Use before committing, before opening a PR (`m-ship`), after a fix (`m-debug`), when a subagent reports success (`m-dispatch`), and whenever you are about to say "passes / fixed / done".

Do NOT use it to review design or catch missing features — route that to `m-review`. Do NOT use it as a substitute for thinking first (`m-think`). Never weaken, skip, or edit a check to make it green: that is this skill failing, not passing.

## Procedure

First line you say: `Using m-verify: prove the claim with fresh output.`

```
NO SUCCESS WORD WITHOUT THE COMMAND OUTPUT FROM THIS MESSAGE.
```

Closed loopholes: an earlier run, a green single file, a lint pass, a worktree at an older HEAD, an agent's "done", and a `| tail -1` all count as no evidence. Breaking the letter of this rule is breaking its spirit.

1. **Name the claim precisely.** Turn "it works" into a falsifiable statement with one command that proves it: "all tests pass", "build exits 0", "empty email is rejected with `Email required`". If no command proves the claim, say so rather than bluffing. If the project has its own verify skill (`.claude/skills/verify/SKILL.md`, made and maintained by `m-qa`), use its Launch/Drive commands as the proof first. The claim also names its acceptance level, L0 static to L5 non-functional (`references/ladder.md`); a claim below the project's `Required level:` is PARTIAL.
2. **Save the baseline before the first edit.** On a repo that is already red, run the suite once and write one signature line per already-failing test to `.mstack/verify/baseline.txt` (format in `references/verify-gates.md`). Afterwards only failures whose signature is NOT in the baseline block; baseline failures are warnings — report them, don't block on them. With no baseline file, every failure counts as new.
3. **Run the mechanical scan.** `node "<this skill dir>/scripts/diff-blockers.mjs" [base-ref]` flags `.only(`, `.skip(`, `TODO`, `FIXME`, `not implemented` / `NotImplemented`, and `debugger` in added lines. `<this skill dir>` is the directory this SKILL.md was loaded from (Claude Code shows it as the skill base directory; in the mstack repo it is `skills/m-verify`). If that script cannot be found, scan those added lines by hand and say so in the report. The script reads `git diff <base>` (working tree vs that ref, so commits since the ref count) and every untracked file (`git ls-files --others --exclude-standard`, each line treated as added). No argument = uncommitted changes vs HEAD, plus untracked files. When `m-goal` is driving, pass its recorded start commit — `startCommit` in `.mstack/goals/<slug>.state.json` — so the scan is that commit versus the working tree, not an empty `git diff HEAD` after a later commit. Exit 1 = blockers found → not done; exit 2 = could not run (no git repo, bad ref, unreadable untracked file) → fix that and rerun. Tests: `node --test "<this skill dir>/scripts/*.test.mjs"` — quote the glob; a bare directory argument is not portable (fails on Node 24).
4. **Run the anti-cheat gates.** (a) Modifying or deleting an existing test, fixture, conftest, grader, or CI config fails this round unless the task asked for that change or you justify it with evidence (quote the command and output). Adding a new test is required (`m-plan`, `m-debug`, step 5) and is never flagged — do not delete it to quiet this gate. The scan in step 3 does not enforce this path rule. (b) Final acceptance runs only after the change is on a commit: commit on the work branch first, then a worktree at that commit (recipe in `references/verify-gates.md`). Do not check out an older HEAD, and do not apply the working diff into the worktree. A green run that depends on agent-created conftest/sitecustomize files or on repo history is not evidence.
5. **Prove new checks red first.** Any check you added or modified must fail on a deliberately broken version before you trust its pass; quote the failure content you saw. An unexecuted check is a draft, not a gate. (`m-debug` writes the failing regression test first — same rule.)
6. **Gate every claim.** Run this for each claim; skipping a step leaves the claim unverified.
   a. IDENTIFY the one command that proves this exact claim (table below).
   b. RUN it now and in full. No truncating filter, no earlier run, no agent report.
   c. READ the exit code, the failure count, and the diff of the failing assertion.
   d. CHECK the output says what the claim says. If it does not, report the actual state.
   e. ONLY THEN write the claim, with the command and its key output beside it.

   | Claim | Evidence required | Evidence that is NOT enough |
   |---|---|---|
   | Tests pass | full-suite command, 0 failures, exit 0 | an earlier run; one file only; run before the final commit |
   | Build succeeds | build command, exit 0 | lint clean; the log looks fine |
   | Bug fixed | the original repro now passes | code changed; "should be fixed" |
   | New check works | red on the broken version, green on the fix | one green run |
   | Clean diff | step 3 scan exit 0, untracked files included | an empty `git diff` |
   | Agent finished | the diff shows the claimed change | the agent says "done" |
   | Works at level Ln | that level's command (`references/ladder.md`), exit 0, then `node "<this skill dir>/scripts/receipt.mjs" write --level <n> --cmd "<command>" --exit 0` | a lower level's pass; a receipt for an older tree |

7. **Compare, then check the blast radius.** The output confirms the claim → report it with the evidence; it does not → report the actual state with the evidence. Then produce the regression line and the scope line from Output.
8. **Log judgement calls.** Anything the steps do not decide gets one line in `.mstack/verify/rulings.md`: `Ruling: decision | reason | cost if wrong`. Keep going; do not ask.

### Rationalizations seen in this repo

| You will be tempted to think… | Reality |
|---|---|
| "`git diff` is empty, so nothing is left behind." | A new file is untracked and invisible to it; the scan once missed them all (reviews/2026-11-06-round2.md #2). Run the step 3 scan. |
| "The worktree suite is green." | A worktree at HEAD before the commit runs the old code (round2 #4). Commit first. |
| "The regression test trips the gate; I'll delete it." | Adding a test is required; the gate covers existing tests (round2 #5). Deleting yours is this skill failing. |
| "Three tests were already red, so I can't pass." | Save the baseline before editing; only new signatures block (round2 #6). |
| "Lint is clean, so the build is fine." | Different command, different claim (research/round3/superpowers-craft.md, T5). |

**Red flags, stop and run the gate:** you wrote "should", "probably" or "seems to"; you typed "Done" before reading the exit code; you are about to edit a test so it goes green; you are quoting an agent's report instead of a command.

## Output

Follow §4's report format, then:

- **Criterion table.** Every acceptance criterion → VERIFIED / PARTIAL / MISSING + the exact command (and its key output) that proved it. Baseline failures appear as warnings, marked `baseline`.
- **Regression line.** Tests of the callers/importers of the files you changed: "N passed / M failed (<command>)". No callers found → say so and name the grep you ran.
- **Scope line.** `git diff --stat <base>` plus untracked files (`git ls-files --others --exclude-standard`). Every file is in the task's scope, or you name the extra one and why it changed. Use the same base as the scan (for `m-goal`, `startCommit`).
- **Numbers.** Any performance or accuracy number carries run count, spread (min–max or stddev), and the dominant noise source. A single-run number is reported as exactly that, never as a trend.
- Quote a failing assertion's diff (e.g. "Extra items in the right set"), not the assertion line — an exception, an empty result, and a real mismatch all print red; only the last proves the instrument works.

## Stop conditions

- The same error 3 times in a row (counted across reruns of the same command) → stop, don't try a 4th (principle 9); change the hypothesis and route the stubborn red to `m-debug`.
- A check needs a missing tool, secret, service, or network → report it; do not stub, skip, or work around it.
- An anti-cheat gate trips (step 4) → the verdict is FAIL this round. Do not silently revert and claim done; report what tripped.
- No realistic verification path exists → say that explicitly and describe the closest manual check you *did* run.

## Harness notes

- Matching agent: `m-verifier` (Claude Code `subagent_type: "mstack:m-verifier"`). It cannot Write or Edit and returns PASS / FAIL / INCOMPLETE with an evidence table; map that to the criterion table above.
- Claude Code / Codex: run the repo's own check command (bare `pytest`, `npm test`, `cargo test`, `go test ./...`) — a green single-file run is not a green suite. Clean checkout: commit on the work branch first, then `git worktree add` of that commit (recipe in `references/verify-gates.md`). Do not check out an older HEAD.
- DSH: run Bash the same way; use a raw command (not a summarizing filter) when the exact counts or paths matter.
- Cross-model check: for risky or high-stakes work, dispatch one subagent on a different model **family** (Claude vs GPT vs DeepSeek — not another point release of your own model) whose only job is to re-run the verification (`subagent_claude_code` / `subagent_codex` in DSH). The verifier is never the author. If no second family is reachable, say so in the report.
