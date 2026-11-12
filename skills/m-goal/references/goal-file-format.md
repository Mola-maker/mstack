# Goal file layout (`.mstack/goals/<slug>.md`)

Read this when m-goal step 1 creates the goal file, and when writing the closeout. One file per goal; the slug also names the loop-state file `<slug>.state.json` next to it.

## Skeleton

```markdown
# Goal: <one testable sentence>

- Created: <ISO timestamp>
- Budget: attempt cap <N> per task, min rounds <N, default 3>, round cap <N>, token budget <N or "none">
- Stop conditions: <what ends the loop besides "objective met">
- Boundaries: <worktree or branch, what it may write, what it must not run>
- Output & approver: <where the result lands, who signs off on irreversible actions>

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

(filled on every exit path — fields in references/closeout.md)
```

## Rules that the layout enforces

- **`Boundaries` and `Output & approver` must be filled in** (not left as the `<...>` placeholder) before the loop starts: `goal-state.mjs init` exits 2 and writes nothing if the goal file exists and either line is missing or unchanged.

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
  "minRounds": 3,
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
- `rounds` counts only `record --round` calls, one per completed verify pass over the acceptance criteria; other records never raise it. `minRounds` is set by `init --min-rounds N` (default 3) and must match the goal file. `record --status done` exits 1 and leaves the status unchanged while `rounds` < `minRounds`; `failed` and `budget-exhausted` are not limited.
- Verdict at each checkpoint: `stop` if any signature ≥3 consecutive or `budgetPct` ≥100; `warn` if `budgetPct` ≥90; otherwise `ok`.
- A state file that exists but cannot be parsed is an error (the script exits 2 and changes nothing). Repair it by hand — never start the counters over, which would erase the strikes already counted.
