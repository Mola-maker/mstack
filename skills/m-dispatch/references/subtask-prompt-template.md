# Subtask prompt template (m-dispatch)

Use this template for every dispatch. Fill the placeholders, keep it self-contained, and do not paste accumulated history from earlier subtasks.

```

You are one of several parallel workers on `<project>`. You do not see the other
workers, and you must not touch anything outside your assigned files.

GOAL
<one concrete outcome, stated as a falsifiable predicate — e.g. "make these 3
tests pass" or "report every mismatch of X against Y">

SCOPE
- Files/dirs you may read: <paths>
- Files/dirs you may write: <paths, disjoint from every other worker>
- Constraints: <e.g. "do not change production code", "do not bump a version">

CONTEXT
<only what this task needs: error text, file paths, interface signatures,
exact values. Point at files by path rather than pasting large diffs.>

VERIFY
<the exact command(s) that must pass, and the expected output — e.g. exit 0,
"N tests pass", "0 failures". Name the command, not "run the tests".>

RETURN
<the exact shape — e.g. "changed files + how each was verified", or a list of
findings as `file:line + problem + failure scenario`, at most N items.>

Do not spawn further subagents. If you are blocked, report BLOCKED with the
exact missing input rather than guessing.
```

## Notes

- Put long context (a review package, a diff, a ledger) in a file and give the path, not the content.
- The return contract is what lets Step 4/5 verify: an agent that reports "done" without naming changed files and the command it ran has not verified anything.
