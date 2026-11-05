# m-review — parallel review template

Give each reviewer the diff as input (a path or the branch range), the base to diff against, and the goal/scope the change was meant to achieve. Never hand them your own findings or conclusions first.

## Shared reviewer prompt (fill in the placeholders, one reviewer per angle)

```
You are reviewing a code change. Report only real, verifiable problems.

Change: {git diff <BASE>...HEAD} or {uncommitted diff}
Base: {BASE_SHA}
Scope/intent: {what the work was supposed to do}

Review for ONE angle only: {ANGLE}.

Rules:
- Read the whole diff before commenting.
- Verify every finding against the actual code; drop anything already handled
  elsewhere in the diff or that cannot actually fail.
- Return ONLY findings in this form, one per line:
  file:line | problem | failure scenario
- "no findings" is a valid result. Do not pad.
```

`{failure scenario}` must name what actually breaks — a test that fails, a user action that returns the wrong result, an attacker who crosses a boundary — never a vague "looks wrong".

## The five angle definitions

1. **correctness** — logic errors, edge cases, error paths, off-by-one, wrong types, missing null/empty handling.
2. **concurrency/resources** — data races, deadlocks, leaked handles/goroutines, unbounded maps or buffers, teardown/unmount bugs, timers.
3. **api/compatibility** — changed public signatures, broken semver, missing migration, renamed config/flag, platform or dependency-version drift.
4. **tests/edges** — behavior that ships untested, assertions pinned to old behavior, missing boundary or failure-path cases, flaky/order-dependent tests.
5. **security** — trust boundaries, injection, broken authz, secret handling, destructive or irreversible operations, untrusted input into sinks.

## Merging the five results

- Deduplicate findings by `file:line` + root cause.
- Keep each angle's verdict separate; do not cross-rank or pick a single winner.
- Order the merged list most-severe first; label severity honestly (critical / important / minor).

## Reception rules (when you are told to act on a review)

- Verify before implementing: check the finding against the codebase, check it does not break existing behavior or contradict an existing architectural decision.
- If several items, clarify all unclear ones *first*, then implement blocking bugs → simple fixes → complex fixes, testing each.
- Answer with one-line fix + evidence, never gratitude or performative agreement. Push back with `file:line`/test results when a finding is wrong.
