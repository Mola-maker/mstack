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

1. **Set up the run.** Create `.mstack/team/<slug>/`. If `m-goal` handed the objective over, note its goal-file path — the closeout remains `m-goal`'s job. Copy `references/team-config-template.md` to `v1.md` and fill it in.
2. **Initialize the persistent knowledge K** shared by all rounds: `LEARNINGS.md` (append-only empirical observations, each with its evidence), `SYNTHESIS.md` (actionable conclusions — every new role reads it before starting), `history.md` (the supervisor's per-round reflection and design decision). Each new round inherits all prior failed attempts and successful strategies.
3. **Design this round's team T = (roles, coordination, knowledge placement).** Invent roles for the current bottleneck — `references/role-catalog.md` is a starting menu, not a fixed roster. Each role gets: its duty, what it may change, what it must not touch, and the evidence it must deliver. Pick one coordination shape (solo / pipeline / parallel branches), fix which file or branch each role writes to, and set the round budget and the gates every candidate must pass.
4. **Dispatch the round via `m-dispatch`.** One workspace per role; no two roles edit the same file. Every role prompt names its file/branch outputs and requires reading `SYNTHESIS.md` first. Execution backends are `m-dispatch`'s; add Orca only when `orca` is on the PATH (see Harness notes).
5. **Coordinate through artifacts, never prose.** Roles exchange files, diffs, measurements, and failing cases. Cross-check claims byte-level against the artifact itself; a "we agreed" summary message is not evidence.
6. **Score candidates through hard gates.** A candidate failing any gate scores 0 — no partial credit. Keep a held-out check set that is checked but not scored. When a bug class slips past the evaluator, add a permanent new check that every later candidate must pass (evaluator hardening) and log it in `LEARNINGS.md`.
7. **Run the supervisor at round end** (or on a fixed interval). Work through `references/supervisor-checklist.md`: metrics vs gates first, then the failure patterns; classify the stall as knowledge gap / exhausted search / discipline problem; append the reflection and the new design to `history.md`; write `v<N+1>.md`.
8. **Repeat or stop.** Launch the next round under the new team version, or hit a stop condition and hand back to `m-goal` for the closeout.

## Output

- `.mstack/team/<slug>/v<N>.md` — one per round: roles, coordination shape, knowledge placement, budget, gates.
- `.mstack/team/<slug>/LEARNINGS.md`, `SYNTHESIS.md`, `history.md` — persistent knowledge, updated every round.
- Per-round report to the user in the standard format: one-line conclusion (metric before → after) → what each role delivered (files, evidence) → how candidates were scored → next round's design or why the run stopped. 中文汇报。

## Stop conditions

- Budget exhausted (tokens / $ / wall-clock) or the round cap is reached → hand back to `m-goal`, which writes the closeout.
- Two consecutive rounds with no metric improvement and the supervisor has no new diagnosis → stop and hand back to `m-goal`; do not launch a third identical round.
- Any irreversible or external action (push, publish, purchase) → stop and ask the user first.
- The same dispatch failure 3 times → change the hypothesis (principle 9); never retry a 4th time.

## Harness notes

- Claude Code: trigger the supervisor with `ScheduleWakeup` / `CronCreate` or at each round's end; roles run as `Agent` subagents via `m-dispatch`.
- DSH: supervisor cadence via the loop plugin or `max_goal_rounds`; roles via `subagent` / `workflow` per `m-dispatch`.
- Codex CLI: no wake mechanism — the wrapper driving `codex exec` starts each round; all state lives in `.mstack/team/<slug>/` so any harness can resume.
- Orca (optional; only when `orca` is on the PATH): start each role with `orca orchestration worker-start --spec "<role spec>" --worktree current --agent codex|claude` (own checkout: `--worktree new-top-level --repo id:<repoId> --name <short-name>`), then end your turn — Orca wakes you, never poll. Steer a role with `orca orchestration send --to dispatch:<id> --subject … --body …`; `worker_done` settles a role, while an `escalation` carrying `stopReason` means the role quit without delivering.
