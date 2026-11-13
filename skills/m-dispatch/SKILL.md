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

First line you say: `Using m-dispatch: split into independent slices, prove each one.`

```
No worker result is merged, and no worktree is reused, until you have looked at it yourself.
```

Closed loopholes: a worker's "done", a `completed` notice, a tidy summary, a majority of identical patches, and a message to an idle worker asking how it is going all count as looking at nothing. Breaking the letter of this rule is breaking its spirit.

1. **Write the selection rule first.** Record it in the dispatch note, not inside worker prompts. `first pass`: among workers on the same brief, the first result that meets VERIFY wins; later results are logged and not merged. `rank all`: wait for every worker, then order the non-gap results by the criterion you wrote next to the rule. `best-of`: wait for every worker and keep one winner by that criterion. Different files are coverage, not a race — every slice must return. A race is several workers on one brief.
2. **Decompose.** One `todo_write` entry per subtask (several may be `in_progress`). Each prompt is self-contained. Never assign the same file to two subtasks. When two or more subtasks consume a type or interface that does not exist yet, one task lands it first and the fan-out starts from that commit. Fill `references/subtask-prompt-template.md` (GOAL / WHY / SCOPE / OUT OF SCOPE / CONTEXT / VERIFY / RETURN) before the first spawn.
3. **Pick a route per subtask, then adapt the brief.** Name the task kind, take its top route, reshape the brief for that model family. Table and adapters: `references/model-routing.md`. An omitted model inherits the expensive default; light reading goes to a cheap route.
4. **Isolate.** Each code-changing subtask gets its own workspace: a LayerFS branch if that bundle is present, otherwise `git worktree add ../<repo>-<task> -b agent/<task>`. The worker stays there. Where the tool cannot take a cwd (Harness notes), create the worktree yourself and put its path in the prompt.
5. **Check old workers have stopped.** Before re-dispatching into a worktree, or taking it back: run `git -C <worktree> status --short` twice, at least 10 s apart, and read the harness's agent list. Stopped = not running and both outputs identical. Still running or output moved → interrupt it, wait, look again. Never message an idle worker to ask for progress: the message restarts it. Progress shows in the worktree and its commits.
6. **Dispatch in one step.** Start every subtask together, then wait. Choose the executor from the table below. Every DSH model goes through magpie (`group/*`, `auto/*`). Commands: `references/harness-commands.md`. Use your own subagents unless you need another vendor's agent, or a worktree a human will keep using. Orca only in those two cases, and only when `orca` is on PATH. After Orca `worker-start`, end this turn. Do not poll and do not write a watch script.
7. **Evidence or gap.** RETURN must contain the evidence VERIFY and RETURN named: the command, the output you saw, and the changed files (or "no files changed"). If the brief also required a SHA or a method, that is evidence too. Anything missing is a gap: re-dispatch that worker once and name the missing field. A second miss stays a gap and is not a pass. Do not fill it in yourself.
8. **Select.** Apply the rule from step 1 to non-gap results. When more than one result is a patch, cluster exact diffs first: `node "<this skill dir>/scripts/cluster-diffs.mjs" <a.patch> <b.patch> ...`. `<this skill dir>` is the directory this SKILL.md was loaded from (Claude Code shows it as the skill base directory; in the mstack repo it is `skills/m-dispatch`). If the script cannot be found, cluster the normalized patch texts by hand and say so in the report. A strict majority (more than half the candidates, one cluster) is the leading patch, not proof. Show every candidate side by side — majority label included, or the tie — to a verifier from a family that no author used (`references/model-routing.md`, "Judge family"). It follows `m-review` (both orders, authors hidden) and returns `APPROVE` or `REQUEST CHANGES`; you adjudicate if verifier and majority disagree. See `references/decisions.md`.
9. **Verify separately.** After the merge, one fresh subagent reviews and runs the real tests. It must not be an agent that wrote the code.
10. **Log judgement calls.** Anything the steps do not decide becomes one line in `.mstack/dispatch/rulings.md`: `Ruling: decision | reason | cost if wrong`. Keep going; do not ask.

### Gate before you call a slice done

| Claim | Evidence required | Evidence that is NOT enough |
|---|---|---|
| Worker finished | RETURN with command, output, files; `git -C <worktree> status` shows those files | "done"; a `completed` notice |
| Worktree free to reuse | two identical status reads 10 s apart, agent not running | one quiet read; the agent said it stopped |
| Patch is the best one | step 8 verifier verdict over all candidates | majority count alone |
| Merged result works | step 9 reviewer ran the real suite, exit 0 | each worker's own green run |

### Rationalizations seen in this repo

| You will be tempted to think… | Reality |
|---|---|
| "The brief is clear; no VERIFY/RETURN contract needed." | The template was once never linked, so workers could answer "done" with no evidence (reviews/2026-11-04-acceptance.md #7). Fill it. |
| "The repo-relative `skills/m-dispatch/scripts/` path will resolve." | Installed as a plugin that is MODULE_NOT_FOUND and the check quietly vanishes (reviews/2026-11-06-round2.md #1). Use the skill dir. |
| "It said completed, so the worktree is mine." | `completed` is a notice, not a process exit; background children keep writing (research/round3/pstack-craft.md T2). Step 5. |
| "I'll ask the idle worker for an update." | The message wakes it and it works again (pstack-craft T3). Read the worktree. |
| "One 402 only hits one worker." | It kills every worker on that route together (references/harness-commands.md). Re-route the rest. |
| "Teammates and workflow agents each get their own directory." | They share the lead's cwd (research/round3/dsh-team.md). Only `subagent` takes a cwd. |

Red flags — stop and redo the step: you wrote "should be merged"; two prompts name one file; a worker prompt carries the selection rule; you are about to poll Orca; the verifier shares a family with an author.

## Output

Chinese §4 report: one-line conclusion → what changed (`file:line`) → how it was verified (command + result) → what is left and the risks.

Also: the selection rule, the route chosen per subtask, the cluster JSON (or "not a patch race"), and every gap that did not count. Findings arrive as `file:line + problem + failure scenario` (cap about 8 per worker). Dedupe and confirm before you report them. Pass large artifacts as paths, not pasted text.

## Stop conditions

- Two subtasks cannot be made independent → do not force parallel. Sequence them or return to `m-plan`.
- A subtask would mutate a shared resource (one database, one config, a push or a publish) → stop and ask.
- A child fails, returns BLOCKED, or loses its workspace → re-dispatch once with more context or a stronger route. A second missing-evidence gap ends that slice. The same dispatch failure 3 times in a row → change the hypothesis (principle 9); never a 4th try.
- A 402 or 429 on a route → move the remaining slices down that kind's picks list, once per route. List exhausted → report which slices are missing.
- An old worker still runs after one interrupt and one recheck → leave its worktree alone, use a new one, say so.
- `orca` is not on PATH → do not invent a command. Use this session's subagents.

## Harness notes

| Need | Executor |
|---|---|
| Parallel work in this session (default) | Claude Code `Agent`; DSH `subagent` / `subagent_fork` |
| A different model family, or a one-shot second opinion | `subagent_claude_code` / `subagent_codex`; `codex exec` |
| Headless batch on WSL | `dsh --profile mola-cli` via magpie |
| Another vendor's agent, or a worktree left for a human | Orca, only if `orca` is on PATH. End the turn after start. |

- Agents: code-changing workers are `m-implementer` (Claude Code `subagent_type: "mstack:m-implementer"`); read-only fan-out is `m-explorer` (`"mstack:m-explorer"`). In DSH use the same names as `label` or teammate name.
- Claude Code: every `Agent` call in one message runs in parallel; a later message is sequential. `run_in_background: true`. The returned id is for a follow-up, not for polling Orca. `Agent` reaches only Claude models: a different-family judge comes from `mola run` or DSH, else mark the verdict `same-family` (`references/model-routing.md`, "In plain Claude Code").
- DSH: tool names, the workflow template and the shared-cwd trap are in `references/dsh-native.md`. `subagent` takes a cwd; `spawn_teammate` and a workflow `agent()` do not, so isolated edits never go through them. Never a direct `deepseek/*` route. `group/smart-split` has no reasoning-effort field.
