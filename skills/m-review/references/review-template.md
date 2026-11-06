# m-review — review template

Read this before writing the first reviewer prompt. Give each reviewer the diff (a path or a range), the base, and the plan or spec. Do not give them your conclusions, the author's name, or any line that says a side is already correct.

## Scope rules

- Report only code the diff adds or replaces, plus untracked files (`git ls-files --others --exclude-standard`). A bug in untouched tracked lines is out of scope, even if you noticed it. An empty `git diff` does not drop a finding in a new file.
- Cite the new-file line of an added or replacement line (`path:line`). For a pure deletion, cite `path:0`.
- If the author meant the break, and the diff's blast radius is explicit (one function, one flag, one migration), put it under Cleared with that scope. Still report it when the author likely missed a further caller, when the downside is badly understated, or when the change looks malicious.
- Do not raise severity to be heard. A minor issue labeled critical trains people to ignore you.

The scope script understands unified diffs with unquoted paths. Paths that git quotes because they contain spaces are not parsed — check those by hand.

## Finding shape

Machine-readable lines (the classifier reads these; other prose is ignored):

```
FINDING path:line | problem | failure scenario
REPRO <command> → <actual output>
CLEARED path:line | why it is intentional and what the scope is
```

`failure scenario` names a concrete break: a test, a user action, or a crossed trust boundary. "Looks wrong" is not a scenario.

`REPRO` is required for a finding to count. The arrow is `→` or `->`, with a non-empty command and the output you actually saw. No repro → Unconfirmed. Unconfirmed does not enter the conclusion. The script does not execute the command:

```
node "<this skill dir>/scripts/split-findings.mjs" <report.md> --diff <unified.diff>
```

`<this skill dir>` is the directory this skill's SKILL.md was loaded from (Claude Code shows it as the skill base directory; in the mstack repo it is `skills/m-review`). If that file cannot be found, classify by hand and say so. Run the script from the project root: it adds untracked files (`git ls-files --others --exclude-standard`) to the diff's scope, so a finding in a new file stays in the conclusion when `git diff` is empty.

Exit 0: parsed; `conclusion` is the confirmed in-scope findings (including untracked files). Exit 1: a confirmed finding sits outside the diff and is not an untracked file — drop it. Exit 2: a FINDING / REPRO / CLEARED line is malformed.

## Angles

Run the angles that apply, one reviewer each, except on the floor tier (the table below), where one reviewer may cover them all. Each axis still returns its own verdict: `pass`, `issues`, `not-assessed`, or `not-applicable`. Never blend axes into one score.

1. **intent** — always. Compare the diff to acceptance criteria in the plan or spec (`.mstack/plans/`, `.mstack/specs/`, or the user's text). Quote the criterion sentence, then mark it met, unmet, or not-assessed. No spec → the whole axis is `not-assessed`. Do not invent a criterion. A defect finding does not replace a missed criterion.
2. **standards** — always. Find `CLAUDE.md`, `AGENTS.md`, and `CONTRIBUTING*` at the repo root and in directories the diff touches. Check each rule that governs the touched files, and quote the rule. A style preference those files do not state is not a finding. Missing files → `not-applicable`, not a pass.
3. **downstream** — when the census is non-empty, or the diff changes a public signature, schema, or wire format. Input is the census: exported symbols, protocols, data formats, and callers outside the diff, plus one command and its output. Look where a name search stops: another language reading the same bytes, a column, a queued payload, a caller three hops out. An empty caller list must come from a command you ran.
4. **devex** — only when the diff changes how people run or build the code: env vars, where secrets are read, ports, or a script that existing workflows must now run. A new optional script, or a normal package-manager dependency, does not enable this angle (`not-applicable`).
5. **feature-gate** — only when the diff adds, removes, or edits a feature flag, an env/build gate, or an internal-only check. Look for a gated behavior that now runs without the gate, or a gate that no longer wraps what it claims to wrap. Otherwise `not-applicable`.
6. **correctness** — logic, edges, error paths, off-by-one, wrong types, missing empty handling.
7. **concurrency** — races, deadlocks, leaked handles, unbounded buffers, teardown, timers.
8. **api** — public signatures, semver, migrations, renamed config, dependency or platform drift.
9. **tests** — untested behavior, assertions pinned to the old behavior, missing boundaries, flaky tests.
10. **security** — trust boundaries, injection, authz, secrets, destructive operations, untrusted input into a sink. Required on the thorough tier; also required on a lower tier when the diff crosses a trust boundary.

## Reviewer tier

Count files in `git diff --stat <base>` plus untracked files that are part of the change. Check the thorough row first; it wins over the file-count rows.

| Tier | When | Model | Security angle |
|---|---|---|---|
| floor | 1–4 files, and no auth, crypto, or destructive change | `sonnet`. Do not go weaker. Sources name no model below this floor. | Only if the diff crosses a trust boundary |
| default | 5–20 files, and no auth, crypto, or destructive change | `sonnet` floor. Nothing between sonnet and opus is specified; do not invent one. | Only if the diff crosses a trust boundary |
| thorough | 21 or more files, or any auth, crypto, or destructive change | `opus` | Always, as its own angle |

Destructive means a one-way action: deleting data, dropping a safeguard, an irreversible migration, or a similarly hard-to-undo change. Auth and crypto mean the diff touches authentication, authorization, signing, encryption, or secret handling — not a passing mention in a comment.

## Shared prompt

```
You are reviewing one change. Report only problems you can reproduce.

Diff: {path or range}
Base: {BASE}
Axis: {ANGLE}
Plan or spec (quote, do not improve): {path or "none"}
Standards files: {paths or "none found"}

Rules:
- Read the whole diff first.
- Stay inside this axis. Do not grade the other axes.
- Only lines the diff adds or replaces, or lines in an untracked file, unless the axis is intent or standards.
- Intent: quote the criterion, then met / unmet / not-assessed.
- Standards: quote the rule, then whether the diff breaks it.
- Hide nothing you were not given. You were not told who wrote this.
- Return findings as:
  FINDING path:line | problem | failure scenario
  REPRO <command> → <actual output>
- Intentional, explicitly scoped breaks:
  CLEARED path:line | why
- "no findings" is valid. Say which part you could not check.
```

## Position swap

Use this when two or more candidate patches are compared. It is the comparison `m-dispatch` asks this skill to run after clustering.

- Show every candidate in one prompt. Do not score them in separate sessions and then average.
- Run the same prompt twice: order A then B, and order B then A. Swap only the order. Change nothing else.
- Strip author names, model names, and any sentence that calls one candidate correct.
- Accept a preference only when both orders pick the same candidate. If they disagree, the result is a tie. Say so.
- A longer writeup or a confident tone is not evidence. Prefer the candidate whose repro command produced the claimed output.
- Asking the reviewer to write tests and then judge is not a substitute for running a command.

## Refuter stage

After confirmed high-risk findings exist (critical, security, auth, crypto, destructive, data loss), spawn one refuter. It does not look for new bugs.

```
You are trying to kill the findings below. A finding survives only if you cannot show it is wrong.

For each finding, attempt one of:
- the cited line is not added or replaced in the diff, and the file is not untracked
- the path cannot actually fail, because a guard elsewhere handles it
- the repro command does not produce the claimed output when you run it

Return one line per finding:
SURVIVES path:line | the repro you re-ran → output
KILLED path:line | why it does not fail
```

Promote SURVIVES only. KILLED increments the drop count and leaves the conclusion. If you cannot re-run the repro, the finding stays unconfirmed, not survived. One refute pass is the limit; if you still disagree, report both sides.

## Merging

- Dedupe by `file:line` plus root cause. Keep the sharpest failure scenario.
- Do not cross-rank axes or pick a winning axis.
- Order confirmed findings most severe first: critical, important, minor. Severity names the blast radius, not your confidence.
- End the merged review with exactly one verdict line. `APPROVE` when no confirmed in-scope finding remains and no axis is `issues`. `REQUEST CHANGES` otherwise, then list each blocking finding as `file:line` and each axis marked `issues`. Unconfirmed and Cleared do not block. The caller gates on this line; this skill does not edit or merge the change.

## Reception

When you are the author answering a review:

- Check the finding against the code before changing anything.
- Unconfirmed items are not work. Ask for a repro or reject them.
- If several items are unclear, clarify all of them first, then fix blocking bugs, then simple fixes, then complex ones, testing each.
- Reply with the fix and the evidence. No thanks, no performed agreement. If the finding is wrong, say so with `file:line` or a test.
