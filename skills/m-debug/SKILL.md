---
name: m-debug
description: "Root-cause a bug or failing test: reproduce, competing hypotheses, regression test. Use for debug一下/为什么报错/这个测试挂了."
whenToUse: "A test fails, code errors, output is wrong, or a build is broken — before any edit that claims to fix it."
---

# m-debug

Symptom fixes fail. Find the first place the system did the wrong thing, prove it, and fix it there — never at the place the wrong state merely surfaced. Work the fixed path (localize → reproduce → patch → validate) first; free exploration is what you earn after the fixed path stalls.

## When to use / not use

Use for any technical failure: tests, prod bugs, wrong output, perf, build, integration. Use it *especially* under time pressure or when "one quick fix" looks obvious.

Do NOT use it to fix a bug you haven't reproduced, or to change code before knowing the cause. If the same error has already failed 3 fix attempts, stop and reconsider the architecture instead. For "why was X designed this way" (rationale, not failure), that's investigation of intent — not this skill.

## Procedure

1. **Read the error completely.** Stack trace, line numbers, file paths, error codes — the message often names the answer.
2. **Localize before you edit.** Fixed order: localize → reproduce → patch → validate. With a test suite, start from coverage: which lines do the failing tests actually execute? Narrow to those before reading anything else. Then check recent changes — `git diff`, last commits, new deps, config or environment differences.
3. **Reproduce consistently.** Write down the exact minimal steps; if it won't reproduce, gather more data rather than guessing.
4. **Form competing hypotheses — one row each.** When step 2 hasn't already pinned the origin: at least two candidates, stated as "X is the cause because Y", deliberately different, not one idea restated. Fill a row per candidate:

   | hypothesis | evidence for | evidence against | distinctive prediction | cheapest probe |

   Down-weight evidence that is only a timing coincidence, a name that sounds related, or an analogy to a previous bug — such evidence never carries a row on its own.
5. **Run the cheapest discriminating probe.** Change one variable, as small as possible, to separate the leading hypothesis from the runner-up. Prefer falsifying your favorite; if it doesn't reproduce, re-rank. Name the file every relied-on fact came from; walk the data flow backward from the symptom and note where it *first* went wrong.
6. **Patch at the root.** Make the smallest change at the origin; check for the pattern, not just this instance.
7. **Validate.** Failing-before and passing-after outputs of the regression check; then hand the result to `m-verify` — its scan and anti-cheat gates apply to your fix too. The regression test you added is required: m-verify flags a modification or deletion of an existing test, fixture, conftest, grader, or CI config, not a new test file.
8. **Free exploration only after the fixed path stalls** — and end every failed attempt with a one-paragraph reflection: what failed, why, what to check next. Write it into your working notes and hand it to the next attempt; a retry without the previous reflection just repeats the attempt.

## Output

A `DEBUG REPORT` block: Symptom → Hypothesis table (each row marked falsified / untested / confirmed) → Root cause → Fix (file:line) → Evidence (repro + fix output) → Regression test (file:line) → Status (`DONE` / `DONE_WITH_CONCERNS` / `BLOCKED`). Always attach the failing-before and passing-after outputs of the regression check; name the failing content (the diff), not the assertion line. If any attempt failed, include its reflection paragraph.

## Stop conditions

- 3 hypotheses falsified in a row (each with its reflection written) → STOP. Do not attempt a 4th. Present: A) a new hypothesis (described), B) escalate for human review, C) add logging and wait.
- A fix spans more than ~5 files → STOP and ask: proceed, split to the critical path, or rethink for a tighter target.
- Symptom proves environmental / timing-dependent / external → document what you ruled out, then handle it (retry/timeout/message) and add monitoring. Note: most "no root cause" conclusions are just incomplete investigation.

## Harness notes

- Claude Code / Codex: use `git diff`, `git log`, `git blame`. Write the failing regression test first and run it red before you trust its pass — that rule is m-verify's "Prove new checks red first" (m-verify Procedure step 5, details in `m-verify/references/verify-gates.md`). Adding that new test is required and is not an anti-cheat failure. Exit codes and real output are your evidence.
- DSH: `subagent_claude_code` / `subagent_codex` make good second opinions on opposite model families when two competing hypotheses both look viable.
- When you tag temporary probes with a `[DEBUG-xxxx]` marker, a single grep cleans them up before you hand back.
