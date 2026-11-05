# ADR-0004: Unified hook bus — one canonical event vocabulary, two bridge kinds, per-run injection

- Status: proposed
- Date: 2026-11-06
- Inputs: `cli/design/BRIEF.md` (constraint 5), `inputs/claude-help.txt`, `codex-help.txt`,
  `kimi-help.txt`, `grok-help.txt`, `agy-help.txt`, `pi-help.txt`, `opencode-help.txt`,
  `omc-help.txt`, `inputs/dsh-architecture.md` (event domains), `inputs/orca-cli.md`
  (orchestration mail), plus the external docs cited in §4.

## Context

Constraint 5: hooks are first-class — one event/hook bus covering before/after tool run, session
start/end, task done, error, with adapters bridging each agent's native hooks into it.

The agents on this machine have wildly different surfaces:

- **claude**: settings-defined hooks (SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd, …
  per [the hooks docs](https://code.claude.com/docs/en/hooks) — names not in the captured help, so
  verified at detect time), plus `--include-hook-events` exposing hook lifecycle inside
  `--output-format stream-json`, and per-run `--settings <json>`.
- **codex**: `hooks.json` / `[hooks]` with ~12 lifecycle events, one JSON payload on stdin
  (`session_id`, `transcript_path`, `cwd`), blocking-capable; legacy single-event `notify`
  ([learn.chatgpt.com/docs/hooks](https://learn.chatgpt.com/docs/hooks),
  [unwait.ai](https://unwait.ai/blog/codex-hooks-config-toml)). Automation needs
  `--dangerously-bypass-hook-trust`.
- **opencode**: documented plugin event subscription (`permission.asked`, `message.updated`,
  `file.edited`, …) via `ctx.event.subscribe({ types })`
  ([opencode.ai/docs/plugins](https://opencode.ai/docs/plugins/),
  [server plugin docs](https://opencode.ai/v2/docs/build/plugins/server/)); OpenCode 2.x requires
  the default-export plugin shape.
- **dsh**: a Cordis event system — durable `turn/*`, `step/*`, `tool/call`, `tool/result`,
  `session/event`, live `agent/*`, waterfall `tools/pre-execute|execute|post-execute`
  (`dsh-architecture.md`). Plugins mount via profile patch; `--patch` overlays per run.
- **OMC**: stop-hook callbacks to file/telegram/discord/slack (`omc config-stop-callback`).
- **kimi, grok, agy, pi, devin**: no documented hook config surface in the captured help — but all
  have machine-readable headless streams (`stream-json`, ACP NDJSON, `--mode json/rpc`).
- **orca**: orchestration mail (`worker_done`, `escalation`, `question`) — already event-shaped.

Two more constraints from the machine itself: magpie owns agent config files (rewrites drift in
~15 s), so **mola must not persistently edit agent configs**; and OMC's own keyword/persistent hooks
are intentionally off (`OMC_SKIP_HOOKS`).

## Decision

### 1. Canonical event vocabulary

Namespace `mola.<domain>.<verb>`. The bus defines exactly these (extensible by plugins with their
own namespace):

| event | payload `data` | typical native source |
|---|---|---|
| `mola.session.started` | `{ agent, sessionId, cwd, machine }` | claude SessionStart; codex SessionStart; dsh `session/created`; stream: first line |
| `mola.session.ended` | `{ sessionId, exitCode?, reason? }` | claude/codex SessionEnd; process exit fallback |
| `mola.turn.started` / `mola.turn.completed` | `{ sessionId, turnId, usage? }` | dsh `turn/start`/`turn/end`; codex AfterAgent/notify; stream: result message |
| `mola.tool.before` | `{ sessionId, tool, argsSummary, callId }` | claude PreToolUse; codex PreToolUse; dsh `tools/pre-execute` |
| `mola.tool.after` | `{ callId, tool, ok, durationMs, outputSummary }` | claude/codex PostToolUse; dsh `tool/result` |
| `mola.agent.message` | `{ sessionId, role, textExcerpt }` | stream bridges (assistant/user messages) |
| `mola.agent.idle` | `{ sessionId }` | grok `tui-idle` (via orca terminal wait); OMC stop callback; dsh `agent/turn-stopping` |
| `mola.permission.requested` | `{ sessionId, action, risk }` | opencode `permission.asked`; claude Notification |
| `mola.error.raised` | `{ sessionId?, kind: 'quota'|'crash'|'hook', detail }` | adapter exit codes, 402 normalization (ADR-0003) |
| `mola.task.done` | `{ runId, sessionId, evidence? }` | orca `worker_done`; runHeadless completion |
| `mola.approval.granted` / `mola.approval.denied` | `{ action, approver }` | mola's own gate (constraint 7) |
| `mola.cost.reported` | `{ sessionId?, window, usage }` | `grok usage`, `magpie usage` samplers |

### 2. Envelope

```ts
interface HookEvent {
  id: string;              // ulid
  ts: string;              // ISO-8601
  kind: string;            // 'mola.tool.before', ...
  source: { agent: string; machine: string; sessionId?: string; runId?: string; worktree?: string };
  data: Record<string, unknown>;
  raw?: unknown;           // original native payload, kept for debugging
}
```

Delivery: in-process emitter in the mola core (TS); every event appended to
`.mstack/runs/<run-id>/events.jsonl` (durable, replayable); forwarding to the cloud sync backend is
a later batch and plugs in as just another subscriber. Handlers are async, isolated (a throwing
handler is logged, never breaks the agent), and ordered only per `sessionId`.

### 3. Two bridge kinds

**A. Native-hook bridge** — the agent's own hook mechanism pushes to the bus. Installed **per run,
non-invasively** (because magpie reverts config edits and because trust):

| agent | injection mechanism |
|---|---|
| claude | `claude -p ... --settings '{"hooks":{...}}'` — hooks POST to `mola hook-ingest` (localhost); plus `--include-hook-events` as corroboration |
| codex | `CODEX_HOME=<overlay>` containing only mola's `hooks.json` (the cmux-proven pattern, [cmux#1482](https://github.com/manaflow-ai/cmux/pull/1482)); runs add `--dangerously-bypass-hook-trust` only for mola-created overlays |
| opencode | one mola plugin file in `~/.config/opencode/plugins/` (2.x default-export shape) calling `ctx.event.subscribe`; written once, idempotent |
| dsh | `dsh-mola-bridge` Cordis plugin mounted via `--patch <overlay.yml>`; subscribes to `session/event` + `agent/*` + `tools/*` |
| omc | `omc config-stop-callback file <path>` → a tailer turns stop callbacks into `mola.agent.idle`; OMC's other hooks stay off |
| orca | orchestration mail IS the event stream; the adapter maps `worker_done`/`escalation`/`question` to `mola.task.done`/`mola.error.raised`/`mola.permission.requested` |

**B. Stream bridge** — parse the headless NDJSON stream into the same canonical events. Used by
kimi (`--output-format stream-json`), grok (`--output-format streaming-json`, which is ACP-shaped —
we reuse [ACP](https://zed.dev/acp) session-update message types as the parse target), agy
(`stream-json`), pi (`--mode json` / `--mode rpc`), devin (`--export` tail), dsh (`--json` as a
fallback when the bridge plugin isn't mounted), and claude/codex as a fallback when native hooks
are unavailable. Stream bridges synthesize at minimum `session.started`, `agent.message`,
`turn.completed`, `session.ended`, and `error.raised`.

Adapters declare `nativeHooks: true/false` in capabilities; the bus picks bridge A when available,
B otherwise, and records which in the run record.

### 4. Ingest endpoint

`mola hook-ingest` (localhost HTTP, random port per daemon, token in the run's env) receives native
hook POSTs; `HookBridgeHandle` normalizes them into `HookEvent`s. Stdin-style hooks (codex) point
at a `mola hook-ingest --stdin` shim command.

## Alternatives considered

- **Poll transcripts** (`~/.claude/projects/*.jsonl`, `~/.codex/sessions`) instead of hooks.
  Rejected as primary: high latency, format churn, and `04-session-resume.md` shows the paths are
  machine-specific. Kept as a debugging tool (`mola logs`), not the bus.
- **Adopt ACP wholesale as the bus protocol.** Rejected: ACP is client↔agent request/response,
  great as a *stream-bridge parse target* (and used that way), but it has no notion of hooks,
  permissions across heterogeneous agents, or mola's approval events.
- **Make OMC's hook stack the bus.** Rejected: OMC is Claude-only, its overlapping workflow is
  superseded by mstack on this machine, and its persistent hooks are deliberately disabled.
- **Persistently write hook configs into agent files.** Rejected: magpie rewrites drifted configs;
  per-run injection (`--settings`, `CODEX_HOME` overlay, `--patch`) survives and is auditable.

## Consequences

- Every `mola` run produces a replayable `events.jsonl` regardless of agent — this is what lets
  `mola goal`/`mola team` reconstruct progress and what the cloud-collab sync backend will ship.
- Adding an agent = adding one bridge (A or B); the vocabulary and consumers don't change.
- Hook payload schemas differ per agent and version ⇒ bridges validate and downgrade to
  stream-bridge level on mismatch, logging `mola.error.raised { kind: 'hook' }` instead of crashing.
- Risk: claude/codex hook event names are taken from external docs, not the captured help — mitigated
  by detect-time verification (§2.1/§2.2 of the section doc).

## References

- [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) and
  [notify vs hooks comparison](https://unwait.ai/blog/codex-hooks-config-toml)
- [OpenCode plugin events](https://opencode.ai/docs/plugins/) ·
  [v2 server plugin API](https://opencode.ai/v2/docs/build/plugins/server/)
- [Agent Client Protocol](https://zed.dev/acp) · [schema repo](https://github.com/zed-industries/agent-client-protocol/)
- [cmux CODEX_HOME overlay pattern](https://github.com/manaflow-ai/cmux/pull/1482)
- DSH event domains: [dsh-architecture.md](../inputs/dsh-architecture.md)
