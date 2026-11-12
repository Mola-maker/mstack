---
name: m-goal
description: "Long-running goal loop: goal file, checkpoints, stop rules, mandatory closeout. Use for run-until-done work, 别停/一直做到完成."
whenToUse: "When work spans many steps or sessions and must keep going to a defined outcome without stalling on the human, and always ends by writing a closeout section in the goal file."
---

# m-goal — 长跑目标循环

m-goal drives a long-running objective to completion across checkpoints and session restarts, converging on the target outcome rather than pausing for approval. It keeps a durable goal file so a resume never loses work, and it fills that file's `## Closeout` section on every single exit path — done, failed, interrupted, or budget exhausted.

## When to use / not use

Use for "keep going until done", multi-phase or multi-session work, or anything the user walks away from ("going to bed", "trust it when I'm back"). Do not use for a single focused fix, a bounded plan (use `m-plan` then `m-dispatch`), or pure planning with no execution loop. If the goal is an open-ended optimization target — a metric like performance, score, or pass rate that should keep climbing — hand the loop to `m-team`, which re-forms an agent team round by round; m-goal still owns the goal file and writes the closeout when `m-team` returns. If work is reversible, proceed and report rather than asking.

## Procedure

Using m-goal: <one-line objective> — say this first, before any tool call.

**Iron Law: NO `done` STATUS WITHOUT A WRITTEN CLOSEOUT, A PASSING GATE, AND AT LEAST THE MINIMUM ROUNDS.**
No exceptions: do not write the closeout "after one more try", in a second file, or from memory of the run; do not loosen a criterion to reach it (amend it, step 6); do not stop on a first lucky pass; do not replace the counter script with your recollection.

| You will be tempted to think… | Reality |
|---|---|
| "I'll write the closeout when I've finished the last fix." | The loop dies where you do not expect (a freeze hook denied the write; the session ended). The closeout is written on the exit path, not after it (reviews/2026-11-06-round2.md #10). |
| "The state script is not at that path, so I'll count failures myself." | A memory count is no count; the 3-in-a-row rule then does not exist (round2 #1). Find the script from the skill dir, or do it by hand and say so in the report. |
| "The suite is red already, I'll save the baseline after my first edits." | A late baseline bakes your own failures in; no baseline blocks the task forever (round2 #6). Save it before the first edit. |
| "The review had one unconfirmed finding, so the review failed." (or "so it is fine") | Neither: pass means no confirmed in-scope finding and no axis `issues` (round2 #7). Anything else is a Ruling line. |
| "The metric hit target once, we are done." | One lucky run ends the loop early; the stop predicate is target AND min-rounds (research/round3/pstack-craft.md T5). |
| "The closeout can go in its own file." | Resume reads only the goal file and re-does a finished goal (reviews/2026-11-04-acceptance.md #4). |

Red flags — you are breaking the skill now: you typed "done" with no `## Closeout` status line; the state file's `rounds` is below the minimum and you are writing `done`; you are on a fourth attempt at the same signature; you rewrote a checkpoint row; you edited an acceptance line in place.

1. **Write the goal file.** Create `.mstack/goals/<slug>.md` (layout: `references/goal-file-format.md`) containing: the objective in one testable sentence, the ordered sub-goals (outcome first), each sub-goal's acceptance criteria, the per-task attempt cap, the **minimum rounds** (default 3; a number you set before starting), the stop conditions, the `Boundaries` line (what the run may touch) and the `Output & approver` line (where the result lands, who approves irreversible actions), and empty `## Amendments` / `## Closeout` placeholders. A goal that repeats one action over many items runs 3 items first, reads the results, then runs the rest. Break the brief into the smallest sub-goals that each end in a check (principle 3). Then, before the first edit: save the m-verify baseline — run the suite once and write one signature line per already-failing test to `.mstack/verify/baseline.txt` (format in `m-verify`'s `references/verify-gates.md`; a green suite means an empty file) — and record the commit that baseline belongs to:
   `node "<this skill dir>/scripts/goal-state.mjs" init .mstack/goals <slug> --start-commit <sha> --min-rounds <N>`
   `<this skill dir>` is the directory this SKILL.md was loaded from (Claude Code shows it as the skill base directory). If the script cannot be found, do this step by hand and say so in the report. `<sha>` is `git rev-parse HEAD`, or `none` when the repo has no commits.
2. **Order by risk.** Architectural decisions and core abstractions first, integration points next, spikes/unknowns, then polish last — fail fast on risky work.
3. **Loop per sub-goal.** Pick the first not-done sub-goal; implement; verify each acceptance criterion with fresh evidence (run it, read the output — principle 4); mark done only when all criteria pass. Spend extra budget on several attempts plus selection between them, never on one bigger single pass; at a task's attempt cap, route around it or escalate.
4. **Checkpoint after each sub-goal.** Append one row to the checkpoint table — fixed 5 columns `ts / decision / why / evidence / result`, append-only (a wrong entry is superseded by a new row). Then update the loop state with this exact command:
   `node "<this skill dir>/scripts/goal-state.mjs" record .mstack/goals <slug> [--round] [--fail <signature>] [--progress] [--tokens N] [--budget PCT] [--status active|done|failed]`
   Pass `--round` once per completed verify pass over the acceptance criteria (a round is that, not a record call); pass `--fail <signature>` for every error signature that failed this round and `--progress` only when a sub-goal verifiably advanced (`result: pass`); `--progress` resets the consecutive counters. `--tokens` and `--budget` are your own estimate against the cap in the goal file. The script prints `ok` / `warn` / `stop` plus `rounds=N min=M`, and exits 1 on `stop`, including when `--status done` is rejected for rounds below the minimum; read it every time. Exit 2 means the state file is unreadable: repair it by hand, never delete it to reset the counters.
5. **Final gate, fixed order.** Only when every sub-goal passes and `rounds` is at least the minimum: `m-deslop` on the changed files only, then `m-verify`, then `m-review`. A failed review appends a new sub-goal and the loop continues.
6. **Write the closeout (mandatory).** Fill `## Closeout` in the same goal file with the fields in `references/closeout.md` (including the `gate` block and Attention), then stop. A criterion proven wrong is amended there, never edited in place.

Ruling record: any decision this skill does not cover becomes one line `Ruling: decision | reason | cost if wrong` in the checkpoint table (see `references/closeout.md`). Reversible decisions never wait for the user: take the default, record it, continue.

Gate function — before writing `done` or any success claim:

| claim | evidence required | evidence that is NOT enough |
|---|---|---|
| objective met | each acceptance command run this round, output read | the diff looks right; an earlier round passed |
| loop may stop | target met AND `rounds` ≥ minimum in the script line | one lucky pass; your own tally |
| gate passed | one proving command per `m-deslop` / `m-verify` / `m-review` | "no complaints"; a sub-agent said ok |

## Output

`.mstack/goals/<slug>.md` (goal, sub-goals, checkpoints, `## Closeout`) plus `.mstack/goals/<slug>.state.json` (loop counters). Closeout fields, in order, and the amend rule are in `references/closeout.md`. Report in the standard shape: one-line conclusion → what changed with evidence → what was not done / risks. If the outcome was `done`, mark all sub-goals complete and note the reviewer verdict; if not, leave the goal file intact so a later resume or `m-handoff` continues from the last checkpoint. Never claim completion without a written closeout. m-handoff only links to the closeout; it never writes one.

## Stop conditions

Write the closeout and stop when: the objective is met AND `rounds` ≥ minimum; the user says stop/cancel; one error signature fails 3 times in a row; or the budget reaches 100% (warn at 90%). Fewer rounds than the minimum with the objective met means run another verification round, not stop. Ask the user only for an irreversible, external, or genuinely-undecidable choice (principle 8). After the third identical failure change the hypothesis (principle 9) — there is no fourth try.

## Harness notes

- Claude Code: a persistent goal can pair with its native goal mechanism, but state lives in `.mstack/goals/` so it survives restarts; DSH and Codex both read/write the same file.
- Budget cap: DSH `max_goal_rounds` or a token budget maps to the `budget-exhausted` closeout; none of the harnesses auto-write it, so m-goal must write it before exiting.
- Headless (Codex/DSH) runs have no one to ask: record every guess as an assumption in the goal file rather than waiting.
- `scripts/goal-state.mjs` needs Node (zero dependencies). Without Node, edit `.mstack/goals/<slug>.state.json` by hand — the schema is in `references/goal-file-format.md` — and still apply the 3-in-a-row / 90% / 100% rules. On closeout, set the file's `status` to `done` or `failed` (`--status`, or by hand) so a stale check can tell this goal is finished.
