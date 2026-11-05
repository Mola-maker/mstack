---
name: m-goal
description: "Long-running goal loop with a persistent goal file, checkpoints, stop conditions, and a mandatory closeout written on every exit path. Use for multi-day/multi-session work, \"run until done\", \"别停/一直做到完成\"."
whenToUse: "When work spans many steps or sessions and must keep going to a defined outcome without stalling on the human, and always ends by writing a closeout file."
---

# m-goal — 长跑目标循环

m-goal drives a long-running objective to completion across checkpoints and session restarts, converging on the target outcome rather than pausing for approval. It keeps a durable goal file so a resume never loses work, and it writes a closeout file on every single exit path — done, failed, interrupted, or budget exhausted.

## When to use / not use

Use for "keep going until done", multi-phase or multi-session work, or anything the user walks away from ("going to bed", "trust it when I'm back"). Do not use for a single focused fix, a bounded plan (use `m-plan` then `m-dispatch`), or pure planning with no execution loop. If the goal is an open-ended optimization target — a metric like performance, score, or pass rate that should keep climbing — hand the loop to `m-team`, which re-forms an agent team round by round; m-goal still owns the goal file and writes the closeout when `m-team` returns. If work is reversible, proceed and report rather than asking.

## Procedure

1. **Write the goal file.** Create `.mstack/goals/<slug>.md` containing: the objective in one testable sentence, the ordered sub-goals (outcome first, not list order), each sub-goal's acceptance criteria, the stop conditions, and the closeout placeholder. Break the brief into the smallest sub-goals that each end in a check (principle 3).
2. **Order by risk.** Architectural decisions and core abstractions first, integration points next, spikes/unknowns, then polish and quick wins last — fail fast on risky work.
3. **Loop per sub-goal.** Pick the first not-done sub-goal; implement; verify each acceptance criterion with fresh evidence (run it, read the output — principle 4); only mark done when all criteria pass, not when the diff "looks right".
4. **Checkpoint after each sub-goal.** Append a line to the goal file (or ledger): what was done, files changed, evidence, and any ruling/assumption. This is the resume point for a compacted or restarted session.
5. **Verify the whole thing.** At the end, a fresh reviewer (not the author — principle 6) checks the completed outcome against the acceptance criteria. Fix and re-verify on rejection.
6. **Write the closeout (mandatory).** On completion, record it and stop.

Do not stall on the human for reversible decisions: proceed with a default, record it, and let them course-correct. Stop only for an irreversible or external action. If the same error recurs 3 times, stop the loop, change the hypothesis (principle 9), and report.

## Output

`.mstack/goals/<slug>.md` (goal, sub-goals, checkpoints) and its closeout section/file `.mstack/goals/<slug>-closeout.md`. Give the user the standard report: one-line conclusion → what changed with evidence → what was not done / risks.

### Closeout content (written on every exit path)

The closeout file always contains these fields, in order:

- **status** — `done`, `failed`, `interrupted`, or `budget-exhausted`.
- **objective** — the goal's one-line objective.
- **result** — what was actually achieved against the acceptance criteria, with the evidence (commands + output) for each.
- **unfinished** — every sub-goal or criterion still open, and why.
- **known-issues** — errors that survived retries, one line each (what broke, what was tried).
- **lessons** — repeatable traps or decisions worth encoding in structure (principle 10); write nothing if there are none.
- **resume-hint** — for `failed`/`interrupted`/`budget-exhausted`: what to read to resume (the goal file path, last checkpoint, blocker).

If the outcome was `done`, mark all sub-goals complete and note the reviewer verdict. If not, leave the goal file intact so a later `m-goal` resume or `m-handoff` continues from the last checkpoint. Never claim completion without a written closeout.

## Stop conditions

Write the closeout and stop when the objective is met, or the user says stop/cancel, or the same error persists 3 times, or a budget/round cap is reached. Ask the user only for an irreversible, external, or genuinely-undecidable choice (principle 8); every reversible decision gets a recorded default instead.

## Harness notes

- Claude Code: a persistent goal can pair with its native goal mechanism, but state lives in `.mstack/goals/` so it survives restarts; DSH and Codex both read/write the same file.
- Budget cap: DSH `max_goal_rounds` or a token budget maps to the `budget-exhausted` closeout; none of the harnesses auto-write it, so m-goal must write it before exiting.
- Headless (Codex/DSH) runs have no one to ask: record every guess as an assumption in the goal file rather than waiting.
