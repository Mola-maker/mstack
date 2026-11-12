# Subtask prompt template (m-dispatch)

Use this template for every dispatch. Fill the placeholders, keep it self-contained, and do not paste accumulated history from earlier subtasks.

```

You are one of several parallel workers on `<project>`. You do not see the other
workers, and you must not touch anything outside your assigned files.

GOAL
<one concrete outcome, stated as a falsifiable predicate — e.g. "make these 3
tests pass" or "report every mismatch of X against Y">

WHY
<one or two lines: who needs this and what it unblocks, so the worker can
judge the calls this brief did not foresee>

SCOPE
- Files/dirs you may read: <paths>
- Files/dirs you may write: <paths, disjoint from every other worker>
- Constraints: <e.g. "do not change production code", "do not bump a version">

OUT OF SCOPE
<the nearby things a reasonable worker would also fix, and must leave alone>

CONTEXT
<only what this task needs: error text, file paths, interface signatures,
exact values. Point at files by path rather than pasting large diffs.>

VERIFY
<the exact command(s) that must pass, and the expected output — e.g. exit 0,
"N tests pass", "0 failures". Name the command, not "run the tests".>

RETURN
<the exact shape — changed files (or "no files changed") plus the VERIFY
command and the output you actually saw, or findings as
`file:line + problem + failure scenario`, at most N items. If this brief
names a SHA or a method, record both.>

Do not spawn further subagents. If you are blocked, report BLOCKED with the
exact missing input rather than guessing. Do not claim the selection rule;
the parent already wrote first pass, rank all, or best-of outside this prompt.
```

## Notes

- Leave out what the worker would read in the repo anyway (layout, conventions, test setup). Spend the words on what the repo cannot show: a decision, why the task matters, what done means this time.
- Put long context (a review package, a diff, a ledger) in a file and give the path, not the content.
- Evidence is the command, the output, and the changed files, plus any SHA or method the brief required. A RETURN that omits them is a gap: the parent re-dispatches that worker once, naming the missing field. A second miss stays a gap and does not count as a pass. Do not invent the missing output.
