# Team config template (m-team)

Copy this file to `.mstack/team/<slug>/v<N>.md` at the start of every round and fill in every field. One file per round; never edit a previous round's file — supersede it.

```markdown
# Team v<N> — <slug>

- **Round:** <N>
- **Objective (from m-goal):** <one testable sentence; goal file: .mstack/goals/<slug>.md>
- **Metric:** <name, unit, how measured (exact command)>
- **Metric at round start:** <value + evidence>
- **Round budget:** <tokens / $ / wall-clock>
- **Round threshold:** <the metric value that makes this round a success>
- **Diagnosis from last supervisor round:** <knowledge gap / exhausted search / discipline problem — one line why> (v1: "initial design")

## Gates (any failure → candidate scores 0)

1. <gate: exact command or check, expected result>
2. …

## Held-out checks (checked, never scored)

1. <check + command>
2. …

## Coordination shape

<solo | pipeline | parallel branches> — <one line: who hands what to whom, in which order or in parallel>

## Roles

### Role 1: <name>

- **Duty:** <what this role exists to do this round>
- **May change:** <files / directories / branch>
- **Must not touch:** <explicit forbidden areas>
- **Delivers (evidence):** <files, diffs, measurements, failing cases — concrete artifacts>
- **Writes to:** <file path or branch name>
- **Reads first:** `SYNTHESIS.md` (mandatory), plus <round-specific inputs>

### Role 2: …

(repeat; add or drop roles freely — see role-catalog.md)

## Knowledge placement

- **Shared log:** `.mstack/team/<slug>/LEARNINGS.md` (append-only, each entry with evidence)
- **Actionable conclusions:** `.mstack/team/<slug>/SYNTHESIS.md`
- **This round's artifacts:** <directory or branches where this round's outputs land>
- **Round-specific notes:** <which role writes which extra file, if any>

## Round close (filled in by the supervisor)

- **Metric after round:** <value + evidence>
- **Candidates scored 0:** <list + failed gate>
- **Held-out results:** <pass/fail per check>
- **Handed to supervisor checklist at:** <timestamp>; next version: v<N+1> or stop
```
