# `mola` — merged architecture (synthesis)

Status: merged design, supersedes disagreements between the area sections (all resolved in
§11). Detail lives in the sections and ADRs; this file is the map, not the territory.

- Sections: [core-plugins.md](sections/core-plugins.md) ·
  [adapters-routing.md](sections/adapters-routing.md) · [envs-collab.md](sections/envs-collab.md)
- ADRs: [0001 TS↔Rust boundary](adr/0001-ts-rust-boundary.md) ·
  [0002 plugin manifest](adr/0002-plugin-manifest-and-loading.md) ·
  [0003 routing policy](adr/0003-routing-policy.md) · [0004 hook bus](adr/0004-hook-bus.md) ·
  [0005 sync backend](adr/0005-sync-backend.md)

## 1. Overview

```text
            human / skill (m-start…m-ship) / phone / another agent
                                   │
                        mola  (TS host, Node ≥22, one bin)
                                   │
   ┌───────────────────────────────┼────────────────────────────────────────┐
   │ CORE — the only non-plugin code                                        │
   │ plugin loader · command router · event/hook bus · config · state · log │
   └───────────┬───────────────────────────────────────────┬────────────────┘
               │ PluginContext                             │ JSON-RPC 2.0 / NDJSON stdio
   ┌───────────▼──────────────────┐          ┌─────────────▼─────────────────────────┐
   │ PLUGINS (everything else)    │          │ RUST SIDECARS (crates/, ADR-0001)     │
   │ cmd-*  command plugins       │          │ mola-ptyd    PTY/process supervisor   │
   │ agent-* agent adapters       │          │ mola-syncd   sync/event daemon        │
   │ tool-*  tool adapters        │          │ mola-layerfs LayerFS checkpoint unit  │
   │ env-*   environment adapters │          └─────────────┬─────────────────────────┘
   │ sync-*  sync backends        │                        │
   │ policy-* approval gates      │                        │
   └───────────┬──────────────────┘                        │
               │ wraps, never rebuilds (BRIEF #4)          │
   magpie (models/MCP/instructions/RTK) · DSH headless (WSL, profile mola-cli) ·
   claude/codex/kimi/grok/agy/devin/pi/opencode CLIs · git+gh · rtk · omc · orca ·
   tailscale · docker · LayerFS
               │
   transports: tailnet (WireGuard, self-hosted DERP on aliyun)
               └── NATS JetStream master on tencent-cloud 4c4g + leaf node per machine
```

Two-level division of labor (BRIEF #3, ADR-0003): **mola picks agent + machine + workspace;
magpie picks the model** (route ids only, never keys, never agent-config edits).

## 2. Packages and crates

Inside mstack (BRIEF: ships with the skills; skills stay a separate artifact consumed by
Claude Code / DSH / Codex). Full tree and install story: [core-plugins.md §1](sections/core-plugins.md).

```text
cli/                      pnpm workspace, Node ≥22
├─ packages/mola/         the `mola` bin — thin: arg parsing → @mola/core boot
├─ packages/core/         @mola/core: loader, router, bus, config, state, logging, errors
├─ packages/plugin-sdk/   @mola/plugin-sdk: Plugin/PluginContext + all adapter interfaces +
│                         manifest JSON Schema (the only place interfaces are defined)
├─ packages/rpc/          @mola/rpc: JSON-RPC 2.0 NDJSON client/server for sidecars
└─ packages/plugins/      first-party plugins, one package each:
   cmd-doctor cmd-config cmd-plugin cmd-dispatch cmd-model cmd-rtk …
   agent-dsh agent-claude agent-codex … tool-magpie tool-git tool-rtk tool-omc …
   env-local env-wsl env-ssh-peer … sync-nats policy-approval
crates/                   cargo workspace
├─ mola-proto/            serde types = protocol source of truth → JSON Schema → TS types
├─ mola-ptyd/ mola-syncd/ mola-layerfs/      sidecar binaries (ADR-0001)
skills/ .claude-plugin/   unchanged
```

Distribution: `npm i -g mola`; Rust sidecars arrive as `optionalDependencies` platform
packages (`@mola/ptyd-linux-x64-gnu`, …), resolver falls back to PATH then
`cargo install`. WSL resolves `linux-*` per-process. Sidecars speak JSON-RPC 2.0 NDJSON
stdio with a `mola.hello` handshake; protocol drift fails both `cargo test` and the vitest
fixture suite ([ADR-0001](adr/0001-ts-rust-boundary.md), [core §9](sections/core-plugins.md)).

## 3. Core

The core owns exactly six services ([core §2](sections/core-plugins.md)):

- **Loader** — resolve (builtin → `~/.mola/plugins` → project `.mola/config.jsonc`) →
  validate → plan (topo sort over `provides`/`requires`, conflict check, permission diff) →
  activate. One broken plugin is quarantined (stub commands, exit 70); boot continues.
  Cordis-style dispose stack: every registration is an effect that unwinds.
- **Router** — commands are namespaced paths (`agents list`, `plugin install`); longest
  path wins; aliases are config, not code. Handlers never call `process.exit`.
- **Event/hook bus** — §6 below.
- **Config** — five deep-merged JSONC layers: builtin defaults < `~/.mola/config.jsonc` <
  `.mola/config.jsonc` < `MOLA_*` env < flags. Read-only `ConfigView` + `onChange`; writes
  only via `mola config set`, validated against the union of plugin `configSchema`s.
  Secrets are never config. Routing policy lives in `~/.mola/policy.jsonc` (+ project
  override merged under it) — same JSONC rule, content per [ADR-0003 §2](adr/0003-routing-policy.md).
- **State** — `~/.mola/state.json` (JSON store) in B1, `~/.mola/state.db` (SQLite via
  `node:sqlite`) from B2, behind the `StateStore` interface either way
  ([core §2.5/§10](sections/core-plugins.md)). Rebuildable cache lives in `~/.mola/cache/*.json`
  with TTLs, never in the DB. Contents: run history (traceId, argv, exit, duration),
  plugin registry + granted permissions, sidecar adoption records, session/task handles.
- **Logging** — pino JSON lines to `~/.mola/logs/mola.log` (5×10 MB rotation); every
  invocation mints a `traceId`, exported as `MOLA_TRACE_ID` to workers and sidecars.

Exit codes follow `sysexits.h`: 0 ok · 64 usage · 65 bad manifest/config · 66 missing
input · 69 upstream unavailable · 70 software · 77 policy denied/approval required.
`--json` everywhere: one envelope `{schemaVersion, command, traceId, data}` on stdout,
diagnostics on stderr, errors as `{error:{code,message}}` (core §8).

## 4. Plugin model

One `mola-plugin.json` per plugin; `kind ∈ agent|tool|env|sync|command|policy`;
`provides`/`requires` as capability-id string arrays; `entry` is `{ts}` (ESM) or
`{bin, protocol: "jsonrpc-stdio"}` (Rust). Full format, trust tiers and honesty caveats:
[ADR-0002](adr/0002-plugin-manifest-and-loading.md).

- Trust tiers: `builtin` (in-process) / `verified` (registry + tarball SHA-512, in-process
  if permissions fit the approved profile) / `untrusted` (worker isolate). The real
  security boundary is the **install-time permission diff**; runtime permission handles
  (`ctx.process/fs/config/state`, `env.read` name-scoped) are the audit boundary.
- Install = pnpm forwarded verbatim into `~/.mola/plugins/` (the `dsh plugin` model) +
  permission-diff confirmation + hash pin. Update re-runs the diff, mandatory.
- Death-loop brake is core: the same listener throwing / the same waterfall rejecting
  3 consecutive times quarantines the plugin (FRAMEWORK guard rule).
- `mola plugin validate <dir>` checks a checkout; `mola plugin doctor` runs
  resolve→plan without activating; both fold into `mola doctor`.

## 5. Adapters and routing

Interfaces (`AgentAdapter`, `ToolAdapter`, `EnvironmentAdapter`, `OrchestratorAdapter`)
live in `@mola/plugin-sdk` — single definition point; the per-agent flag mappings are in
[adapters-routing §2–3](sections/adapters-routing.md), grounded in the captured
`cli/design/inputs/*-help.txt` (no invented flags). Summary:

- **Agents** (12): dsh is the reference adapter (WSL, `--profile mola-cli`, `--json` NDJSON,
  `--session-id` resume, richest hook surface via a Cordis bridge plugin); claude has the
  best headless stream + background sessions + native budget cap; codex/kimi/grok/agy/
  devin/pi/opencode get stream bridges; omp is detect-only until its Bun crash is fixed
  (routes fall back to pi); orca is an orchestrator adapter, ships disabled until it is on
  PATH.
- **Tools** (6): git+gh (worktrees, PRs — outward actions gated), omc (team CLI, wait,
  teleport; superseded workflow skills are never routed to), rtk (`rewrite`/`bypass`/`pipe`
  + `gain` telemetry), magpie (models/routes/quota/library/gateway keys — the model brain),
  layerfs and docker (thin, later batches; no captured help ⇒ stable verbs only).
- **Routing** ([ADR-0003](adr/0003-routing-policy.md)): policy file defines per-task-kind
  agent lists, machine preference, `allowedHeadless: ["group/*","auto/*"]` and
  `bannedHeadless: ["deepseek/*"]` (402 fleet-kill). Filter (health, capabilities, machine
  online, pinned agent) then score (kind affinity, cost from `magpie quota`, route fit
  against the agent's visible set, machine rank, decayed failure memory). Output:
  `RouteDecision {agent, machine, workspaceDir, modelRoute, fallbacks[], reason}` logged to
  `.mstack/runs/<runId>/decision.json`. Quota failures are first-class: retry once →
  `magpie quota wait` → switch route (re-dispatch only the remaining work) → switch
  agent/machine → report. B1 ships only the dsh+WSL slice of this; the full engine is B2.
- **Skill wrapping** ([adapters-routing §5](sections/adapters-routing.md)): `mola
  think|plan|goal|team|dispatch|review|ship` wrap the m-* skills on top of the router;
  `mola dispatch` is the B1 workhorse (today's `tasks/dispatch.sh` flow, see §10).

## 6. Hook bus

Canonical vocabulary, envelope and per-agent bridges: [ADR-0004](adr/0004-hook-bus.md).
Event names are `mola.<domain>.<verb>` (`mola.session.started|ended`, `mola.turn.*`,
`mola.tool.before|after`, `mola.agent.message|idle`, `mola.permission.requested`,
`mola.error.raised`, `mola.task.done`, `mola.approval.granted|denied`, `mola.cost.reported`,
plus core lifecycle `mola.core.boot|shutdown`, `mola.config.changed`, `mola.plugin.*`,
`mola.sidecar.*`). Envelope: `{id, ts, kind, source:{agent,machine,sessionId,runId}, data, raw?}`.

Delivery semantics (core §3) by event class:
- **broadcast** — facts; a throwing handler is logged, never breaks the producer.
- **waterfall** — policy gates; listeners may rewrite or reject. Gate events:
  `mola.tool.before` (approval classifier over argv) and `mola.task.pre-dispatch`
  (routing policy). Reject ⇒ exit 77; `--yes` / `MOLA_YES=1` skips when policy allows.
- **serial** — ordered observers (boot/shutdown).

Two bridge kinds per agent: **native-hook bridges** (claude per-run `--settings` +
`--include-hook-events`; codex `CODEX_HOME` overlay with trusted hooks only — see §11
conflict 4; opencode plugin `ctx.event.subscribe`; dsh `dsh-mola-bridge` via `--patch`;
omc stop-callback tailer; orca orchestration mail) and **stream bridges** (parse headless
NDJSON — kimi/grok/agy/pi/devin/claude/codex/dsh — with ACP message types as the parse
target where shaped so). Every run appends its events to
`.mstack/runs/<runId>/events.jsonl` (replayable; the sync backend later subscribes to the
same stream). Native hook configs are injected **per run**, never persisted — magpie would
revert them within ~15 s anyway.

## 7. Environments

`EnvironmentAdapter {probe, exec, sync, forward}` per
[envs-collab §1](sections/envs-collab.md); Rust daemon (`mola-syncd`/remote-exec path)
exposes `env.exec|sync|forward` over the same JSON-RPC boundary; TS never opens network
sockets directly. Five builtins: `local-windows` (spawn/ConPTY), `wsl` (`wsl.exe -d …
--exec`, `/mnt/e` path mapping), `ssh-peer` (`tailscale ssh`, rsync/Taildrop,
`tailscale nc`), `cloud-vm` (same channel; aliyun = DERP + entry, tencent = resident
services, bwh = exit only), `container` (`docker exec/cp/port`). Env ids are read from
`tailscale status --json`, never hard-coded; phones are clients, not envs.
`mola doctor --envs` probes each env (tailscale status/ping, channel smoke test,
sync backend state).herdr/LayerFS/OpenAgentCore adapters are placeholders until their
help is captured.

## 8. Collaboration

Model and backend: [envs-collab §3–4](sections/envs-collab.md),
[ADR-0005](adr/0005-sync-backend.md). Shared types: `Goal / Task / Claim(epoch+renewsAt) /
Artifact / Presence / GateRequest / CollabEvent`. Invariants: single writer per task
(KV-revision CAS claim + fencing epoch on artifacts/logs), idempotent replay by
`(goalId, seq)`, self-contained task specs (Orca rule).

- **Backend (default, decided):** self-hosted **NATS + JetStream** — master on the
  tencent-cloud 4c4g, one leaf node per machine (offline buffering + store-and-forward),
  traffic over tailnet. One binary gives events, KV, object store, req/rep; first-class
  TS (`@nats-io/*`) and Rust (`async-nats`) clients. Subjects: `mola.goals.<id>.events`,
  `mola.logs.<id>.<agent>`; KV `goals|tasks|lease|sessions|presence`; Object Store
  `artifacts.<id>`. Redis Streams stays a plugin alternative; Supabase/CF-DO/Liveblocks/
  Temporal rejected (ADR-0005 has the reasons); Yjs/yrs is an optional CRDT layer on top,
  not a backend. Master unreachable ⇒ local mode: file-lock leases, `backend: degraded`,
  no auto-failover.
- **Sessions, two layers** (mola-infra phases): **attach-first** — `mola sessions`
  aggregates per-host session registries (KV bucket `sessions`), `mola sessions attach`
  switches to a local tmux/Orca terminal or `tailscale ssh … tmux attach`; **handoff**
  later — probe target → freeze workspace (LayerFS checkpoint, else WIP commit, never
  push) → single-writer lease → transcript export → `paths.toml` rewrite → object-store
  transfer → release/re-take lease → resume (`claude --resume` / `codex resume` /
  `dsh --session-id`). Credentials, `node_modules`, caches never move.
- **Orca / m-team bridges:** orca run/task/worker state maps onto Goal/Task/Presence
  (mola is the bus, Orca stays the desktop orchestrator); m-team rounds read
  `mola goal status` for claims + evidence, mola does not define roles.

## 9. Security

- **Approval gate (BRIEF #7):** push/merge/publish/delete/payment/message-human must pass
  the `mola.tool.before` waterfall (policy plugin classifier) or a collaboration
  `gate.request`; deny ⇒ exit 77. `full-auto` permission profiles and outward actions
  require `approval: batch-approved` or interactive yes. Remote (phone) callers can
  approve but never relax the policy; unapproved gates expire **fail-closed**.
- **Secrets:** never in config, KV, events or artifacts; provider keys stay in magpie /
  user's vault; `env.read` is name-scoped; remote workers get short-lived budget-capped
  `magpie gateway-key issue` tokens instead of copied keys. Secret refs
  (`$ref:secret/<name>`) resolve at exec time via the user's chosen backend (mola stays
  agnostic — §11 conflict 11); transcripts pass a secret filter before leaving a machine.
- **Peers:** tailnet identity is the base (`tailscale whois` allow-list on `mola serve
  --remote`, bound to a concrete tailnet IP); per-device bearer tokens revocable; one
  NATS credential per machine, subject-scoped; optional `tailscale lock`.
- **Plugins:** install-time permission diff + hash pin + trust tiers (§4); third-party
  Rust plugins inherit process isolation; optional SkillSpector scan before install.

## 10. CLI command tree

B1 commands marked ●; the rest arrive with their batch (see [BATCHES.md](BATCHES.md)).

```text
mola [--json] [-v…] [-q] [--config <path>] [--cwd <dir>] [--no-color] [--yes] <command>
● doctor [--fix] [--envs]          health: node, plugins, magpie, agents, tools, sidecars, envs
● agents list|show <id>            discovery: PATH probe + `magpie ls`/`magpie agents` merge
● dispatch <task-file|-> [--agent dsh] [--route <id>] [--yes] [--json]
                                   wraps tasks/dispatch.sh: WSL dsh --profile mola-cli
                                   --patch <auto overlay: group/smart-split> --json
● model show <agent> | set <agent> <route> | routes   thin passthrough to magpie,
                                   whitelist-enforced (group/*, auto/*; deepseek/* banned)
● rtk <args…>                      verbatim passthrough: `mola rtk bypass|rewrite|pipe|gain …`
  config list|get|set|edit|path    (● B1 minimal: get/set)
● plugin list | validate <dir>     list builtin set; validate a manifest checkout
  plugin install|update|remove|enable|disable|doctor         B2 (third-party support)
  run "<task>" [––agent] [--on <env>] [--route]    B2 full router (dispatch is its skill wrapper)
  think|plan|goal|team|review|ship B2+ skill-wrapped commands (§5)
  hooks list                       B2  active bus listeners + owning plugin
  runs list|show <traceId>         B2  run history (state store)
  sessions list|attach|handoff     B3/B5  envs list|probe    B3
  goal create|status|archive  task add|claim|done|message    B4
  serve --remote                   B6  skills install [--claude|--dsh|--codex]   B2
  sidecar list|restart             B3  completions <shell>  version   B2
```

## 11. Resolved conflicts

| # | Topic | Section A said | Section B said | Decision | Why |
|---|---|---|---|---|---|
| 1 | Event names | core-plugins §2.3: `tool/pre-run`, `agent/run-started`, slash style | adapters-routing §5: `run.started`, `approval.granted`; ADR-0004 §1: `mola.<domain>.<verb>` | ADR-0004 `mola.*` vocabulary is the single canonical set; core §2.3 table is remapped (`tool/pre-run`→`mola.tool.before`, `agent/run-started`→`mola.session.started`) | ADR-0004 is the dedicated decision; one namespace for bus, bridges and sync backend |
| 2 | Manifest file & shape | core-plugins §4 + ADR-0002: `mola-plugin.json`, `kind: agent`, `provides: ["agent:claude"]` | adapters-routing §1.3: `mola.plugin.json`, `kind: "agent-adapter"`, `provides: {agent:"claude"}`, extra `batches` field | ADR-0002 wins: `mola-plugin.json`, six fixed kinds, `provides`/`requires` string arrays; no `batches` field (batch tracking lives in BATCHES.md) | Rust plugins have no package.json; one schema must cover both; per-file batch tags drift |
| 3 | Where adapter code lives | core-plugins §1: `cli/packages/plugins/agent-*`, interfaces in `plugin-sdk` | adapters-routing: `plugins/agent-claude`, `cli/src/adapters/types.ts`; envs-collab: `packages/mola-plugin-api/src/…` | core's layout: `cli/packages/plugins/<pkg>`, all interfaces in `@mola/plugin-sdk` | One pnpm workspace, one interface source of truth; section paths were sketches |
| 4 | Codex hook trust flag | core-plugins §3: "mola never passes `--dangerously-bypass-hook-trust`; trusted hooks only" | ADR-0004 §3: add the flag for mola-created `CODEX_HOME` overlays | Never pass it. Codex bridge = trusted `CODEX_HOME` overlay once the user has trusted it, else stream-bridge fallback | Trust gate is a safety control; bypassing it contradicts BRIEF #7's spirit for zero gain (stream bridge exists) |
| 5 | Config/policy format | core-plugins §2.4: JSONC everywhere, "no YAML footguns" | ADR-0003 §2: `~/.mola/policy.yml` YAML | Policy is JSONC: `~/.mola/policy.jsonc` + optional `.mola/policy.jsonc` merged under it | One parser, one schema validator, consistent with config layering |
| 6 | Project-local writes | core-plugins §2.5: "mola does not write to `.mstack/`" | ADR-0004 §2 + adapters-routing §4: persist `events.jsonl`, `decision.json` under `.mstack/runs/` | Mola owns `.mstack/runs/` (gitignored) for per-run events/decisions; skills keep the rest of `.mstack/`; global history stays in `~/.mola/state.*` | Replayable per-run artifacts are the hook-bus contract; "no .mstack writes" was meant for skill state |
| 7 | dsh profile name | core-plugins §2.5/§8.2 and envs-collab §2.1: `dsh --profile headless` | adapters-routing §2.10 + tasks/dispatch.sh: `dsh --profile mola-cli` | `mola-cli` is the dispatch profile (matching the tested flow); `--session-id` is the resume flag regardless of profile | Evidence beats prose: tasks/dispatch.sh and harness-commands.md both use mola-cli |
| 8 | B1 adapter scope | adapters-routing §1.3 example manifest tags `agent-claude` `"batches": ["B1"]` | core-plugins §9: B1 ships only agent-dsh + tool-magpie + policy plugins | B1 = dsh only; claude/codex/… adapters are B2 (directive from the synthesizer brief) | B1 must land fast on a flow that works today (DSH headless); more adapters add review surface, not value |
| 9 | B1 dispatch command | core-plugins §8.1/§9: `mola run "<task>"` in B1 | Synthesizer directive: B1 ships `mola dispatch` + `mola model` + `mola rtk` | B1 ships `mola dispatch` (thin wrapper over tasks/dispatch.sh), `mola model`, `mola rtk`; the general `mola run` router debuts B2 | Directive; `run` needs the full scoring engine, `dispatch` does not |
| 10 | NATS connection owner | envs-collab §4.1: TS plugins *may* connect directly to NATS (one holder per machine) | ADR-0001: long-running network belongs to the Rust sidecar | `mola-syncd` is the only connection holder in v1; TS talks JSON-RPC to it. Direct TS connect stays possible behind the `SyncBackend` interface for later | Avoids dual-connection state drift now; the escape hatch is preserved without code changes |
| 11 | Secret backend | envs-collab §6.3: secrets live in mola-env (chezmoi + age), decided | core-plugins §2.4/§10: mola stays agnostic (magpie / OS keychain), open question | Core stays agnostic; envs' `$ref:secret/<name>` is a resolution *interface* the daemon fulfils by shelling out to whichever backend the user runs (chezmoi+age today) | BRIEF #7 requires secrets never leave the machine/vault — which backend is not mola's call to hard-code |
| 12 | Handler failure semantics | ADR-0004 §2: "a throwing handler is logged, never breaks the agent" | core-plugins §3: waterfall listeners may reject (policy denial) | Split by class: broadcast handlers are isolated and never break anything; waterfall (gate) handlers may rewrite/reject and their rejection is the denial path | Both behaviors are needed; the conflict was only in unstated scoping |
| 13 | Attach command name | core-plugins §8.1: `mola tasks list|attach <id>` (sidecar PTY) | envs-collab §2.2: `mola sessions` + `mola sessions attach --id` (+ `mola session handoff`) | `mola sessions list|attach|handoff` for live agent/terminal sessions; `mola task …` is the collaboration task table only; PTY attach is an implementation detail of `sessions attach` | Sessions are what a human attaches to; tasks are work items — mixing them confused two registries |
| 14 | State store engine | core-plugins §2.5: SQLite via `node:sqlite` | core-plugins §10: JSON fallback may need to be B1 default | B1 = `~/.mola/state.json` (JSON store), B2 = SQLite, same `StateStore` interface | Removes the Node-22-minor `node:sqlite` flag risk from the fast B1; interface hides the swap |
| 15 | BRIEF #3 correction — route whitelist in policy | ADR-0003 §2 example: `review` route `auto/claude-sonnet-5-5` | adapters-routing §3.4: "router must not emit a route outside an agent's visible set" (magpie-routes.txt) | `mola doctor` validates every policy route against `magpie groups`/`magpie models` + the agent's visible set at boot; unknown route ⇒ doctor warning, dispatch ⇒ 66 | ADR-0003 already flagged the drift risk; making it a checked invariant closes it (BRIEF #3: magpie owns routes) |
