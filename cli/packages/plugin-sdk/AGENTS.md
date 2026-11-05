# @mola/plugin-sdk — agent adapter run surface (B2)

Audience: whoever builds `mola run` / the routing engine (phase 2 of B2) and any
new agent adapter. The interfaces live in `src/agents.ts` — this file is the
consumer/implementation contract; the per-agent flag mappings and honesty gaps
are in `cli/design/sections/adapters-routing.md` (§2), grounded in
`cli/design/inputs/*-help.txt` (never invent flags).

## Two interfaces, one registry

`ctx.agents` holds `AgentAdapter` (`src/types.ts`) — the B1 detection surface
(`id` + `detect()`). tool-magpie registers a probe-only adapter under it; do not
tighten that interface.

The B2 run surface is `HeadlessAgentAdapter extends AgentAdapter`
(`src/agents.ts`): `capabilities`, `run()`, `resume()`, plus optional
`listSessions()` / `usage()` / `setModel()` / `bridgeHooks()`. Narrow at the
call site:

```ts
const adapter = ctx.agents.get(agentId);
if (!adapter || !isRunnableAgent(adapter)) → MolaError("AGENT_NOT_FOUND", exit 66);
const result = await adapter.run({ prompt, cwd, modelRoute, runId, onEvent });
```

Builtin runnable adapters today: `dsh` (agent-dsh), `claude` (agent-claude),
`codex` (agent-codex). A new agent implements `HeadlessAgentAdapter` and
registers itself in its own plugin's `activate()`.

## Calling `run(req)` — the contract

`RunRequest` (`src/agents.ts`) fields and how adapters treat them:

| field | contract |
|---|---|
| `prompt` | the task text; never interpolated into a shell string by the adapter |
| `cwd` | where the agent runs; dsh maps it into WSL (`/mnt/...`), claude/codex spawn with it |
| `modelRoute` | a magpie route (`group/*` or `auto/*`, ADR-0003). Recorded on every event and in the result. Applied per agent: dsh → `--patch` overlay `{provider: magpie, model: <route>}`; claude → `--model <route>`; codex → `-m <route>` (the per-run escape hatch of adapters-routing §1.1 — the durable setting is always `magpie <agent> <route>`, which is what `setModel()` does) |
| `permissionProfile` | `read-only`/`plan` → claude `--permission-mode plan`, codex `--sandbox read-only`; `workspace-write` → claude `acceptEdits` (dsh `--permission-mode workspace-write`), codex `--sandbox workspace-write`; `full-auto` → claude `bypassPermissions`, codex `--sandbox danger-full-access` — **the router must gate `full-auto` behind approval** (BRIEF #7); dsh has no captured preset for the other modes and omits the flag |
| `addDirs`, `budgetUsd` | passed only where the captured help has a flag (`--add-dir` everywhere; budget only claude `--max-budget-usd`) |
| `sessionId` | set ⇒ resume instead of a fresh session; `"latest"` ⇒ the agent's continue-latest (`claude -c`); dsh and codex reject `"latest"` with `UnsupportedCapability` |
| `fork` | `--fork-session` (claude only, with resume/continue) |
| `timeoutMs` | default 3 600 000 ms (1 h, mirroring `timeout 3600` in tasks/dispatch.sh) for dsh; none for claude/codex |
| `runId` | the `.mstack/runs/<runId>/` key; the adapter mints `run-<8 hex>` when absent |
| `onEvent` | receives the same `HookEvent` envelopes the adapter emits on the bus — **use it to persist `events.jsonl`**; the adapters do not write it themselves |

Events emitted by every `run()` (ADR-0004 §1, in order):
`mola.session.started` → (`mola.agent.message`)* → `mola.turn.completed` →
(`mola.task.done` | `mola.error.raised`) → `mola.session.ended`. Envelope
`source` is `{agent, machine, sessionId?, runId}`; `machine` is
`wsl:<distro>` for dsh, `local` for claude/codex.

`RunResult`:
- `sessionId` — echo of the request id, or the agent's own id parsed from the
  stream (claude `session_id`, codex `thread_id`, dsh `session_id`); **pass
  this back as `sessionId` on the next run to resume a conversation**.
- `exitCode` — the child process exit code; router maps it to its own exit.
- `finalText` — the final assistant message.
- `usage` — `source: "agent"` when parsed from the agent's own stream (claude
  result/turn usage, dsh token counts), `"magpie"` for rows from
  `magpie usage <w> --csv` (the `usage()` method; dsh *cost* is always
  magpie's).
- `quotaFailure` — normalized `{provider:"magpie", route, status}` when the
  failure text is quota-shaped (402 / 429 / rate-limit, ADR-0003 §4). Recovery
  (quota wait, route switch, agent switch) is the router's job.
- `events` — the envelopes emitted, for the run record.

Errors:
- unknown agent → `AGENT_NOT_FOUND` (exit 66) — the router's job before calling.
- capability the agent does not have (e.g. `codex` resume when the
  `codex exec --help` probe did not confirm it, `claude` listSessions) →
  `UnsupportedCapability` (`code: "UNSUPPORTED_CAPABILITY"`, exit 69). Check
  `capabilities` first; the throw is the honest fallback, not a control flow.
- spawn failure / timeout → the adapter emits `error.raised` +
  `session.ended {reason:"aborted"}` and rethrows; treat like exit 124.

## Per-adapter facts (B2)

- **dsh** (`agent-dsh`): WSL only, profile `mola-cli`, prompt on stdin, NDJSON
  `--json` stream (real shape observed: `{"type":"session","sessionId":…}` →
  `status` events → `{"type":"final","text":…}`). `listSessions: false` — mola's
  state store is the session registry. Model overlay written to
  `.mstack/runs/<runId>/model-overlay.yml`; the applied `--permission-mode` (or
  `null` when the profile has no captured preset) is reported in
  `mola.session.started` so the router knows what is actually in effect. Token
  counts parsed from the stream land in `RunResult.usage` with
  `source: "agent"`; dsh *cost* always comes from magpie (`costReadout:
  "magpie"`).
- **claude** (`agent-claude`): `-p --output-format stream-json
  --include-hook-events` + per-run `--settings` (bridge A, session-lifecycle
  hooks only) pointing at the generated `.mstack/runs/<runId>/hook-sink.cjs`.
  The hook event names are not in the captured help and are not verifiable at
  detect time on a machine without the binary — the bridge is fail-soft (a
  name mismatch leaves a hook unfired) and the stream channel carries the
  events regardless, per ADR-0004's downgrade rule. `listSessions` throws: `claude agents` is
  background-only; historical sessions are `magpie sessions` (tool-magpie).
  Cost readout via magpie; the stream's `total_cost_usd` still lands in
  `RunResult.usage` with `source: "agent"`.
- **codex** (`agent-codex`): `codex exec`; `--sandbox` / `-a never` ride only
  when the probe confirmed them, and an unverified surface fails closed
  (`UnsupportedCapability`) instead of firing blind headless flags. The
  `--json` / `resume` / `--last` / `--output-last-message` surface is
  **probed at detect time** (`codex exec --help`) and only used when confirmed
  (honesty list #3). `listSessions` via `codex agents` (JSON or table, parsed
  defensively). Never passes `--dangerously-bypass-hook-trust` (DESIGN §11
  conflict 4) — its bridge is the stream, not hook injection.
  **Router trap:** read `adapter.capabilities` AFTER `detect()` — codex's
  capabilities are probe-aware and only claim `resume`/`headlessJsonStream`
  once the probe confirmed them; the pre-detect values are the captured-help
  minimum.

## Rules for new adapters

1. Flags only from `cli/design/inputs/<agent>-help.txt`; anything not captured
   is either probed at detect time or declared as a capability gap (see the
   honesty list, adapters-routing §7).
2. Emit the six event kinds above on the bus AND through `onEvent`; keep
   `source.agent` = the adapter id and `source.machine` truthful.
3. Mock external processes in tests (fake `ExecService`); at most one tiny real
   run per adapter outside tests, reported in the batch summary.
4. Platform checks via `process.env.MOLA_PLATFORM ?? process.platform`; npm CLIs
   on Windows spawn through `cmd /d /c` (`winSafeArgv`).
5. The adapter never edits an agent config file (magpie owns them, ~15 s
   rewrite) — `setModel()` shells out to `magpie <agent> <route>`.
