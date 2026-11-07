# Closeout content (m-goal)

Read this at step 6 and whenever a loop exits. The `## Closeout` section always contains these fields, in order:

- **status** — `done`, `failed`, `interrupted`, or `budget-exhausted`.
- **objective** — the goal's one-line objective.
- **result** — what was actually achieved against the acceptance criteria, with the evidence (commands + output) for each.
- **unfinished** — every sub-goal or criterion still open, and why.
- **known-issues** — errors that survived retries, one line each (what broke, what was tried).
- **lessons** — repeatable traps or decisions worth encoding in structure (principle 10); write nothing if there are none.
- **gate** — one line each for `m-deslop` / `m-verify` / `m-review`: pass or fail plus the proving command. A goal with a failed gate is not `done`.
- **Attention** — filled by a different model than the one that ran the loop: anything the next session must not miss. `无` is a valid entry.
- **resume-hint** — for `failed`/`interrupted`/`budget-exhausted`: what to read to resume (the goal file path, last checkpoint, blocker).

## Amend, never rewrite

Acceptance criteria can be amended but never silently edited. A refuted criterion stays verbatim under `## Amendments`, with the reason and the measured evidence that refuted it; an amendment without evidence is invalid. The closeout is checked against the active criteria only.

If the outcome was `done`, mark all sub-goals complete and note the reviewer verdict. If not, leave the goal file intact so a later `m-goal` resume or `m-handoff` continues from the last checkpoint. Never claim completion without a written closeout. m-handoff only links to this closeout; it never writes one.


## Gate verdicts

`m-review` passes iff it has no confirmed in-scope finding and no axis marked `issues`; Unconfirmed and Cleared items do not block. Record the verdict line it printed in the `gate` field.

## Ruling lines

Every judgement call the skill does not cover goes in the goal file's checkpoint table as `Ruling: decision | reason | cost if wrong` (in the `decision` cell, with the three parts separated by `|` escaped as `/`). Read them back when writing `result` and `known-issues`.
