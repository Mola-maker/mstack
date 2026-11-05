# m-ship — fixing CI and answering PR comments

## Fixing CI

1. Resolve the active PR: `gh pr checks --json name,bucket,state,workflow,link`.
2. Pick the first actionable failure; read its log (`gh run view <id> --log-failed`, or the external check link). Find the root error, not the symptom.
3. Apply the smallest safe fix — minimal, low-risk before any refactor. Do not touch unrelated code.
4. Push, then re-check the whole set (`gh pr checks` remains the source of truth), and repeat.

Rules:
- One failure at a time.
- Never fix a test by editing its expected value unless the behavior actually changed and the assertion was pinned to the old behavior.
- Never skip hooks (`--no-verify`) or mark a check as not-required to get past it.
- `gh pr ready` only when every check is green and no unresolved review comments remain.

## Answering PR comments

1. Fetch comments: `gh pr view <n> --json comments,reviews` plus `gh api repos/{o}/{r}/pulls/{n}/comments` for inline threads.
2. Group by severity and whether a fix is unambiguous.
3. Act only on feedback you agree with:
   - Mechanical fix (rename, guard clause, formatting nit) → edit, quote the comment in the commit message.
   - Judgment call or unclear ask → do not guess; reply with what you would have done.
4. Reply to inline comments in their thread (`gh api .../comments/{id}/replies`), not as a top-level comment.

Stop conditions: three rounds of fix→push→recheck still not green → stop and summarize; next fix needs a design choice → ask.
