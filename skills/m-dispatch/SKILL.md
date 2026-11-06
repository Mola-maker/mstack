---
name: m-dispatch
description: "Fan independent subtasks out to Claude subagents, DSH headless, Codex or Orca; isolate, merge, verify. Use for 分派/并行/开N个agents."
whenToUse: "The task decomposes into 2+ parts with no shared files or sequential dependency, or the user asks to fan work out to parallel agents."
---

# m-dispatch

Turn one large job into independent subtasks and run them in parallel. The main session only decomposes, merges, and adjudicates. Subagents do the reading and editing so your context stays small.

The default executor is this session's own subagent. Orca is the exception.

## When to use / not use

Use when the parts share no state and can be done without each other's context: separate modules, separate failing files, multi-angle review, the same brief on more than one model.

Do NOT use when:

- The parts are coupled — one fix likely fixes another, or one consumes the other's output. Investigate together (`m-debug`).
- Two subtasks would edit the same file. Split again or run them in order.
- You do not yet know what is broken or what to build (`m-think`, `m-plan`).
- The job is open-ended optimization across rounds → `m-team` calls this skill once per round. Do not restate that loop here.

## Procedure

1. **Write the selection rule first.** Record it in the dispatch note, not inside worker prompts. `first pass`: among workers on the same brief, the first result that meets VERIFY wins; later results are logged and not merged. `rank all`: wait for every worker, then order the non-gap results by the criterion you wrote next to the rule. `best-of`: wait for every worker and keep one winner by that criterion. Different files are coverage, not a race — every slice must return. A race is several workers on one brief.
2. **Decompose.** One `todo_write` entry per subtask (several may be `in_progress`). Each prompt is self-contained. Never assign the same file to two subtasks. Fill `references/subtask-prompt-template.md` (GOAL / SCOPE / CONTEXT / VERIFY / RETURN) before the first spawn.
3. **Isolate.** Each code-changing subtask gets its own workspace: a LayerFS branch if that bundle is present, otherwise `git worktree add ../<repo>-<task> -b agent/<task>`. The subagent stays there.
4. **Dispatch in one step.** Start every subtask together, then wait for them. Choose the executor from the table below. Every DSH model goes through magpie (`group/smart-split`). Commands: `references/harness-commands.md`. Use your own subagents unless you need another vendor's agent, or a worktree a human will keep using. Orca only in those two cases, and only when `orca` is on PATH. After Orca `worker-start`, end this turn. Do not poll and do not write a watch script.
5. **Evidence or gap.** RETURN must contain the evidence VERIFY and RETURN named: the command, the output you saw, and the changed files (or "no files changed"). If the brief also required a SHA or a method, that is evidence too. Anything missing is a gap: re-dispatch that worker once and name the missing field. A second miss stays a gap and is not a pass. Do not fill it in yourself.
6. **Select.** Apply the rule from step 1 to non-gap results. When more than one result is a patch, cluster exact diffs before you pick: `node "<this skill dir>/scripts/cluster-diffs.mjs" <a.patch> <b.patch> ...`. `<this skill dir>` is the directory this SKILL.md was loaded from (Claude Code shows it as the skill base directory; in the mstack repo it is `skills/m-dispatch`). If that script cannot be found, cluster the normalized patch texts by hand and say so in the report. A strict majority (more than half the candidates, one cluster) is the leading patch, not proof. Show every candidate side by side — majority label included, or the tie — to a verifier from a different model family than the authors. That verifier follows `m-review` (both orders, authors hidden) and returns `APPROVE` or `REQUEST CHANGES`; you adjudicate if the verifier and the majority disagree. See `references/decisions.md`.
7. **Verify separately.** After the merge, one fresh subagent reviews and runs the real tests. It must not be an agent that wrote the code.

## Output

Chinese §4 report: one-line conclusion → what changed (`file:line`) → how it was verified (command + result) → what is left and the risks.

Also: the selection rule, the cluster JSON (or "not a patch race"), and every gap that did not count. Findings arrive as `file:line + problem + failure scenario` (cap about 8 per worker). Dedupe and confirm before you report them. Pass large artifacts as paths, not pasted text.

## Stop conditions

- Two subtasks cannot be made independent → do not force parallel. Sequence them or return to `m-plan`.
- A subtask would mutate a shared resource (one database, one config, a push or a publish) → stop and ask.
- A child fails, returns BLOCKED, or loses its workspace → re-dispatch once with more context or a stronger model. Do not retry that same way again (principle 9). A second missing-evidence gap ends that slice; it is not another spawn.
- `orca` is not on PATH → do not invent a command. Use this session's subagents.

## Harness notes

| Need | Executor |
|---|---|
| Parallel work in this session (default) | Claude Code `Agent`; DSH `subagent` / `subagent_fork` |
| A different model family, or a one-shot second opinion | `subagent_claude_code` / `subagent_codex`; `codex exec` |
| Headless batch on WSL | `dsh --profile mola-cli` via magpie |
| Another vendor's agent, or a worktree left for a human | Orca, only if `orca` is on PATH. End the turn after start. |

- Claude Code: every `Agent` call in one message runs in parallel; a later message is sequential. `run_in_background: true`. The returned id is for a follow-up, not for polling Orca.
- DSH: `workflow` when one shape is applied to N items. Never a direct `deepseek/*` route. `group/smart-split` has no reasoning-effort field.
- Set the model explicitly. An omitted model inherits the expensive default. Cheap model for light reading; stronger model for architecture or review. The patch verifier's family is not the author's.
