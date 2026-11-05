---
name: m-debug
description: "Root-cause a bug or failing test: reproduce, competing hypotheses, regression test. Use for debug一下/为什么报错/这个测试挂了."
whenToUse: "A test fails, code errors, output is wrong, or a build is broken — before any edit that claims to fix it."
---

# m-debug

Symptom fixes fail. Find the first place the system did the wrong thing, prove it, and fix it there — never at the place the wrong state merely surfaced.

## When to use / not use

Use for any technical failure: tests, prod bugs, wrong output, perf, build, integration. Use it *especially* under time pressure or when "one quick fix" looks obvious.

Do NOT use it to fix a bug you haven't reproduced, or to change code before knowing the cause. If the same error has already failed 3 fix attempts, stop and reconsider the architecture instead. For "why was X designed this way" (rationale, not failure), that's investigation of intent — not this skill.

## Procedure

1. **Read the error completely.** Stack trace, line numbers, file paths, error codes — the message often names the answer.
2. **Reproduce consistently.** Write down the exact minimal steps; if it won't reproduce, gather more data rather than guessing.
3. **Check recent changes.** `git diff`, last commits, new deps, config or environment differences.
4. **Form competing hypotheses.** Write down at least two candidate causes, stated as "X is the cause because Y". Deliberately different, not the same idea restated.
5. **Trace to the source.** For each fact you rely on, name the file it came from; for a deep failure, walk the data flow backward from the symptom to the origin and note *where* it first went wrong.
6. **Test the cheapest discriminator.** Change one variable at a time, as small as possible, to separate the leading hypothesis from the runner-up. Prefer falsifying your favorite; if it doesn't reproduce, re-rank.
7. **Fix at the root.** Make the smallest change at the origin; check for the pattern, not just this instance.

## Output

A `DEBUG REPORT` block: Symptom → Root cause → Fix (file:line) → Evidence (repro + fix output) → Regression test (file:line) → Status (`DONE` / `DONE_WITH_CONCERNS` / `BLOCKED`). Always attach the failing-before and passing-after outputs of the regression check; name the failing content (the diff), not the assertion line.

## Stop conditions

- 3 hypotheses falsified in a row → STOP. Do not attempt a 4th. Present: A) a new hypothesis (described), B) escalate for human review, C) add logging and wait.
- A fix spans more than ~5 files → STOP and ask: proceed, split to the critical path, or rethink for a tighter target.
- Symptom proves environmental / timing-dependent / external → document what you ruled out, then handle it (retry/timeout/message) and add monitoring. Note: most "no root cause" conclusions are just incomplete investigation.

## Harness notes

- Claude Code / Codex: use `git diff`, `git log`, `git blame`; write the failing test first (see `m-verify`). Exit codes and real output are your evidence.
- DSH: `subagent_claude_code` / `subagent_codex` make good second opinions on opposite models when two competing hypotheses both look viable.
- When you tag temporary probes with a `[DEBUG-xxxx]` marker, a single grep cleans them up before you hand back.
