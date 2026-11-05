# Core + Plugin System (`mola`)

Scope: the TS core (plugin loader, command router, event/hook bus, config, state,
logging), the plugin manifest and lifecycle, sandboxing, the TS↔Rust boundary, CLI UX
conventions, and the testing strategy. Decisions with alternatives are in
[ADR-0001](../adr/0001-ts-rust-boundary.md) (TS↔Rust boundary) and
[ADR-0002](../adr/0002-plugin-manifest-and-loading.md) (manifest & loading).
Routing policy, adapter catalogs and the sync backend choice belong to the other two
sections; this file defines the surfaces they plug into.

## 1. Repo layout inside mstack

`mola` lives in the mstack repo next to the skills it coordinates (BRIEF constraint:
"ships inside the mstack repo … packaged together with the mstack skills"). The repo
gains two workspaces; nothing under `skills/`, `.claude-plugin/`, `docs/` changes.

```text
mstack/
├─ cli/                          # NEW — pnpm workspace (Node ≥22)
│  ├─ pnpm-workspace.yaml
│  ├─ package.json               # private root: scripts, devDeps (typescript, vitest, tsx)
│  ├─ tsconfig.base.json
│  ├─ packages/
│  │  ├─ mola/                   # the bin: `mola` — arg parsing → @mola/core boot. Thin.
│  │  ├─ core/                   # @mola/core: loader, router, bus, config, state, logging
│  │  ├─ plugin-sdk/             # @mola/plugin-sdk: Plugin/PluginContext types + definePlugin()
│  │  ├─ rpc/                    # @mola/rpc: JSON-RPC 2.0 NDJSON client/server for sidecars
│  │  └─ plugins/                # first-party plugins, one package each:
│  │     ├─ cmd-doctor/          #   kind: command — `mola doctor`
│  │     ├─ cmd-config/          #   kind: command — `mola config …`
│  │     ├─ cmd-plugin/          #   kind: command — `mola plugin …`
│  │     ├─ agent-claude/        #   kind: agent   — wraps `claude` (see inputs/claude-help.txt)
│  │     ├─ agent-dsh/           #   kind: agent   — wraps `dsh --profile …` (inputs/dsh-cli-help.md)
│  │     ├─ agent-codex/         #   kind: agent   — wraps `codex exec` (inputs/codex-help.txt)
│  │     ├─ tool-magpie/         #   kind: tool    — wraps `magpie ls|agents|quota …`
│  │     ├─ tool-git-gh/         #   kind: tool    — worktrees, PRs (inputs/gh-help.txt)
│  │     ├─ env-local/           #   kind: env     — this machine (Windows / WSL detection)
│  │     ├─ policy-approval/     #   kind: policy  — approval gate (BRIEF constraint 7)
│  │     └─ …                    #   remaining adapters are the adapters-routing section's list
│  └─ design/                    # this design (already exists)
├─ crates/                       # NEW — cargo workspace
│  ├─ Cargo.toml                 # [workspace] members below
│  ├─ mola-proto/                # serde types = protocol source of truth; JSON Schema gen
│  ├─ mola-ptyd/                 # PTY/process supervisor sidecar (portable-pty; ConPTY on Win)
│  ├─ mola-syncd/                # sync daemon sidecar (backend per envs-collab section)
│  └─ mola-layerfs/              # thin adapter crate over the existing LayerFS library
├─ skills/                       # unchanged — the "how to work" (16 m-* skills)
└─ .claude-plugin/               # unchanged — Claude Code plugin manifest for the skills
```

**Why this split.** `packages/mola` depends only on `@mola/core` + the first-party
plugin packages, so the published tarball contains zero Rust source and zero skills
content. `crates/` is a cargo workspace because the sidecars share `mola-proto` and are
released together on one version. The skills stay a *separate* artifact (a Claude Code
plugin, installed today via `claude plugin marketplace add Mola-maker/mstack`) because
they evolve on skill-time, not CLI-time, and are consumed by three different harnesses
(Claude Code, DSH `~/.dsh/skills`, Codex `~/.codex/skills` — FRAMEWORK.md §1).

**Packaging and install story (one install, two artifacts):**

1. `npm i -g mola` (or `pnpm add -g mola`) installs the CLI. Per-OS/arch Rust sidecars
   come in through `optionalDependencies` platform packages
   (`@mola/ptyd-linux-x64-gnu`, …) — the esbuild/biome distribution pattern
   ([ADR-0001](../adr/0001-ts-rust-boundary.md),
   [pattern reference](https://thekevinscott.github.io/putitoutthere/guide/npm-platform-packages)).
   Consumers need Node ≥22 and nothing else; no Rust toolchain, no postinstall compile
   (the postinstall-build failure mode is documented in the wild, e.g.
   [pdf_oxide#335](https://github.com/yfedoseev/pdf_oxide/issues/335)).
2. Skills install: the mstack repo remains the Claude Code plugin it already is
   (`.claude-plugin/plugin.json`, name `mstack`, version 0.3.1). `mola` adds a thin
   convenience — `mola skills install [--claude|--dsh|--codex]` — that copies/symlinks
   `skills/*/SKILL.md` into `~/.dsh/skills` and `~/.codex/skills` and prints the one
   `claude plugin marketplace add` line, instead of re-implementing those installs.
   `mola doctor` verifies both artifacts are present and reports skill/skill-name
   collisions (the FRAMEWORK.md §10 lesson: a skill named like the plugin loses its
   description — mola does not ship any skill of its own, so it can only *detect*).
3. Release: one CI workflow builds `crates/*` per target → publishes `@mola/*-{os}-{arch}`
   packages → publishes `mola` → tags the repo; the skills plugin is released by the
   existing repo flow (version in `.claude-plugin/plugin.json`). The mola version and
   the skills version are independent; `mola doctor` prints both and the compatibility
   floor ("skills ≥ 0.3.1 recommended").

## 2. Core runtime architecture

The core is the only non-plugin code, per BRIEF constraint 2. It owns exactly six
things: **plugin loader, command router, event/hook bus, config layering, state store,
logging/tracing**. Everything user-visible — every command, every adapter — is a plugin
registered into these services.

### 2.1 Boot sequence

```text
1. mola bin: parse global flags only (--json, -v/--verbose, -q, --config, --cwd, --no-color)
2. core.boot():
   a. load config layers (§2.4)                       → ConfigView
   b. open state store (§2.5)                         → StateStore
   c. init logging (§2.6) with trace id               → Logger
   d. resolve+validate+plan plugins (ADR-0002)        → LoadPlan
   e. activate in topo order; failures quarantine, boot continues (degraded, logged)
3. router.dispatch(argv): find command → run plugin handler → format output
4. shutdown: emit `core/shutdown`, deactivate in reverse order, flush logs
```

Boot never hard-fails because one plugin is broken: the failed plugin is quarantined,
its commands get a stub that explains the failure and suggests `mola plugin doctor`,
and exit code reflects the command's own result. Only a failure in steps a–c is fatal
(exit 70).

### 2.2 Plugin loader

Implements ADR-0002: resolve (builtin → `~/.mola/plugins` → project `.mola/config.jsonc`),
validate against the manifest JSON Schema, plan (topo sort over `provides`/`requires`,
`conflicts` check, permission diff), activate with a `PluginContext`.

```ts
// cli/packages/plugin-sdk/src/index.ts
import type { JSONSchema } from './json-schema.js';

export interface Plugin {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;   // optional; ctx.dispose covers most cases
}

export interface PluginContext {
  readonly id: string;                   // manifest id
  readonly manifest: PluginManifest;     // validated, frozen
  readonly log: Logger;                  // child logger, {plugin: id, trace}
  readonly events: EventBus;             // §2.3
  readonly commands: CommandRegistry;    // §2.3 router side
  readonly config: ConfigView;           // §2.4 (read-only; writes need config.write permission)
  readonly state: StateNamespace;        // §2.5, per-plugin KV
  readonly permissions: PermissionSet;   // granted subset of manifest.permissions
  readonly process: ExecService;         // permission-checked spawn (allow-listed argv[0])
  readonly fs: FsService;                // permission-checked fs (glob allow-list)
  readonly sidecars: SidecarService;     // spawn/supervise Rust sidecars (ADR-0001)
  dispose(fn: () => void | Promise<void>): void;   // reversible effect, Cordis-style
}

export function definePlugin(p: Plugin): Plugin { return p; }
```

Every registration made through `ctx` (command, listener, timer, child process) is
pushed onto a dispose stack; `deactivate` unwinds it. This is lifted directly from the
Cordis effect model that DSH documents ("registrations are effects that unwind when
their plugin unloads", inputs/dsh-architecture.md) — proven shape, no invention.

### 2.3 Command router

- Commands are **namespaced paths** registered by plugins: `plugin install` from
  `cmd-plugin`, `agents list` from the discovery plugin, `run` from the routing plugin.
  The router resolves `argv` to the longest registered path, so plugins can extend a
  namespace (`mola agents explain <id>` later) without touching core.
- Aliases are config (`aliases:` in config), not code, so users can shadow without
  forking plugins.
- Two commands with the same path = plan-time conflict error (exit 65) unless one is
  `builtin` and the other declares `overrides: ["mola.cmd.agents.list"]` — explicit,
  visible in `mola plugin list`.
- Every handler receives `(args, io)` where `io.out`/`io.err` respect global `--json`,
  and returns an `ExitCode` (table in §8). Handlers never call `process.exit`.

```ts
export interface Command {
  path: string[];                       // ['plugin','install']
  description: string;                  // one line, for `mola --help`
  args?: JSONSchema;                    // positional/flag schema → validation + help + --json errors
  handler(args: Record<string, unknown>, io: Io): Promise<ExitCode>;
}
```

### 2.4 Config layering

Five layers, deep-merged, later wins (scalars, arrays, and objects; `null` deletes):

```text
builtin defaults
  < global  ~/.mola/config.jsonc        (user-level; chezmoi mola-env may render it per
  < project .mola/config.jsonc           machine — inputs/05-knowledge-and-config.md §4)
  < env     MOLA_* (MOLA_LOG_LEVEL, MOLA_STATE_DIR, MOLA_NO_COLOR, …)
  < flags   --config <path> (whole extra file), --json/-v/-q
```

- Format: JSONC everywhere (comments allowed, schema-validated, no YAML footguns).
  Machine-specific values (paths on Windows vs WSL, Tailscale peer names) belong in the
  global file rendered by chezmoi from the `mola-env` repo proposed in
  inputs/05-knowledge-and-config.md §4 — mola reads the result, it does not do
  templating itself.
- `ConfigView` is read-only + `onChange` (fs watch on the two files, debounced, emits
  `config/changed`). Writes go through `mola config set` (the `cmd-config` plugin), which
  validates against the union of all plugins' `configSchema`s before persisting to the
  global file. Unknown keys are kept but surfaced by `mola doctor` as warnings.
- Secrets are never config: `configSchema` marks secret-shaped fields, `mola config set`
  refuses them, and plugins reach provider keys only through magpie
  (`magpie settings|provider …`, inputs/magpie-help.txt) or the OS keychain/password
  manager (constraint 7; open question on chezmoi+age vs Bitwarden is recorded in
  inputs/mola-infra-open-questions.md — mola stays agnostic and shells out).

### 2.5 State store

- **Location:** `~/.mola/state.db` (SQLite via Node's built-in `node:sqlite`
  `DatabaseSync` — zero native deps; note it is still experimental-flagged on some
  Node 22 minors, so the store sits behind a `StateStore` interface with a JSON-file
  fallback implementation selected automatically). Cache that can be rebuilt
  (agent discovery results, `magpie ls` output, route snapshots) lives in
  `~/.mola/cache/*.json` with TTLs, *not* in the DB — deleting cache must never lose
  anything.
- **Contents:** run history (one row per command invocation: trace id, argv, exit code,
  duration), plugin registry + granted-permission snapshots, sidecar adoption records
  (PID, protocol version), task/session handles the routing section needs
  (`dsh --profile headless --session-id <id>` ids, worktree paths), and per-plugin KV
  namespaces (`ctx.state` → `kv_<plugin-id>` table, no schema needed).
- `.mstack/` stays the skills' project-state directory (FRAMEWORK.md §4). Mola does not
  write there; skills do. Mola's own project-scoped state (e.g. "this repo's preferred
  dispatch profile") lives in `.mola/state.json` only if the adapters-routing section
  asks for it — otherwise nothing project-local in B1.

### 2.6 Logging / tracing

- **Logger:** pino, JSON lines to `~/.mola/logs/mola.log` (rotated by size, 5×10 MB),
  level from `MOLA_LOG_LEVEL`/`-v` (info default, `-v` debug, `-vv` trace). Human output
  goes to stdout/stderr only; the log file is never the console.
- **Trace id:** every command invocation mints one (`traceId`), logs carry it, and it is
  exported to children as `MOLA_TRACE_ID` so DSH headless workers, sidecars, and hook
  bridges can correlate. Run history (§2.5) is keyed by it.
- **Diagnostics:** `mola doctor --json` is the machine-readable health report; its
  human form prints the same checks. This is the B1 acceptance command.

## 3. Event/hook bus

BRIEF constraint 5: hooks are first-class. The bus has three delivery semantics, borrowed
from the domains DSH separates (inputs/dsh-architecture.md, "Events"): **broadcast**
(facts, fire-and-forget, logged), **waterfall** (interceptors; each listener must call
`next(value)` and may rewrite or reject — used for policy gates), and **serial**
(ordered observers that must not interleave, e.g. shutdown).

```ts
export interface EventBus {
  emit(event: string, payload: unknown): void;                       // broadcast
  on(event: string, fn: Listener): Disposer;                         // broadcast
  hook(event: string, fn: WaterfallFn): Disposer;                    // waterfall participant
  runWaterfall<T>(event: string, value: T): Promise<T>;              // throws PolicyDenial on reject
  onSerial(event: string, fn: Listener): Disposer;
}
```

**Core event vocabulary (v1):**

| Event | Semantics | Payload sketch | Producers |
|---|---|---|---|
| `core/boot`, `core/shutdown` | serial | `{plugins, degraded[]}` | core |
| `command/start`, `command/end` | broadcast | `{traceId, path, argv}` / `{exitCode, durationMs}` | router |
| `plugin/activated`, `plugin/quarantined` | broadcast | `{id, version}` / `{id, error}` | loader |
| `config/changed` | broadcast | `{layer, keys[]}` | config |
| `task/pre-dispatch` | **waterfall** | `{task, candidates[], policy}` → may rewrite/deny | routing plugin emits; policy plugins hook |
| `tool/pre-run`, `tool/post-run` | **waterfall** / broadcast | `{tool, argv, cwd}` → may rewrite/deny (this is the constraint-7 approval gate) | adapters emit; `policy-approval` hooks |
| `agent/run-started`, `agent/run-finished` | broadcast | `{agent, sessionRef, traceId}` | agent adapters |
| `hook/native` | broadcast | `{source: 'claude-code'|'codex'|'omc'|'dsh', name, data}` | hook bridge adapters |
| `sidecar/crash`, `sidecar/respawned` | broadcast | `{name, exitCode}` | sidecar service |

**Native hook bridges** (adapters section owns these; the bus contract is theirs to
consume): Claude Code exposes hook lifecycle over `--output-format=stream-json
--include-hook-events` (inputs/claude-help.txt:117) — an adapter parses that stream and
re-emits as `hook/native` + mapped `tool/*` events. DSH headless `--json` emits
newline-delimited run events (inputs/dsh-cli-help.md:115) — same treatment. Codex has
hooks with a trust gate (`--dangerously-bypass-hook-trust`, inputs/codex-help.txt:101 —
mola never passes that flag; trusted hooks only). rtk already hooks Gemini/Copilot CLI
(`rtk hook`, inputs/rtk-help.txt:98) — mola integrates by configuration, not by wrapping
rtk's rewrite layer.

**Death-loop brake (core feature, from the mstack guard rule):** if the same listener
throws or the same waterfall rejects 3 consecutive times for the same event+plugin, the
plugin is quarantined and `plugin/quarantined` is emitted. No fourth attempt.

## 4. Plugin manifest

Format and full rationale: [ADR-0002](../adr/0002-plugin-manifest-and-loading.md). One
`mola-plugin.json` per plugin, `kind ∈ agent|tool|env|sync|command|policy`, declared
`capabilities`, `permissions`, `provides`/`requires`, `conflicts`, and `entry` as either
`{ts: "./dist/index.js"}` or `{bin: "./bin/x", protocol: "jsonrpc-stdio"}`. A JSON
Schema (`cli/packages/plugin-sdk/manifest.schema.json`) is the contract; `mola plugin
validate <dir>` checks a checkout without installing.

Kind semantics (what the core does differently per kind):

| kind | Activation contract |
|---|---|
| `command` | Registers one or more commands; no other special handling. |
| `agent` | Registers an `AgentAdapter` (`detect()`, `run()`, `resume()`, `streamEvents()`) into the routing registry. Must declare `agent.*` capabilities. |
| `tool` | Registers a `ToolAdapter` (health probe + wrapped operations). `tool/pre-run` waterfall applies to every op. |
| `env` | Describes a machine/peer (local, WSL, Tailscale node, cloud VM) and how to reach it; consumed by routing and dispatch. |
| `sync` | Provides the sync/event backend (sidecar per ADR-0001; backend choice is the envs-collab ADR). |
| `policy` | Hooks `tool/pre-run` and `task/pre-dispatch`; may deny (→ exit 77) or require `--yes`. |

## 5. Discovery, install, update

**Discovery (what plugins exist):** the three sources of ADR-0002 §2, plus *capability
discovery* which is a runtime, not install-time, property — `mola doctor` re-probes:
agent adapters run their `detect()` (on PATH? version? configured in magpie per
`magpie ls` / `magpie agents`, inputs/magpie-*.txt), env adapters ping peers, tool
adapters probe (`magpie healthcheck` exits 0 when the gateway answers,
inputs/magpie-help.txt:83). Detection results go to the cache with TTL, never to config.

**Install (`mola plugin install <spec>`):**

1. `<spec>` is an npm spec (`name[@range]`), a git URL, or a local path.
2. Resolve and fetch with **pnpm, forwarded verbatim** into `~/.mola/plugins/` — the
   exact model `dsh plugin` uses ("manage a profile's plugins by forwarding the
   remaining arguments to pnpm", inputs/dsh-cli-help.md:62-80). No new package manager.
3. Read and validate `mola-plugin.json`; run the load plan against the active set
   (conflicts, missing providers, `mola` API range).
4. Print the **permission diff** (new install: full set; update: added/removed) and
   require confirmation; `--yes` skips it *if* policy allows (a policy plugin may forbid
   unattended grants for `process.exec` or `env.read`). Record the granted snapshot +
   tarball SHA-512 in `~/.mola/plugins.json`.
5. Activate on next boot (or immediately with `--now`; activation failure quarantines,
   doesn't roll back the files).

**Update (`mola plugin update [id|--all]`):** re-resolve within the recorded semver
range (or bump the range with `--latest`), re-run steps 3–5. The permission diff step is
mandatory on update — a plugin that suddenly wants `process.exec: ["*"]` must be a
visible event. `mola plugin list --json` shows id, version, tier, enabled, granted
permissions, and quarantine state. `enable`/`disable` flip a flag in `plugins.json`;
they never delete files. `remove` deletes files + registry entry and runs `deactivate`
first.

**Trust tiers:** `builtin` (in-process, ships with mola) / `verified` (registry + hash,
in-process if permissions fit the approved profile) / `untrusted` (worker-isolated).
Details and honesty caveats in ADR-0002 §3 — the short version: Node cannot truly
sandbox in-process JS, so the *install-time gate* is the security boundary and the
runtime permission checks are the audit/accident boundary.

## 6. Sandboxing and permission model (runtime view)

```ts
export type PermissionSet = {
  'process.exec'?: string[];      // argv[0] allow-list, e.g. ["claude","dsh","gh"]
  'fs.read'?: string[];  'fs.write'?: string[];   // glob allow-lists
  'net.connect'?: string[];       // host[:port] globs
  'env.read'?: string[];          // name globs, e.g. ["MOLA_*","ANTHROPIC_*"]
  'mola'?: MolaCapability[];      // 'events','config.read','config.write','state.kv',…
};
```

- Enforcement point: the `ctx.process`, `ctx.fs`, `ctx.config`, `ctx.state` handles —
  every call checks the granted set, logs the check at debug level, and emits
  `policy/violation` (broadcast) on denial. Denials throw `PermissionError`, which the
  router maps to exit 77.
- Worker isolation for `untrusted` plugins: plugin runs in a `node:worker_threads`
  worker with `--experimental-permission`-style restrictions where the Node version
  supports them; all mola services cross the bridge as RPC. Documented limitation
  (ADR-0002 §3): determined malicious code is out of scope; the gate is install-time.
- Rust sidecar plugins are process-isolated by construction and additionally get the
  *narrowest* OS environment the host can arrange (no inherited secrets in env;
  explicit allow-list only).
- The approval policy (constraint 7: push/merge/publish/delete/payments/messages need
  explicit approval) is implemented as a **policy plugin** hooking `tool/pre-run` with a
  classifier over argv (e.g. `git push`, `gh pr merge`, `npm publish`) — not hard-coded
  in core, because the list evolves; but the *gate mechanics* (deny → exit 77, `--yes`
  flag, `MOLA_YES=1` for CI) are core. B1 ships `policy-approval` as builtin with a
  conservative default list.

## 7. TS↔Rust boundary (summary)

Per [ADR-0001](../adr/0001-ts-rust-boundary.md): **sidecar binaries over JSON-RPC 2.0 /
NDJSON stdio**, never in-process napi-rs for the daemon-shaped work. Core exposes
`ctx.sidecars`:

```ts
export interface SidecarService {
  ensure(name: 'ptyd' | 'syncd' | string): Promise<SidecarHandle>; // resolve, spawn or adopt, hello
  call<T>(h: SidecarHandle, method: string, params?: unknown): Promise<T>;
  notify(h: SidecarHandle, method: string, params?: unknown): void;
  events(h: SidecarHandle): AsyncIterable<JsonRpcNotification>;      // streams → bus
}
```

Sidecar stdout notifications are re-emitted onto the bus (`sidecar/<name>/<method>`),
so TS plugins subscribe to PTY output or sync progress without knowing the transport.
Protocol types come from `crates/mola-proto` → generated JSON Schemas → generated TS
types; both sides run the same fixture suite (§9).

## 8. CLI UX

### 8.1 Command tree (core-owned surface; adapters-routing adds its own under the same rules)

```text
mola <command> [args] [global flags]

Global flags (every command): --json  -v/--verbose (repeatable)  -q/--quiet
                              --config <path>  --cwd <dir>  --no-color  --yes

Core/builtin commands (B1):
  mola doctor [--fix]                health: node, sidecars, plugins, magpie, agents, skills
  mola agents list [--json]          discovered agents (PATH probe + `magpie ls`/`magpie agents`)
  mola agents show <id>              one agent: binary, version, magpie model route, config file
  mola plugin list [--json]          installed plugins: id, version, kind, tier, state
  mola plugin install <spec> [--yes] install third-party plugin (§5)
  mola plugin update [id|--all]      update within recorded semver range
  mola plugin remove <id>            deactivate + delete
  mola plugin enable|disable <id>
  mola plugin validate <dir>         check a checkout's mola-plugin.json
  mola plugin doctor                 resolve→plan without activating (conflicts, API ranges)
  mola config list|get <key>|set <key> <value>|edit|path
  mola hooks list [--json]           active bus listeners + which plugin owns each
  mola runs list|show <traceId>      run history from the state store
  mola sidecar list|restart <name>   sidecar status from the supervisor
  mola skills install [--claude|--dsh|--codex]   §1 convenience
  mola version                       mola, core, sidecar, and skills versions
  mola completions <shell>           bash/zsh/fish

Routing/dispatch commands (owned by the adapters-routing section, shown for shape):
  mola run "<task>" [--agent …] [--on <env>] [--route group/smart-split] [--json]
  mola tasks list|attach <id>        (attach = sidecar PTY, post-B1)
```

Grounding notes: everything mola *wraps* uses the real CLIs' real flags — DSH dispatch
is `dsh --profile <p> --patch <overlay> "<task>"` with `--json`, `--session-id`,
`--permission-mode`, `--add-dir` (inputs/dsh-cli-help.md; the tested incantation lives
in `skills/m-dispatch/references/harness-commands.md`); model routes come from
`magpie ls` / `magpie groups` and are passed through, never edited into agent configs
(constraint 3); Codex is `codex exec "<task>"`; Claude Code headless is
`claude --print --output-format=stream-json` (inputs/claude-help.txt). Where a needed
flag does not exist in an input, the adapter section must say so — e.g. `magpie ls` has
no `--json` flag in the captured help (`magpie accounts|sessions|quota|settings` do);
the smallest workaround is parsing its stable table output with a golden-fixture test,
and filing the gap in the open-questions list rather than inventing `magpie ls --json`.

### 8.2 `--json` everywhere

- Every command accepts `--json`. Success output is one JSON document on **stdout**;
  diagnostics, progress, and warnings stay on **stderr** regardless of mode.
- Envelope: `{ "schemaVersion": 1, "command": "agents list", "traceId": "…", "data": … }`.
  Streaming commands (`run`, `tasks attach`) emit NDJSON events instead, matching the
  convention DSH headless already uses (`--json` → "newline-delimited run events",
  inputs/dsh-cli-help.md:115).
- Errors in `--json` mode: stdout stays clean; stderr gets
  `{ "schemaVersion": 1, "error": { "code": "POLICY_DENIED", "message": "…", "details": … } }`;
  the exit code carries the semantics (below). `code` is from a small registry in
  `@mola/core/errors` — agents consuming mola parse `code`, never `message`.
- Schemas are versioned per command (`mola <cmd> --json-schema` prints it) and golden-
  tested (§9), because the primary consumers of `--json` are other agents.

### 8.3 Exit codes

Aligned with `sysexits.h` so scripts and agents get standard semantics:

| code | name | meaning |
|---|---|---|
| 0 | OK | success |
| 1 | ERROR | unspecified failure (avoid; prefer a specific code) |
| 64 | EX_USAGE | bad args, unknown command, flag conflict |
| 65 | EX_DATAERR | invalid input data: bad manifest, bad config, `--json` input unparseable |
| 66 | EX_NOINPUT | required config/credential/file missing (e.g. no route configured) |
| 69 | EX_UNAVAILABLE | upstream unavailable: magpie gateway down, agent not found, sidecar handshake failed, peer offline |
| 70 | EX_SOFTWARE | internal error / plugin crash / boot failure |
| 77 | EX_NOPERM | policy denied or approval required (use `--yes` or relax policy); permission violation |

Quarantined-plugin stubs exit 70 with a pointer to `mola plugin doctor`. `doctor`
itself exits 0 only if all checks pass; failing checks map individually (missing
sidecar → 69, bad manifest → 65), and `--json` reports per-check codes so CI can branch.

## 9. Testing strategy

| Layer | Tooling | What it proves |
|---|---|---|
| Unit (TS) | vitest in each `cli/packages/*` | router resolution, config merge order, permission checks, dispose-stack unwinding, death-loop brake |
| Manifest contract | JSON Schema + fixtures in `plugin-sdk` | every first-party manifest validates; invalid fixtures fail with the documented exit 65 path |
| Protocol contract (TS↔Rust) | JSON fixtures in `crates/mola-proto/tests/fixtures/`, consumed by **both** `cargo test` and a vitest suite in `@mola/rpc` | one source of truth; a protocol drift fails both builds |
| Sidecar integration | cargo tests spawn `mola-ptyd` and speak NDJSON; vitest spawns the same binary | handshake, version mismatch → 69, crash → respawn ≤3 → stop |
| Plugin API contract | a `@mola/plugin-sdk` "conformance" harness that loads a mock plugin through the real loader | activate/deactivate reversibility, permission denials, quarantine on throw |
| Golden CLI output | fixture PATH/HOME, run `node bin/mola.js <cmd> --json`, snapshot | `--json` envelope stability, exit codes, stderr cleanliness |
| Live integration (opt-in) | env-gated (`MOLA_TEST_LIVE=1`): real `magpie ls`, real `dsh --profile headless --json "say ok"` on the magpie `group/smart-split` route, real `gh auth status` | the B1 acceptance criteria are executable, not aspirational |
| On-machine acceptance | `mola doctor --json` | the same checks users run; CI runs it in a container with fixtures |

Rules carried over from mstack (FRAMEWORK.md §4): no claim of "works" without the
command output; the writer of a module does not write its acceptance test alone —
conformance suites and golden outputs are reviewed by a different agent; live tests
always go through magpie routes (`group/*`/`auto/*`), never `deepseek/*` direct (the
402 lesson in `skills/m-dispatch/references/harness-commands.md`).

**B1 slice of all this** (for BATCHES.md): pnpm workspace + `mola` bin + core boot +
loader/router/bus/config/state/logging + builtin plugins `cmd-doctor`, `cmd-config`,
`cmd-plugin` (list only), `agent-dsh` (run via DSH headless), `tool-magpie` (agents
list), `policy-approval` — acceptance: `mola doctor --json` exits 0 on a machine with
magpie + dsh, `mola agents list --json` shows the magpie-detected set, and
`mola run "…"` round-trips a DSH headless task on `group/smart-split`. Everything else
in this file is B2+.

## 10. Open questions and gaps found in the inputs

- `magpie ls` / `magpie agents` have no `--json` flag in the captured help (several
  other magpie commands do). Workaround: parse table output + golden test; gap recorded.
- The exact shape of `mola sync` config depends on the envs-collab section's backend
  choice; core only reserves the `sync` kind and the `mola-syncd` sidecar slot.
- Secret backend (chezmoi+age vs password manager) is unresolved
  (inputs/mola-infra-open-questions.md); core's `env.read` permission and
  secret-refusal in `config set` are designed to be correct under either answer.
- Whether project-local `.mola/state.json` is needed at all — deferred to the
  adapters-routing section; core provides the `StateStore` interface either way.
- `node:sqlite` stability across the Node 22 line: if the flag situation is messy on
  the oldest supported minor, the JSON-file fallback becomes the default for B1 and
  SQLite flips on in B2. Decision recorded here so it is not re-litigated per PR.

## Sources

- napi-rs distribution & compatibility: <https://napi.rs/docs/deep-dive/release>, <https://napi.rs/docs/more/support-compatibility>, <https://github.com/napi-rs/napi-rs/>
- Platform-package distribution pattern (esbuild/swc/biome/turbo): <https://thekevinscott.github.io/putitoutthere/guide/npm-platform-packages>, <https://deepwiki.com/biomejs/biome/2.3-distribution-and-packaging>, <https://engineered.at/articles/packaging-rust-applications-for-the-npm-registry>
- oxc napi bindings distribution: <https://deepwiki.com/oxc-project/oxc/11-node.js-integration-(napi)>
- Repo inputs: `cli/design/BRIEF.md`, `FRAMEWORK.md`, `cli/design/inputs/{dsh-architecture.md,dsh-cli-help.md,magpie-help.txt,magpie-agents.txt,magpie-routes.txt,claude-help.txt,codex-help.txt,rtk-help.txt,01-topology.md,05-knowledge-and-config.md,mola-infra-open-questions.md}`, `skills/m-dispatch/references/harness-commands.md`, `.claude-plugin/plugin.json`
