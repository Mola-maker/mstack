---
name: m-handoff
description: Save your current working context to `.mstack/handoff.md` so any future session (same or different model) can resume without re-deriving state, and restore it on reload — always write before compact, model switch, or session end. Use when "存档 / 保存进度 / 接着上次 / 换模型 / compact".
whenToUse: Before compaction, switching models, or ending a session; or when asked to resume / "where was I" / "pick up where I left off".
---

# m-handoff

A handoff is a durable, overwritable checkpoint of *decisions and where you are*, not a chat transcript. Write it at every leaving-point so the next session reads one short file instead of reconstructing context from scratch — and so your decisions don't die with the context window.

## When to use / not use

Use at: before `/compact`, before switching model or harness, at session end, before a long-running job starts unattended, and at the end of any `m-goal` cycle (closeout).

Do NOT use it for lessons that should live in durable memory (→ `m-learn`), fresh planning (→ `m-think` / `m-plan`), or shipping (→ `m-ship`). The handoff is the *current-state* record, not a knowledge base.

## Procedure

### Save

1. **Gather state.** Capture the branch, `git status --short`, and changed files — no code edits here; read only.
2. **Write `.mstack/handoff.md`** (overwrite; move the prior one to `handoff-archive/`). Cover: the goal being worked on; decisions made and *why* (alternatives rejected, trade-offs); remaining work in priority order with a provenance mark — `(done)` / `(verified)` / `(assumed)` so the next session knows what to re-check; and notes (gotchas, blockers, things tried that failed).
3. **Mark every future step honestly.** A step you have not run gets `(assumed)`, never a completion token. Provenance is what makes a resume safe instead of a fresh start.
4. **Report.** One-line what was saved and where, in the session's language.

### Restore

1. If `.mstack/handoff.md` exists, read it first and resume from the top unchecked step — *re-verify* anything marked `(assumed)` before running it; git may have moved past the save.
2. If it is absent or stale, rebuild the brief from `git log` / `git status` and recent transcripts (`m-learn`'s reflect path, or the harness's transcript dir) rather than pretending nothing happened.
3. Present the capsule: goal → where it stands → next single action → open risks.

## Output

A written `.mstack/handoff.md` (markdown), plus on restore a tight brief: up to ~5 status lines (one per thread, tagged `[in flight]` / `[open PR #N]` / `[verified, uncommitted]` / `[planned]`), at most ~5 recurring problems, and the single most useful next step.

## Stop conditions

- Handoff would record an unverified claim as fact → stop and mark it `(assumed)` or verify it first; a false checkpoint is worse than none.
- Restore finds the branch diverged since the save (older `head`) → treat every "remaining" item as `(assumed)` and verify before acting; do not silently continue.

## Harness notes

- Claude Code: transcripts live under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<uuid>.jsonl` — a source when no handoff exists.
- DSH: use `send_message` to a still-live child to request its own handoff before it exits; `subagent_fork` inherits this session, so a fork can resume directly.
- Codex: the file on disk is the only portable state; `codex exec` gets the handoff path in its prompt, since it has no shared session memory.
