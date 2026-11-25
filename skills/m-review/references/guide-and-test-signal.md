# m-review — review guide and test signal (optional axes)

Both come from T3 Code's review tooling. Neither changes the verdict: they make a reviewed change cheaper for the person who has to read or land it.

## Review guide (for the human who reads the PR)

Write it after the findings, into `.mstack/reviews/<date>-<slug>-guide.md`, when the change goes to a person (`mola land`, a PR) or when asked.

A tour, not a summary:

1. **Stops in reading order.** Start where the change begins to matter (the new entry point, the changed contract), then follow the data. Each stop names `file:line-range` and says in one or two lines what to look at and why.
2. **`Look closely` marks** go only on stops that need a call the author or a maintainer must make: a product choice, a compatibility trade, a security assumption. Not on code that is merely long.
3. **Mechanical changes last, grouped.** Renames, moves, generated files, snapshot and lockfile updates go in one closing stop with their file list.
4. **Every changed file appears somewhere.** Check it: list `git diff --name-only <base>` (plus untracked files) and tick each one off against the stops. A file the tour skips is a defect in the guide.
5. Leave out what review already resolved (CLEARED lines, fixed findings).
6. For a stacked PR, cover this layer only; say what a lower layer introduced only where this layer depends on it.

Template:

```
# Guide: <PR title>
Base: <ref> · <n> files · read in this order

1. <file:lines> — <what and why>
2. <file:lines> — Look closely: <the call to make>
…
Last. Mechanical: <files>
Coverage: <n>/<n> changed files on the tour
```

## Test signal (fewer, better tests)

Agents pad changes with tests that protect nothing. Review only tests the diff adds or grows; moved, renamed or deleted tests are not findings. Ask only for fewer or smaller tests, never for more coverage.

Flag a new test when it:

- tests what the type system or the language already guarantees, trivial getters, copy text, or props rendered to static markup;
- mirrors mock calls or callback wiring instead of behaviour that can break;
- repeats a case one layer up or down (keep the lowest layer that fails without the fix);
- adds a new test where an existing table or case could take one more row;
- waits on wall-clock time: `sleep`, polling loops, per-test timeouts, retries, `Date.now()` deltas. Await the event or drain the queue instead; a test that needs a timeout to pass is wrong;
- skips without a tracking reference.

Each finding: `TEST-SIGNAL file:line | <rule> | <fix: fold into X / delete / move to unit>`. When nothing qualifies, the whole axis is one line: `test signal: all clear`.

Run it on the cheapest model that follows the rules (the `bulk` role); it reads only the test diff and the files those tests import.
