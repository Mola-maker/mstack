# Goal file layout (`.mstack/goals/<slug>.md`)

Read this when m-goal step 1 creates the goal file, and when writing the closeout. One file per goal; the slug also names the loop-state file `<slug>.state.json` next to it.

## Skeleton

```markdown
# Goal: <one testable sentence>

- Created: <ISO timestamp>
- Budget: attempt cap <N> per task, round cap <N>, token budget <N or "none">
- Stop conditions: <what ends the loop besides "objective met">

## Sub-goals (ordered by risk)

1. [ ] <sub-goal> — acceptance criteria: <each criterion, checkable by a command>
2. [ ] ...

## Checkpoints

| ts | decision | why | evidence | result |
|----|----------|-----|----------|--------|
| <ISO> | <what was decided/done> | <reason> | <command + key output> | <pass/fail/next> |

## Amendments

<refuted criteria kept verbatim, one block each: original text / reason / measured evidence / ts>

## Closeout

(filled on every exit path — see SKILL.md "Closeout content")
```

## Rules that the layout enforces

- **Checkpoints are append-only**, exactly the 5 columns above. Never edit or delete a row; a mistake is corrected by a new row that supersedes it. Keep each cell to one line.
- **Budget prefers breadth over depth.** The attempt cap limits retries of a single task; spare budget goes to another attempt plus selection, not to a larger single pass.
- **Amendments keep the original wording.** Changing a criterion without moving the old text here is a silent edit and is not allowed. Closeout judges only the criteria still active.
- **The `gate` block and the Attention section live inside `## Closeout`**, not here — they only exist once the loop ends.

## Loop state (`.mstack/goals/<slug>.state.json`)

Updated at every checkpoint by `scripts/goal-state.mjs` (exact commands in SKILL.md step 4; `<this skill dir>` there is the directory this file's skill was loaded from). Without Node, edit the file by hand and still apply the rules below:

```json
{
  "slug": "<slug>",
  "status": "active",
  "startCommit": "<sha of HEAD when the baseline was saved, or null>",
  "rounds": 0,
  "tokensUsed": 0,
  "budgetPct": 0,
  "failures": { "<error-signature>": 0 },
  "lastProgressAt": "<ISO timestamp or null>",
  "updatedAt": "<ISO timestamp>"
}
```

- `status` is `active` while the loop runs, `done` when the closeout is `done`, `failed` otherwise. m-start's stale check reads this field (a goal file heading is not a status).
- `startCommit` is the commit the m-verify baseline was saved against, recorded by `goal-state.mjs init` before the first edit.
- `failures` counts **consecutive** occurrences of each error signature (a short stable string: the failing command + key error line). A `--progress` record resets every counter to 0, so a signature that failed, then passed, then failed again is back at 1 — matching principle 9's "3 in a row", not a lifetime total. Any signature reaching 3 consecutive stops the loop.
- `budgetPct` is the agent's own estimate of the declared budget consumed (no harness reports tokens consumed). `tokensUsed` is the same kind of estimate. Warn at ≥90, stop at ≥100.
- `lastProgressAt` moves only on a `--progress` record (a checkpoint with `result: pass`); a stalled timestamp means the loop is spinning.
- Verdict at each checkpoint: `stop` if any signature ≥3 consecutive or `budgetPct` ≥100; `warn` if `budgetPct` ≥90; otherwise `ok`.
- A state file that exists but cannot be parsed is an error (the script exits 2 and changes nothing). Repair it by hand — never start the counters over, which would erase the strikes already counted.
