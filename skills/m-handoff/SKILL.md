---
name: m-handoff
description: "Save or restore working state in .mstack/handoff.md before compact, model switch or session end. Use for 存档/交接/接着上次/compact."
whenToUse: "Before compaction, switching models, or ending a session; or when asked to resume / \"where was I\" / \"pick up where I left off\"."
when_to_use: "Before compaction, switching models, or ending a session; or when asked to resume / \"where was I\" / \"pick up where I left off\"."
---

# m-handoff

A handoff is a durable, overwritable checkpoint of *decisions and where you are*, not a chat transcript. Write it at every leaving-point so the next session reads one short file instead of reconstructing context from scratch — and so your decisions don't die with the context window.

## When to use / not use

Use at: before `/compact`, before switching model or harness, at session end, and before a long-running job starts unattended.

Do NOT use it for the `m-goal` closeout (m-goal owns that and writes it inside `.mstack/goals/<slug>.md`; the handoff only links to it), for lessons that should live in durable memory (→ `m-learn`), for fresh planning (→ `m-think` / `m-plan`), or for shipping (→ `m-ship`). The handoff is the *current-state* record, not a knowledge base.

## Procedure

### Save

1. **Gather state.** Capture the branch, `git status --short`, and changed files — no code edits here; read only.
2. **Write `.mstack/handoff.md`** (overwrite; move the prior one to `handoff-archive/`). Lay it out in three layers (template: `references/handoff-template.md`):
   - **Task frame** (stable): the goal being worked on, the constraints, and a link to the goal file's `## Closeout` if one exists (the handoff never writes the closeout itself).
   - **Progress** (condensed): decisions made and *why* (alternatives rejected, trade-offs); remaining work in priority order, each step with a provenance mark — `(done)` / `(verified)` / `(assumed)`; notes (gotchas, blockers, things tried that failed).
   - **Recent steps** (verbatim): the last few commands and their key outputs, enough to pick up the thread. Prune this layer on every rewrite — rewriting the handoff *is* the explicit summarize-and-prune step: the task frame stays, the progress layer is re-condensed, old verbatim steps are dropped.
3. **Mark every future step honestly.** A step you have not run gets `(assumed)`, never a completion token. Provenance is what makes a resume safe instead of a fresh start.
4. **Report.** One-line what was saved and where, in the session's language.

### Restore

1. If `.mstack/handoff.md` exists, read it first and resume from the top unchecked step — *re-verify* anything marked `(assumed)` before running it; git may have moved past the save. An `## Auto snapshot` section (written by the plugin's pre-compact hook, see Harness notes) is mechanical state only: trust its branch/status data, but it carries no decisions.
2. If it is absent or stale, rebuild the brief from `git log` / `git status` and the harness's transcript dir rather than pretending nothing happened.
3. Present the capsule: goal → where it stands → next single action → open risks.

## Output

A written `.mstack/handoff.md` (markdown, three layers), plus on restore a tight brief: up to ~5 status lines (one per thread, tagged `[in flight]` / `[open PR #N]` / `[verified, uncommitted]` / `[planned]`), at most ~5 recurring problems, and the single most useful next step.

## Stop conditions

- Handoff would record an unverified claim as fact → stop and mark it `(assumed)` or verify it first; a false checkpoint is worse than none.
- Restore finds the branch diverged since the save (older `head`) → treat every "remaining" item as `(assumed)` and verify before acting; do not silently continue.

## Harness notes

- Claude Code: transcripts live under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<uuid>.jsonl` — a source when no handoff exists.
- Claude Code plugin hooks (shipped in `hooks/hooks.json` at the plugin root): **PreCompact** runs `hooks/precompact.mjs`, which writes one `## Auto snapshot` section (branch, `git status --short`, the goal whose `state.json` says `active`, timestamp) into `.mstack/handoff.md`, replacing the previous auto-snapshot section instead of appending another — hand-written content above it is kept. A repo with no commits yet is labelled `(no commits yet)`. **SessionStart** with matcher `compact` runs `hooks/session-compact.mjs`, which prints a one-line reminder to read the handoff if it exists. Both exit 0 on any error, finish well under a second, and never touch the network. The decisions layers stay the job of this skill.
- DSH: use `send_message` to a still-live child to request its own handoff before it exits; `subagent_fork` inherits this session, so a fork can resume directly.
- Codex: the file on disk is the only portable state; `codex exec` gets the handoff path in its prompt, since it has no shared session memory.
