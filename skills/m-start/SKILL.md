---
name: m-start
description: "Router: reads .mstack/ state, picks the right m-skill, resumes in-flight work. Use first, and on terse prompts like 继续/开工/接着干."
whenToUse: "At the start of every conversation and whenever a terse prompt (\"继续\", \"开工\", pasted logs) needs routing to a skill or a resume from .mstack/ state."
---

# m-start — 总入口

mstack is the front door: before doing any work, inspect `.mstack/` state and the user's request to decide which sibling skill owns the task, then run it. On terse prompts it infers the current phase and continues instead of asking the user to name a skill.

## When to use / not use

Use at the top of every conversation, including when the user just says "继续" or pastes a log. Use it to route to one of: `m-think`, `m-plan`, `m-goal`, `m-team`, `m-dispatch`, `m-verify`, `m-debug`, `m-review`, `m-ship`, `m-qa`, `m-research`, `m-handoff`, `m-learn`, `m-deslop`, `m-guard`, `m-cua`. Do not use it when a sibling skill is already running with clear in-progress state — hand back to that skill instead.

## Procedure

Using m-start: <one-line routing purpose> — say this first, before any tool call.

**Rule: no work before a one-line routing decision that names a skill, and no resume from state you have not read.**
No exceptions: a terse prompt is not a reason to guess the phase; "I remember where we were" is not reading; a stale goal is reported, never resumed or cleaned up by you.

| You will be tempted to think… | Reality |
|---|---|
| "The `## Closeout` heading is missing/present, so I know the goal's status." | The skeleton creates that heading at the start. Status comes from `state.json` or a `status:` line (reviews/2026-11-06-round2.md #8). |
| "I'll look for `plans/<slug>.md`; nothing there, so no plan exists." | Plan files carry a date prefix; glob `*-<slug>.md`. The wrong glob restarted finished planning (reviews/2026-11-04-acceptance.md #13). |
| "「继续」 means I can pick any task up and start." | Read handoff and goal files first, then resume the recorded phase; trust files over memory. |
| "This goal looks abandoned, I'll close it for them." | Staleness is advisory. Report it with its resume hint; the user decides. |
| "The user just said 提PR, I'll push now." | Route to `m-ship`; push and PR are outward-facing and stop for approval there. |
| "I'll skip the routing line and start working." | The routing line is what lets the user catch a wrong pick in one glance. |

Red flags — stop and route: you edited a file before naming a skill; you cite a goal's status without having opened its state file; you ran `rm` or edited on stale state; your routing line names two skills.

1. Read `.mstack/handoff.md` first (if present) and any `.mstack/goals/<slug>.md` or `.mstack/plans/*-<slug>.md` (plans carry a `<YYYY-MM-DD>-` prefix) that names the current task.
2. Flag stale state, advisory only — report it, never auto-resume, clean up, or close it. Judge staleness from the state file, not from headings (a goal's `## Closeout` heading exists from creation, so its presence means nothing):
   - A goal (`.mstack/goals/<slug>.md`) is stale when its `<slug>.state.json` has `"status": "active"` and the state file's mtime is older than 2 hours. Its resume hint is the goal file path plus the last row of its checkpoint table — an unfinished goal has no resume-hint of its own.
   - A goal file whose `## Closeout` contains no `status:` line, while its `state.json` is missing, counts as abnormally interrupted (the loop died before writing either). A `## Closeout` that holds only the placeholder text from creation is not a closeout.
   - A team run (`.mstack/team/<slug>/`) is stale when the newest `v<N>.md` has no `status:` line and its mtime is older than 2 hours. `status: active|done|failed` is written into each round file's round-close block (`m-team` owns that line); resume from that file plus `history.md`.
   - `done` and `failed` are terminal and never stale. Anything you cannot read, say you could not read.
3. A whole task stated as one sentence ("做X", "修好Y", "加个Z，提PR") with no stage named → run the `/go` pipeline (the plugin's `commands/go.md`): it picks the stages itself and writes `.mstack/runs/<id>/progress.json` so the user can watch. Also resume any run there with status running or blocked before starting new work.
4. Otherwise classify the request against the 10 core principles (below) and the skill one-liners. Report which skill you picked and why, in one line, then load that skill's SKILL.md and follow it.
5. If `.mstack/` shows work in progress, resume it: trust the state files over your memory; do not redo steps already marked done.
6. If no single skill obviously applies, prefer `m-think` for anything new or ambiguous; prefer `m-debug` for a broken behavior; route "提PR/提交/发布" to `m-ship`, "review一下/审一下" to `m-review`, "分派/并行" to `m-dispatch`, "组队/team/一直优化/卡在局部最优" to `m-team`.
7. Any judgement the steps do not cover (two skills tie, state unreadable) becomes one line in your routing report: `Ruling: decision | reason | cost if wrong`.
8. Follow the reporting format (one-line conclusion → what changed with file:line → how it was verified → what you did not do / risks) in Chinese, matching the user's language.

### The 10 core principles (other skills cite these by number)

1. 攻击前提 — question whether the problem is even the right one, and whether a simpler path exists.
2. 先减后加 — delete before adding; build nothing that was not requested.
3. 可验证的小步 — every step has a check, done in order.
4. 证据先于结论 — never claim something runs if you did not run it, or passes if you did not see the output.
5. 修根因不修症状.
6. 写的人不审 — review/verify goes to a different agent or model.
7. 护住上下文 — read summaries not full files, spill large output to disk, keep the main session light.
8. 不卡在人身上 — proceed with defaults and record decisions; stop only for irreversible or external actions.
9. 同一错误连续 3 次 → 停，换假设或上报，不要重试第 4 次.
10. 教训进结构 — a repeated trap becomes a lesson, a check script, or a skill.

Gate function — before saying "resuming X" or "nothing in flight":

| claim | evidence required | evidence that is NOT enough |
|---|---|---|
| goal is in flight / stale | its `state.json` `status` and mtime, read this turn | the goal file's headings; memory of last session |
| no work in flight | a glob of `.mstack/goals/`, `plans/`, `team/` that returned nothing | one failed guess at a filename |

## Output

No new files on its own. It produces a one-line routing decision — plus a stale-state warning whenever step 2 fires — and then hands off to the chosen sibling skill, whose own Output section governs. When resuming, it replays the current phase from `.mstack/` state.

## Stop conditions

Counts: 2 hours is the staleness line; ask at most one question per routing. Stop and ask only when the request is genuinely ambiguous AND no `.mstack/` state resolves it, or when the next action is irreversible/external (per principle 8). Otherwise keep moving: a terse prompt is not permission to stall.

## Harness notes

- Claude Code: read state with the Read/Glob tools; skills live under the plugin.
- DSH: state sits in the same `.mstack/` dir; skills under `~/.dsh/skills`.
- Claude Code and DSH name the same siblings; the matching agents (`m-explorer` for read-only mapping) are spawned by the skills you route to, not by m-start.
- Codex: `codex exec` runs headless — write the routing decision to the log rather than the chat.
