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

1. **Write the goal file.** Create `.mstack/goals/<slug>.md` (layout: `references/goal-file-format.md`) containing: the objective in one testable sentence, the ordered sub-goals (outcome first, not list order), each sub-goal's acceptance criteria, the per-task attempt cap, the stop conditions, and empty `## Amendments` / `## Closeout` placeholders. Break the brief into the smallest sub-goals that each end in a check (principle 3). Then, before the first edit: save the m-verify baseline — run the suite once and write one signature line per already-failing test to `.mstack/verify/baseline.txt` (format and rules in `m-verify`'s `references/verify-gates.md`; a green suite means an empty file) — and record the commit that baseline belongs to:
   `node "<this skill dir>/scripts/goal-state.mjs" init .mstack/goals <slug> --start-commit <sha>`
   `<this skill dir>` is the directory this SKILL.md was loaded from (Claude Code shows it as the skill base directory; in the mstack repo it is `skills/m-goal`). If that script file cannot be found, do this step by hand and say so in the report. `<sha>` is `git rev-parse HEAD`, or `none` when the repo has no commits yet.
2. **Order by risk.** Architectural decisions and core abstractions first, integration points next, spikes/unknowns, then polish and quick wins last — fail fast on risky work.
3. **Loop per sub-goal.** Pick the first not-done sub-goal; implement; verify each acceptance criterion with fresh evidence (run it, read the output — principle 4); only mark done when all criteria pass, not when the diff "looks right". Spend extra budget on several attempts plus selection between them, never on one bigger single pass; at a task's attempt cap, stop retrying and either route around it or escalate.
4. **Checkpoint after each sub-goal.** Append one row to the goal file's checkpoint table — fixed 5 columns `ts / decision / why / evidence / result`, append-only (a wrong entry is superseded by a new row, never edited). Then update the loop state `.mstack/goals/<slug>.state.json` with this exact command (`<this skill dir>`: see step 1):
   `node "<this skill dir>/scripts/goal-state.mjs" record .mstack/goals <slug> [--fail <signature>] [--progress] [--tokens N] [--budget PCT] [--status active|done|failed]`
   Pass `--fail <signature>` for every error signature that failed this round and `--progress` only when a sub-goal verifiably advanced (`result: pass`); `--progress` resets the consecutive-failure counters. `--tokens` and `--budget` are your own estimate against the cap declared in the goal file — no harness reports them. Read the printed verdict at every checkpoint: the same error signature failing 3 times **in a row**, or the budget at 100%, stops the loop; 90% warns. The script prints `ok` / `warn` / `stop` and exits 1 on `stop`. Exit 2 means the state file is unreadable or malformed: repair it by hand and rerun — never delete it to start the counters over.
5. **Final gate, fixed order.** When every sub-goal passes: run `m-deslop` on the changed files only, then `m-verify`, then `m-review`. A rejected review appends a new sub-goal and the loop continues — a goal is never marked done with review findings open.
6. **Write the closeout (mandatory).** Fill the `## Closeout` section of the same goal file (`.mstack/goals/<slug>.md`) — including the `gate` block and the Attention section, see Output — then stop.

Do not stall on the human for reversible decisions: proceed with a default, record it, and let them course-correct. Stop only for an irreversible or external action. If the same error recurs 3 times in a row, stop the loop, change the hypothesis (principle 9), and report — the state file's consecutive counters are what make "3 in a row" a count, not a memory.

## Output

`.mstack/goals/<slug>.md` (goal, sub-goals, checkpoints) plus `.mstack/goals/<slug>.state.json` (loop counters), with the closeout written as a `## Closeout` section inside the goal file. Give the user the standard report: one-line conclusion → what changed with evidence → what was not done / risks.

### Closeout content (written on every exit path)

The `## Closeout` section always contains these fields, in order:

- **status** — `done`, `failed`, `interrupted`, or `budget-exhausted`.
- **objective** — the goal's one-line objective.
- **result** — what was actually achieved against the acceptance criteria, with the evidence (commands + output) for each.
- **unfinished** — every sub-goal or criterion still open, and why.
- **known-issues** — errors that survived retries, one line each (what broke, what was tried).
- **lessons** — repeatable traps or decisions worth encoding in structure (principle 10); write nothing if there are none.
- **gate** — one line each for `m-deslop` / `m-verify` / `m-review`: pass or fail plus the proving command. A goal with a failed gate is not `done`.
- **Attention** — filled by a different model than the one that ran the loop: anything the next session must not miss. `无` is a valid entry.
- **resume-hint** — for `failed`/`interrupted`/`budget-exhausted`: what to read to resume (the goal file path, last checkpoint, blocker).

### Amend, never rewrite

Acceptance criteria can be amended but never silently edited. A refuted criterion stays verbatim under `## Amendments`, with the reason and the measured evidence that refuted it; an amendment without evidence is invalid. The closeout is checked against the active criteria only.

If the outcome was `done`, mark all sub-goals complete and note the reviewer verdict. If not, leave the goal file intact so a later `m-goal` resume or `m-handoff` continues from the last checkpoint. Never claim completion without a written closeout. m-handoff only links to this closeout; it never writes one.

## Stop conditions

Write the closeout and stop when the objective is met, or the user says stop/cancel, or the state file shows the same error signature 3 times in a row, or the budget hits 100% (warn at 90%). Ask the user only for an irreversible, external, or genuinely-undecidable choice (principle 8); every reversible decision gets a recorded default instead.

## Harness notes

- Claude Code: a persistent goal can pair with its native goal mechanism, but state lives in `.mstack/goals/` so it survives restarts; DSH and Codex both read/write the same file.
- Budget cap: DSH `max_goal_rounds` or a token budget maps to the `budget-exhausted` closeout; none of the harnesses auto-write it, so m-goal must write it before exiting.
- Headless (Codex/DSH) runs have no one to ask: record every guess as an assumption in the goal file rather than waiting.
- `scripts/goal-state.mjs` needs Node (zero dependencies). Without Node, edit `.mstack/goals/<slug>.state.json` by hand — the schema is in `references/goal-file-format.md` — and still apply the 3-in-a-row / 90% / 100% rules. On closeout, set the file's `status` to `done` or `failed` (`--status`, or by hand) so a stale check can tell this goal is finished.
