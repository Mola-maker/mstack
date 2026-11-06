# m-verify — gate details

Per FRAMEWORK §11.1: baseline gate, anti-cheat gate, and the mechanical scan live in the Procedure; this file holds the formats and recipes they need. Sources that motivated each rule are noted at the end.

## Baseline gate (`.mstack/verify/baseline.txt`)

Write it before your first edit, when the suite is already red. One line per already-failing test:

```
<suite>|<test id>|<short reason>
```

- `<suite>`: the command's natural unit — pytest `path/to/test_file.py`, vitest/jest file path, `cargo test` test module, `go test` package.
- `<test id>`: the name the runner prints for the failing case (`test_login_rejects_empty_email`), or `ALL` when the unit fails as a whole (import error, compile error) and no case name is printed.
- `<short reason>`: ≤60 chars from the failure output, e.g. `TypeError: cannot read properties of undefined`.

Rules:

- Append or overwrite as a whole — it is your file, not a shared log. Committing it is up to the project; do not commit it into the feature diff unless asked.
- After each run, compute each failure's signature the same way. In baseline → warning (report the count and names, do not block). Not in baseline → blocker; the task is not done.
- If a baseline failure disappears, note it (your change probably fixed it) and remove the line so the baseline does not rot.
- A changing baseline (new entries appearing while you work) means you are breaking other things — treat every new entry as a blocker regardless of cause.
- If the first run is green, skip the file. No baseline file present later = every failure is new.

## Anti-cheat gate

The diff is compared against the task brief, not against your intentions.

- **Existing protected paths — modify or delete only.** An existing test, fixture, conftest, grader or scoring script, or CI config (`.github/`, `.gitlab-ci.yml`) that this diff modifies or deletes → FAIL this round, unless the task asked for that change or you justify it with evidence (quote the command and the output). Report the file. Do not silently revert, and do not delete a new regression test to make the gate quiet.
- **New tests are required, never flagged.** A purely added test file (`m-plan`'s failing test, `m-debug`'s regression test, a red-first check from Procedure step 5) is not a violation. `diff-blockers.mjs` does not enforce this path rule; it only flags marker text in added lines.
- **Agent-created test infrastructure is not evidence.** Do not accept a green run that depends on an agent-created `conftest.py`, pytest plugin, `sitecustomize.py`, or `node_modules/.bin` shim. Those can rewrite outcomes. A new test file is not one of these. Check `git status --porcelain` and `git diff --stat <base>`.
- **History is not evidence.** A "done" claim that leans on `git log` ("this worked in an earlier commit") or on future/unmerged branches is not evidence.
- **Clean-checkout recipe.** The worktree must contain the change under test. Use this recipe: **commit on the work branch first, then add a worktree at that commit.** Do not check out an older HEAD. Do not use the alternative of applying the working diff into a fresh worktree (that drops rename edges and untracked files).

  ```sh
  # On the work branch, not the default branch. Stage the paths the scope line
  # names, including new files that are part of the change — not `git add -A`
  # unless every untracked file belongs to the change.
  git add <paths> && git commit -m "wip: acceptance"
  sha=$(git rev-parse HEAD)
  git worktree add "../accept-$sha" "$sha"
  git -C "../accept-$sha" rev-parse HEAD          # must print $sha
  # run the full suite inside the worktree and read the output, then:
  git worktree remove --force "../accept-$sha"
  ```

  If the project needs generated files, secrets, or services, copy only those into the worktree, from a source you did not edit this task. If the work branch cannot take a commit, do not substitute a worktree of the old HEAD — report that final acceptance did not run.
- If a clean checkout is genuinely impossible (missing secrets, external services), say so in the report and run the next best thing in a pruned workspace (`git stash -u` then rerun); a pruned run is weaker evidence — label it.

## Mechanical scan

`node "<this skill dir>/scripts/diff-blockers.mjs" [base-ref]`

`<this skill dir>` is the directory this skill's SKILL.md was loaded from (Claude Code shows it as the skill base directory; in the mstack repo it is `skills/m-verify`). If that file cannot be found, scan the added lines by hand and say so in the report.

- Compares the working tree to `<base-ref>` (`git diff <base>`, so commits since that ref are included) and also scans every untracked file (`git ls-files --others --exclude-standard`) as all-added. No argument = uncommitted changes versus HEAD, plus untracked files.
- When `m-goal` is driving, pass the recorded start commit: `startCommit` in `.mstack/goals/<slug>.state.json` (saved by `goal-state.mjs init` before the first edit). That is base versus the working tree. A clean `git diff HEAD` after a later commit has scanned nothing — do not treat that exit 0 as a scan of the work.
- Blockers: `.only(`, `.skip(`, `TODO`, `FIXME`, `not implemented` / `not_implemented` / `NotImplemented` (case-insensitive), `debugger`.
- Exit 0 clean, 1 blockers (not done), 2 could not run (usage error, git missing, unknown ref, unreadable untracked file).
- The match is literal: prose that names the markers (a README or this reference itself) trips it too. Judge those hits by hand and say so in the report — do not delete the prose silently, and do not wave the exit code away.
- It only sees added lines (the diff, plus untracked files). It does not enforce the anti-cheat path rule; a new test file is not a hit unless an added line contains a marker. A deleted existing test is the anti-cheat gate, not this scan. The scan is one gate, not the verdict.
- Tests: `node --test "<this skill dir>/scripts/*.test.mjs"` (quote the glob; a bare directory fails on Node 24).

## Why these gates exist

- Baseline: a repo that is already red otherwise either blocks the agent forever or tempts it to eyeball-diff the failure list (OMC's ralph Precondition Feedback Gate; mstack research `research/omc.md` row 1).
- Red-first: a check that never failed on anything proves nothing (pstack tdd / create-verification-skill; `research/pstack.md` row 2).
- Anti-cheat + clean checkout: reward-hacking benchmarks show models editing tests or planting conftest overrides; held-out and fresh-environment runs are the counter (EvilGenie, BenchJack, SWE-Bench Pro Verified; `research/papers.md` #10–#12).
- Scan: the OMC workflow-drift-guard hook is a regex on the diff, not a prose judgement; the same idea as a skill-runnable script (`research/omc.md` row "Deterministic fake-completion scan").
- Numbers with run count and spread: pstack "explain the number" (`research/pstack.md` row 6).
- Different model family for cross-checks: LLM judges prefer outputs that look like their own (self-preference, `research/papers.md` #16).
