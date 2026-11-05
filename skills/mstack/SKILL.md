---
name: mstack
description: "Entry point that reads .mstack/ state to pick the right skill and resume in-flight work without the user naming a skill. Use when starting any task, or on \"继续/开工/接着干\" and other terse prompts."
whenToUse: "At the start of every conversation and whenever a terse prompt (\"继续\", \"开工\", pasted logs) needs routing to a skill or a resume from .mstack/ state."
---

# mstack — 总入口

mstack is the front door: before doing any work, inspect `.mstack/` state and the user's request to decide which sibling skill owns the task, then run it. On terse prompts it infers the current phase and continues instead of asking the user to name a skill.

## When to use / not use

Use at the top of every conversation, including when the user just says "继续" or pastes a log. Use it to route to one of: `m-think`, `m-plan`, `m-goal`, `m-team`, `m-dispatch`, `m-verify`, `m-debug`, `m-review`, `m-ship`, `m-qa`, `m-research`, `m-handoff`, `m-learn`, `m-deslop`, `m-guard`. Do not use it when a sibling skill is already running with clear in-progress state — hand back to that skill instead.

## Procedure

1. Read `.mstack/handoff.md` first (if present) and any `.mstack/goals/<slug>.md` or `.mstack/plans/<slug>.md` that names the current task.
2. Classify the request against the 10 core principles (below) and the skill one-liners. Report which skill you picked and why, in one line, then load that skill's SKILL.md and follow it.
3. If `.mstack/` shows work in progress, resume it: trust the state files over your memory; do not redo steps already marked done.
4. If no single skill obviously applies, prefer `m-think` for anything new or ambiguous; prefer `m-debug` for a broken behavior; route "提PR/提交/发布" to `m-ship`, "review一下/审一下" to `m-review`, "分派/并行" to `m-dispatch`, "组队/team/一直优化/卡在局部最优" to `m-team`.
5. Follow the reporting format (one-line conclusion → what changed with file:line → how it was verified → what you did not do / risks) in Chinese, matching the user's language.

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

## Output

No new files on its own. It produces a one-line routing decision and then hands off to the chosen sibling skill, whose own Output section governs. When resuming, it replays the current phase from `.mstack/` state.

## Stop conditions

Stop and ask only when the request is genuinely ambiguous AND no `.mstack/` state resolves it, or when the next action is irreversible/external (per principle 8). Otherwise keep moving: a terse prompt is not permission to stall.

## Harness notes

- Claude Code: read state with the Read/Glob tools; skills live under the plugin.
- DSH: state sits in the same `.mstack/` dir; skills under `~/.dsh/skills`.
- Codex: `codex exec` runs headless — write the routing decision to the log rather than the chat.
