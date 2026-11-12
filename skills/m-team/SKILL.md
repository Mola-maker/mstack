---
name: m-team
description: "Evolving agent team for open-ended, large-budget goals; a supervisor redesigns roles each round. Use for 组队/一直优化/卡在局部最优."
whenToUse: "Open-ended optimization or exploration with a large budget, where a solo agent or a fixed setup plateaus; takes such goals over from m-goal and hands the closeout back to it."
---

# m-team — Evolving agent team

m-team attacks objectives with no single "done": push a metric (speed, score, pass rate) as far as the budget allows. Work runs in rounds; after each round a supervisor studies the measured outcome, diagnoses why progress stalled, and redesigns the team — roles, coordination shape, knowledge placement — before launching the next round. Dispatch mechanics stay in `m-dispatch`; the goal file and closeout stay in `m-goal`.

## When to use / not use

Use when:

- The goal is open-ended ("make it faster", "raise the score", "keep improving") with a large token/$/wall-clock budget, handed over by `m-goal` or the user.
- Previous attempts plateaued or settled into a local optimum, and a fresh structure — not just more of the same — is needed.

Do NOT use when:

- The budget is small or the target is well-defined: at small budgets a team barely beats one agent, so use a single agent or one `m-dispatch` round instead.
- You need one round of parallel execution with no redesign loop — that is `m-dispatch`.
- The work is a bounded build with clear acceptance criteria — `m-plan` + `m-dispatch` under `m-goal`.

## Procedure

First line you say: `Using m-team: run a measured round, compare to solo, redesign or stop.`

```
A team is kept only while it beats solo by more than the noise band you wrote before scoring.
```

Closed loopholes: widening the band after the result, reading a gain from one run, scoring with a judge who wrote a candidate or shares a family with one, and "the team felt better" all count as no gain. Breaking the letter of this rule is breaking its spirit.

1. **Set up the run.** Create `.mstack/team/<slug>/`. If `m-goal` handed the objective over, note its goal-file path — the closeout remains `m-goal`'s job. Copy `references/team-config-template.md` to `v1.md` and fill it in.
2. **Initialize the persistent knowledge K** shared by all rounds: `LEARNINGS.md` (append-only empirical observations, each with its evidence), `SYNTHESIS.md` (actionable conclusions — every new role reads it before starting), `history.md` (the supervisor's per-round reflection and design decision), `rulings.md` (`Ruling: decision | reason | cost if wrong`, one line per call the steps do not decide). Each new round inherits all prior failed attempts and successful strategies.
3. **Design this round's team T = (roles, coordination, knowledge placement).** Invent roles for the current bottleneck — `references/role-catalog.md` is a starting menu, not a fixed roster. Each role gets: its duty, what it may change, what it must not touch, and the evidence it must deliver. Pick one coordination shape (solo / pipeline / parallel branches), fix which file or branch each role writes to, and set the round budget and the gates every candidate must pass. In the same file, before anyone is scored, write the noise band: the spread of this metric on unchanged code from earlier measurements, or, if you have none, the smallest delta the measuring command can resolve, marked weak. Do not set the band from this round's team-minus-solo gap.
4. **Dispatch the round via `m-dispatch`.** One workspace per role; no two roles edit the same file. Every role prompt names its file/branch outputs and requires reading `SYNTHESIS.md` first. Pick each role's route and brief wrapper by `m-dispatch`'s `references/model-routing.md`. When the shape is pipeline or parallel, also dispatch one solo agent whose cap equals the round budget (the team's shared cap, not one role's slice). The solo agent is not a role: it runs as a `subagent` with its own worktree as `cwd`, never in the lead's cwd, and writes only there. A round whose shape is already solo does not spawn a twin. Execution backends are `m-dispatch`'s; add Orca only when `orca` is on the PATH. In DSH, `references/dsh-team.md` maps the round onto native team tools.
5. **Coordinate through artifacts, never prose.** Roles exchange files, diffs, measurements, and failing cases. Cross-check claims byte-level against the artifact itself; a "we agreed" summary message is not evidence.
6. **Score on anonymous labels.** Attach gate command output to each candidate; a failed gate scores 0 — no partial credit. Keep a held-out check set that is checked but not scored. When a bug class slips past the evaluator, add a permanent new check that every later candidate must pass (evaluator hardening) and log it in `LEARNINGS.md`. The judge comes from a family that no candidate used, including the solo run (`m-dispatch`, `references/model-routing.md`, "Judge family"); a second Claude tier does not count. In plain Claude Code that family is reached through `mola run --kind review` or DSH with a different-family route (`model-routing.md`, "In plain Claude Code"). It is someone who did not author a candidate: the Auditor if this round has one and the family differs, otherwise a fresh agent on another family. The judge sees only labels (`A`, `B`, …), artifacts, and gate output — not role names, model names, authors, role prompts, or `v<N>.md`. The solo run uses a label of the same form; keep the label-to-author map out of the packet. After scores return, write the map into `history.md` and into the round-close section of `v<N>.md`. Then unblind. Gain is how far the team's best beats solo in the metric's success direction (higher-is-better: team − solo; lower-is-better: solo − team).
7. **Run the supervisor at round end** (or on a fixed interval). Work through `references/supervisor-checklist.md`: the solo comparison first, then metrics vs gates, then the failure patterns; classify the stall as knowledge gap / exhausted search / discipline problem; append the reflection and the new design to `history.md`; write `v<N+1>.md` only if the team still beats solo by more than the noise band.
8. **Repeat or stop.** Launch the next round under the new team version, or hit a stop condition and hand back to `m-goal` for the closeout.

### Gate before you claim a team gain

| Claim | Evidence required | Evidence that is NOT enough |
|---|---|---|
| Team beat solo | metric from the same command and budget, gain larger than the band written earlier | a single run; a band set after seeing it |
| Scores are fair | label-only packet, judge family absent from all candidates, map written after scoring | judge is another Claude tier; judge saw role names |
| A role delivered | the artifact on disk, diffed against its claim | the role's message that it agreed or finished |

### Rationalizations seen in this repo

| You will be tempted to think… | Reality |
|---|---|
| "The team is ahead, one more round will widen it." | A team can add little over one agent at equal budget; stop when the gain is inside the band (research/papers.md §G). |
| "My model tier differs from the author's, so the judge is independent." | Tiers of one vendor are one family (research/round3/pstack-craft.md §3.1); a panel must span families. |
| "The Auditor saw the role names, but it was fair." | Blind labels only (research/pstack.md #12). Unblind after scores are written. |
| "The solo baseline can run in my own cwd while the team works." | Teammates share the lead's cwd; a baseline there is contaminated, so the gain means nothing (reviews/2026-11-07-round3.md #6). Use `subagent` with its own worktree `cwd`. |
| "Each teammate has its own directory." | Teammates share the lead's cwd, with no lock; `write_scopes` is only advisory (dsh-team.md §1). |
| "m-team can write the closeout; it knows the result." | Two skills once claimed the same closeout (reviews/2026-11-04-acceptance.md #2). `m-goal` owns it. |

Red flags — stop and fix: a role's message is quoted as evidence; the band is blank or newer than the scores; the label map is in the judge's packet; the judge and a candidate share a family; a "stalled" run has no `v<N>.md` round-close block.

## Output

- `.mstack/team/<slug>/v<N>.md` — one per round: roles, coordination shape, knowledge placement, budget, noise band, gates. The solo map is not in the copy you send to the scorer.
- `.mstack/team/<slug>/LEARNINGS.md`, `SYNTHESIS.md`, `history.md`, `rulings.md` — persistent knowledge, updated every round. `history.md` records solo metric, team-best metric, the band, and the label map after scoring.
- Per-round report to the user in the standard format: one-line conclusion (metric before → after, team vs solo) → what each role delivered (files, evidence) → how candidates were scored (judge family named) → next round's design or why the run stopped. 中文汇报。

## Stop conditions

- Budget exhausted (tokens / $ / wall-clock) or the round cap is reached → hand back to `m-goal`, which writes the closeout.
- Gain over solo sits inside the noise band written in `v<N>.md` → stop teaming and hand back to `m-goal`. Do not open another multi-role round to hunt for a gap. A weak band still stops the team.
- 2 consecutive rounds with no metric improvement and the supervisor has no new diagnosis → stop and hand back to `m-goal`; do not launch a third identical round.
- No judge family free of the candidates' families (including plain Claude Code with no `mola run` / DSH route available) → declare `same-family` in the report, score with that mark, make no gain claim; one more round at most.
- Any irreversible or external action (push, publish, purchase) → stop and ask the user first.
- The same dispatch failure 3 times → change the hypothesis (principle 9); never retry a 4th time.

## Harness notes

- Agents: roles that edit code are `m-implementer`, read-only roles are `m-explorer`, the scorer is `m-reviewer` (Claude Code `subagent_type: "mstack:m-implementer"` and so on), on a route whose family differs from the candidates.
- Claude Code: cross-family judging goes through `mola run` or DSH with a different-family route; the `Agent` tool alone only reaches Claude. Trigger the supervisor with `ScheduleWakeup` / `CronCreate` or at each round's end; roles run as `Agent` subagents via `m-dispatch`.
- DSH: if the opt-in team preset is on (`dsh/mstack-team/`), roles are `spawn_teammate`, the board is `team_task_*`, rounds are `create_goal` with `max_goal_rounds`, wake-ups are `schedule_create`; details in `references/dsh-team.md`. Without it, roles go through `subagent` / `workflow` per `m-dispatch`. Teammates share the lead's cwd, so code roles need worktrees the lead made first.
- Codex CLI: no wake mechanism — the wrapper driving `codex exec` starts each round; all state lives in `.mstack/team/<slug>/` so any harness can resume.
- Orca (optional; only when `orca` is on the PATH): start each role with `orca orchestration worker-start --spec "<role spec>" --worktree current --agent codex|claude` (own checkout: `--worktree new-top-level --repo id:<repoId> --name <short-name>`), then end your turn — Orca wakes you, never poll. Steer a role with `orca orchestration send --to dispatch:<id> --subject … --body …`; `worker_done` settles a role, while an `escalation` carrying `stopReason` means the role quit without delivering.
