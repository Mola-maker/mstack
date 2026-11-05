---
name: m-dispatch
description: "Split an independent, parallelizable task into self-contained subtasks and run them concurrently across Claude subagents, DSH headless, or Codex — each in its own workspace — then merge and verify. Use when \"分派给 subagents / 并行开 N 个 agents / 委派\"."
whenToUse: "The task decomposes into 2+ parts with no shared files or sequential dependency, or the user asks to fan work out to parallel agents."
---

# m-dispatch

Turn one large job into independent, self-contained subtasks and run them in parallel across harnesses, while the main session only decomposes, merges, and adjudicates. Subagents do the heavy reading and editing; your context stays clean.

## When to use / not use

Use when subtasks share no state and can be understood without each other's context (multiple modules, multiple failure files, multi-angle review, multi-model comparison).

Do NOT use when:
- The parts are coupled — fixing one likely fixes another, or one consumes what another produces. Investigate together first (see `m-debug`).
- Two subtasks would touch the same file. Split it differently or run them in sequence.
- You don't yet know what's broken / what to build — think first (`m-think`, `m-plan`).

## Procedure

1. **Decompose.** Write one `todo_write` entry per subtask (several may be `in_progress` at once). Each must be fully self-contained: the goal, the exact files/directories it may touch, how "done" is checked, and the output format. Never give two subtasks the same file. Write each subtask prompt from `references/subtask-prompt-template.md` (GOAL / SCOPE / CONTEXT / VERIFY / RETURN) — read it before writing the first prompt.
2. **Isolate.** Give every code-changing subtask its own workspace so they cannot interfere:
   - LayerFS bundle available → fork a Branch per agent (`layerfs`), merge on completion.
   - Else → `git worktree add ../<repo>-<task> -b agent/<task>` and have the subagent work only there.
3. **Dispatch in one step.** Start every subtask together, without waiting between them. Pick the executor per subtask from the table in Harness notes, and route every DSH model through magpie (`group/smart-split`); see `references/harness-commands.md` for exact invocations. Every prompt follows `references/subtask-prompt-template.md`; its RETURN section names the return contract: changed files + how each was verified, or a findings list.
4. **Merge.** As results land, check each one. When two subtasks disagree on the same thing, you decide — do not just take whichever finished last.
5. **Verify separately.** After merging, dispatch one fresh subagent (or `subagent_claude_code`) whose only job is review plus running the real tests. It must not be the same agent that wrote the code. Then report.

## Output

- A merged result in the main session plus the §4 report format (one-line conclusion → what changed, file:line → how it was verified → what's left / risks).
- Findings subagents return `file:line + problem + failure scenario` (cap ~8 findings each); you dedupe, confirm each, and report only the confirmed ones.
- Hand large artifacts to subagents as files, not pasted text; collect their reports as files too, so raw payloads don't fill your context.

## Stop conditions

- Two subtasks cannot be made independent → don't force parallel; run sequentially or re-plan with `m-plan`.
- A subtask mutating a shared resource (same DB, same config, a push/publish) → stop and ask before dispatching.
- A child fails, returns BLOCKED, or loses its workspace → re-dispatch once with more context or a stronger model; after that, escalate rather than retry the same thing a third time.

## Harness notes

Executor selection:

| Need | Executor |
|---|---|
| Parallel subtasks inside this session | Claude Code `Agent`; DSH `subagent` / `subagent_fork` |
| One-shot second opinion from another model | `subagent_claude_code` / `subagent_codex`; `codex exec` |
| Headless batch on WSL | `dsh --profile mola-cli` |
| Another vendor's agent (e.g. dispatching Codex from Claude), watching progress from a phone, or each worker in its own worktree left for the human to continue in | Orca — only when `orca` is on PATH |

- Claude Code: `Agent` / `Task` tool; use `run_in_background: true`; one dispatch message = parallel, sequential messages = sequential. Spawn responses carry an `agent_id` for follow-ups.
- DSH: `subagent` (supports `send_message` follow-up) or `subagent_fork` (inherits this session); `subagent_claude_code` / `subagent_codex` for one-shot second opinions; `workflow` for a fixed shape over N items. See `references/harness-commands.md`.
- Codex CLI: `codex exec "<task>"`.
- Orca: optional backend — desktop + CLI orchestrator where each worker gets its own worktree. Use it only when `orca` is on PATH; commands in `references/harness-commands.md`.
- Model choice: light reading/copyscribing → cheap model; architecture/review → stronger model; always set the model explicitly (an omitted model silently inherits the most expensive default). For DSH always route through magpie (`group/smart-split`); never a direct `deepseek/*` route.
