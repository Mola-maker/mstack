# Section: Agent + Tool Adapters and the Routing Layer

Scope: the `AgentAdapter` / `ToolAdapter` plugin contracts, the concrete mapping of every agent and
tool on this machine (grounded in `cli/design/inputs/*-help.txt` — no invented flags), the routing
policy, the `mola` command → skill → adapter map, and the unified hook bus. Routing policy detail is
in [ADR-0003](../adr/0003-routing-policy.md); hook bus detail is in [ADR-0004](../adr/0004-hook-bus.md).

Hard constraints honored here (from BRIEF.md, not reopened):

- Everything below is a **plugin** with a manifest and declared capabilities (constraint 2).
- Model selection always goes **through magpie** (`magpie <agent> <model>`, `group/*` or `auto/*`
  routes), never by editing an agent's config file (constraint 3). This also matches the machine-level
  rule that magpie rewrites drifted agent configs within ~15 s, so direct edits do not survive.
- Adapters **wrap what exists** (constraint 4): an adapter is a thin shell over the real CLI plus,
  where available, magpie.
- Irreversible/outward actions need approval (constraint 7) — enforced in the routing policy's
  `approval` field, surfaced by `mola ship`.

---

## 1. Common interfaces (TypeScript sketches)

### 1.1 AgentAdapter

```ts
// cli/src/adapters/types.ts

/** What an agent CLI can do. Absence means the method must throw UnsupportedCapability. */
interface AgentCapabilities {
  headless: boolean;          // can run one prompt non-interactively and exit
  headlessJsonStream: boolean;// headless mode emits machine-readable NDJSON
  resume: boolean;            // can resume a prior session by id
  continueLatest: boolean;    // can continue "the most recent session for this cwd"
  forkSession: boolean;
  listSessions: boolean;      // native session listing (not via magpie)
  acp: boolean;               // speaks Agent Client Protocol over stdio
  nativeHooks: boolean;       // has a config-injectable hook/notify surface
  backgroundSessions: boolean;// can detach sessions we can re-attach to
  worktree: boolean;          // has a native git-worktree flag
  costReadout: 'native' | 'magpie' | 'none';
}

interface AgentInfo {
  id: string;                 // 'claude' | 'codex' | 'kimi' | 'grok' | 'agy' | 'devin'
                              // | 'pi' | 'opencode' | 'omp' | 'dsh' | 'orca'
  bin: string;                // resolved executable path
  version: string;            // from the agent's --version
  machine: string;            // tailscale hostname or 'local' / 'wsl:Ubuntu'
  capabilities: AgentCapabilities;
  managedByMagpie: boolean;   // appears in `magpie ls`
  health: 'ok' | 'degraded' | 'broken';
  healthNote?: string;        // e.g. omp: "Bun SyntaxError on startup, see §2.9"
}

interface RunRequest {
  prompt: string;
  cwd: string;
  modelRoute?: string;        // magpie route id, e.g. 'group/smart-split' — see ADR-0003
  permissionProfile?: 'read-only' | 'workspace-write' | 'full-auto' | 'plan';
  addDirs?: string[];
  budgetUsd?: number;         // mapped per agent; unsupported ⇒ router must enforce externally
  timeoutMs?: number;
  sessionId?: string;         // resume target
  fork?: boolean;
  env?: Record<string, string>;
  onEvent?: (e: HookEvent) => void; // stream-bridge events, see ADR-0004
}

interface RunResult {
  sessionId?: string;
  exitCode: number;
  finalText: string;          // final assistant message (or last NDJSON result)
  usage?: Usage;              // tokens/cost when the agent or magpie can report it
  quotaFailure?: QuotaFailure;// normalized 402/rate-limit signal, see ADR-0003 §4
}

interface Usage { inputTokens?: number; outputTokens?: number; costUsd?: number; source: 'agent' | 'magpie'; }
interface QuotaFailure { provider: string; route: string; status: number; retryAfterSec?: number; }

interface AgentAdapter {
  readonly info: AgentInfo;

  /** Probe PATH (and WSL for dsh) for the binary; fill version + capabilities. */
  detect(): Promise<AgentInfo | null>;

  /** One-shot headless run. Implementations use ONLY flags from cli/design/inputs/*-help.txt. */
  runHeadless(req: RunRequest): Promise<RunResult>;

  /** Resume/continue an existing session with a new prompt. */
  resume(sessionId: string | 'latest', req: Omit<RunRequest, 'sessionId'>): Promise<RunResult>;

  /** Native session list; adapters without it throw UnsupportedCapability (use magpie sessions). */
  listSessions(filter?: { cwd?: string; since?: string }): Promise<SessionRef[]>;

  /**
   * Set the agent's model. ALWAYS implemented as `magpie <agent> <route>`; the per-run escape
   * hatch is the agent's own --model flag (used only when magpie lacks the route, and logged).
   */
  setModel(route: string): Promise<void>;

  /** Install shared instructions/skills. Default implementation delegates to magpie library. */
  installSharedContext(kind: 'instructions' | 'skill' | 'mcp', name: string): Promise<void>;

  /** Attach this run's native hooks / output stream to the mola hook bus. See ADR-0004. */
  bridgeHooks(run: RunRequest, bus: HookBus): Promise<HookBridgeHandle>;

  /** Cost/usage for a session or window; grok native, everything else via magpie. */
  usage(scope: { sessionId?: string; window?: 'today' | '7d' | '30d' }): Promise<Usage[]>;
}

interface SessionRef { id: string; title?: string; cwd?: string; updatedAt: string; }
```

### 1.2 ToolAdapter

```ts
interface ToolAdapter {
  readonly id: string;                      // 'git' | 'gh' | 'omc' | 'rtk' | 'magpie' | 'layerfs' | 'docker'
  readonly provides: string[];              // e.g. ['worktree', 'pr', 'review-comments']
  detect(): Promise<ToolInfo | null>;
  call(action: string, args: Record<string, unknown>): Promise<ToolResult>;
}
interface ToolResult { exitCode: number; stdout: string; stderr: string; compactedBy?: 'rtk'; }
```

### 1.3 Plugin manifest (both adapter kinds)

```jsonc
// plugins/agent-claude/mola.plugin.json
{
  "name": "mola-agent-claude",
  "version": "0.1.0",
  "kind": "agent-adapter",              // | "tool-adapter" | "environment" | "sync-backend" | "command"
  "entry": "./dist/index.js",
  "provides": { "agent": "claude" },
  "capabilities": ["headless", "resume", "native-hooks", "worktree", "acp-via-stream"],
  "requires": { "bins": ["claude"], "tools": ["magpie"] },
  "batches": ["B1"]
}
```

---

## 2. Agent adapter mappings

Capability matrix (all rows verified against the help files in `cli/design/inputs/`; "—" = not in
the captured help, do not assume):

| agent | headless | NDJSON stream | resume | list sessions | ACP | native hooks | worktree flag | cost readout |
|---|---|---|---|---|---|---|---|---|
| claude | `-p` | `--output-format stream-json` | `-r <id>` / `-c` | `claude agents` (background only) | — | settings hooks + `--settings` + `--include-hook-events` | `-w/--worktree` | magpie |
| codex | `codex exec` | — (not captured) | `codex resume [--last]` | `codex agents` | — | `hooks.json` + `notify` | `--worktree` | magpie |
| kimi | `-p` | `--output-format stream-json` | `-S <id>` / `-c` | `kimi session` | `kimi acp` | — | — | magpie |
| grok | `grok agent` / `-p` | `--output-format streaming-json` (ACP NDJSON) | `-r <id\|title>` / `-c` | `grok sessions` | via stream format | plugins (unverified surface) | `-w/--worktree` | **native: `grok usage`** |
| agy | `--print` | `--output-format stream-json` | `--conversation <id>` / `-c` | — | — | plugins (unverified) | — | magpie |
| devin | `-p` | — | `-r <id>` / `-c` | `devin list` | `devin acp` | — | — | magpie |
| pi | `-p` | `--mode json` / `--mode rpc` | `-r` / `-c` / `--session` | — (files in `--session-dir`) | — | extensions (unverified) | — | magpie |
| opencode | `opencode run` | via `opencode serve` API | `-s <id>` / `-c` | `opencode session` | `opencode acp` | plugin event subscribe | — | `opencode stats` + magpie |
| omp | **unknown — binary broken (§2.9)** | — | — | — | — | — | — | magpie |
| dsh | `dsh --profile mola-cli "<task>"` | `--json` | `--session-id <id>` | — | `dsh --profile acp` | **Cordis events (richest)** | via git tool | magpie |
| orca | orchestrator, not an agent (§2.11) | | | | | | | |

ACP note: `kimi acp`, `devin acp`, `opencode acp` and `dsh --profile acp` all serve the Agent Client
Protocol over stdio, and grok's `streaming-json` output is "one ACP session update per line". ACP is
an open JSON-RPC standard for client↔agent interop ([zed.dev/acp](https://zed.dev/acp),
[agentclientprotocol.com](https://github.com/zed-industries/agent-client-protocol/)); the hook bus
uses ACP-shaped messages as the *stream-bridge* canonical form where available (ADR-0004 §3).

### 2.1 claude (Claude Code) — `plugins/agent-claude`

Grounded in `claude-help.txt`.

- **detect**: `claude --version`; cross-check `magpie ls` (machine runs it as `Claude Code`,
  settings `~\.claude\settings.json`, effort xhigh).
- **runHeadless**:
  ```sh
  claude -p "<prompt>" --output-format stream-json --include-partial-messages \
    --permission-mode acceptEdits --max-budget-usd <n> [--add-dir <d>...] [--worktree <name>]
  ```
  `permissionProfile` map: read-only→`--permission-mode plan`+`--tools ""`-style restriction is
  NOT in the help; smallest truthful mapping is plan=read-only-ish, `acceptEdits`=workspace-write,
  and `full-auto`=`bypassPermissions` (router only emits `full-auto` behind an approval gate,
  constraint 7). Budget cap: `--max-budget-usd` (print mode only — exactly our case).
- **resume**: `claude --resume <id> -p "<prompt>"` (`--fork-session` for fork); continue latest:
  `claude -c -p ...`.
- **listSessions**: `claude agents` lists **background** sessions (started with `--bg`); historical
  sessions come from `magpie sessions [--folder <f>] [--json]` (gated by
  `magpie sessions read on claude`). No native "list all sessions" flag exists — say so, don't fake it.
- **setModel**: `magpie claude <route>`; per-run override `--model <alias|name>`.
- **installSharedContext**: `magpie library instructions|skill|mcp ...` (magpie owns `~/.claude`);
  per-run: `--plugin-dir`, `--append-system-prompt`, `--agents <json>`.
- **bridgeHooks**: per-run injection via `--settings <json>` carrying a `hooks` block that POSTs to
  the bus (no config-file mutation — magpie would revert it anyway); plus
  `--include-hook-events` so the stream-json output itself carries hook lifecycle events.
  Claude Code's hook event names (SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd, …) are
  documented at [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) — **verify
  against the installed version at adapter detect time**, they are not in the captured help.
- **background**: `--bg` + `claude attach|logs|stop|rm` give durable sessions the router can
  re-attach to — the cheapest "cloud-collab-ready" agent on this machine.
- **usage**: `magpie usage`, `magpie sessions`.

### 2.2 codex — `plugins/agent-codex`

Grounded in `codex-help.txt`.

- **detect**: `codex --version`; magpie ls shows Codex on `kimi-code-cn/k3`, config `~\.codex\config.toml`.
- **runHeadless**: `codex exec "<prompt>" -m <model> -C <dir> --sandbox workspace-write
  -a never [--worktree] [--add-dir <d>...] [-c key=value]`.
  - `permissionProfile`: read-only→`--sandbox read-only`, workspace-write→`workspace-write`,
    full-auto→`danger-full-access` (approval-gated).
  - **No budget cap flag exists**; budget enforcement falls to the router (kill on magpie-reported
    spend) — declared as a capability gap.
- **resume**: interactive `codex resume [--last]`; fork `codex fork --last`. Headless exec-resume
  flags are **not in the captured help**; workaround: `codex queue <message>` to push a message into
  an existing app-server session, or `codex resume` into a supervised terminal. Verify
  `codex exec --help` at detect time before claiming more.
- **listSessions**: `codex agents` (sessions on the shared app-server daemon); historical spend via
  `magpie sessions`.
- **setModel**: `magpie codex <route>`; per-run `-m`.
- **bridgeHooks**: Codex hooks live in `hooks.json` / `[hooks]` tables with ~12 lifecycle events,
  one JSON payload on stdin carrying `session_id`, `transcript_path`, `cwd`
  ([learn.chatgpt.com/docs/hooks](https://learn.chatgpt.com/docs/hooks),
  [unwait.ai writeup](https://unwait.ai/blog/codex-hooks-config-toml)); legacy single-event `notify`
  also exists. Automation needs `--dangerously-bypass-hook-trust`. Injection pattern (non-invasive):
  a **`CODEX_HOME` overlay directory** containing only our `hooks.json`, as proven by cmux
  ([cmux PR #1482](https://github.com/manaflow-ai/cmux/pull/1482)).
- **usage**: `magpie usage`.

### 2.3 kimi (Kimi Code) — `plugins/agent-kimi`

Grounded in `kimi-help.txt`.

- **runHeadless**: `kimi -p "<prompt>" --output-format stream-json -m <alias> [--auto]
  [--add-dir <d>...] [--skills-dir <dir>] [--agent-file <md>]`.
  - `permissionProfile`: `--yolo` (ask-when-needed) vs `--auto` (never ask); plan mode `--plan`.
- **resume**: `kimi -S <id>`; latest: `kimi -c`; fork: `kimi fork [sessionId]`;
  export: `kimi export [sessionId]` (ZIP — useful for cross-machine handoff per
  `inputs/04-session-resume.md`).
- **listSessions**: `kimi session` (non-interactive session management); `kimi vis` for humans.
- **setModel**: magpie ls manages `Kimi Code` (currently `kimi-code/k3.1-pro`, `~\.kimi-code\config.toml`);
  per-run `-m`; provider-level changes via `kimi provider` are **out of scope** (magpie owns providers).
- **bridgeHooks**: no hook surface in the help ⇒ **stream bridge** over `stream-json`, or full ACP
  via `kimi acp` when the bus wants request/response control.
- **doctor**: `kimi doctor`.

### 2.4 grok (Grok Build) — `plugins/agent-grok`

Grounded in `grok-help.txt`.

- **runHeadless**: `grok agent "<prompt>"` (no TUI) or `grok -p "<prompt>" --output-format
  streaming-json --max-turns <n> --permission-mode acceptEdits [--worktree <name>
  [--worktree-ref <ref>]]`.
  - `permissionProfile`: `plan` / `acceptEdits` / `auto` / `bypassPermissions` (approval-gated).
- **resume**: `grok -r <id|title> -p ...` (title matching is a nice extra: quote multi-word titles);
  latest: `-c`; fork: `--fork-session`; code snapshot restore: `--restore-code` (with `--worktree`
  for remote sessions — directly useful for handoff).
- **listSessions**: `grok sessions`; transcript export: `grok export` (Markdown).
- **setModel**: magpie ls detects `Grok Build` (`~\.grok\config.toml`); per-run `-m`;
  `grok models` lists what's available.
- **usage**: **native** — `grok usage` prints persisted per-session token and cost; the only agent
  with a built-in cost readout. Adapter prefers it and falls back to magpie.
- **bridgeHooks**: `grok plugin` exists but the event surface is not in the help ⇒ stream bridge
  over ACP NDJSON (`--output-format streaming-json`).
- **note**: `--leader-socket` explains multi-instance coordination; mola leaves the default leader alone.

### 2.5 agy (Antigravity CLI) — `plugins/agent-agy`

Grounded in `agy-help.txt`.

- **runHeadless**: `agy --print "<prompt>" --output-format stream-json [--print-timeout <s>]
  --mode accept-edits [--model <m>] [--effort <level>] [--add-dir <d>]`.
  - `permissionProfile`: `plan` / `accept-edits` / `auto`; `--dangerously-skip-permissions`
    is the full-auto escape (approval-gated).
- **resume**: `agy --conversation <id> --print ...`; latest: `agy -c`.
- **listSessions**: **gap** — no session-listing command in the help (`agy agents` lists *agent
  profiles*, not sessions). Workaround: magpie sessions does not cover agy either ⇒ adapter reports
  `listSessions: false`; session ids are captured from our own `RunResult`s and persisted in
  `.mstack/runs/`.
- **setModel**: magpie ls detects `Antigravity CLI`; per-run `--model`.
- **bridgeHooks**: `agy plugin` exists, surface unverified ⇒ stream bridge.
- **extra**: `--remote-control` / `agy remote-control` daemon is agy's own remote surface; the
  envs-collab section decides whether mola rides it. `agy doctor` equivalent does not exist;
  health = `agy --version` exit 0.

### 2.6 devin — `plugins/agent-devin`

Grounded in `devin-help.txt`.

- **runHeadless**: `devin -p "<prompt>" --permission-mode accept-edits [--model <m>] [--export
  <path>]`. Print mode **fails in untrusted directories**; the adapter passes
  `--respect-workspace-trust false` only for workspaces mola itself created.
- **resume**: `devin -r <id> -p ...`; latest: `-c`; list: `devin list` (current directory).
- **cloud**: `--cloud`, `devin cloud`, `devin ssh`, `devin forward` — the only agent with a
  first-party cloud box; the router may select it for "run off-machine" tasks when the user has a
  Devin account (capability `cloud: true` on this adapter only).
- **setModel**: magpie ls detects `Devin` (`~\AppData\Roaming\devin\config.json`); per-run `--model`.
- **installSharedContext**: native — `devin rules` and `devin skills` manage always-on context and
  skills; still prefer magpie library when the content is the shared set.
- **bridgeHooks**: none in help ⇒ ACP (`devin acp`) or stream of `--export` file.

### 2.7 pi — `plugins/agent-pi`

Grounded in `pi-help.txt`.

- **runHeadless**: `pi -p "<prompt>" --mode json` (or `--mode rpc` for a JSON-RPC control channel —
  the strongest headless surface after DSH). Tools: `--tools read,grep,find,ls` for read-only runs,
  `--exclude-tools` for denial.
- **resume**: `pi -r` (picker) / `--session <path|id>`; exact id with `--session-id <id>`
  (creates if missing — good for mola-issued stable ids); fork: `--fork`; latest: `-c`.
  Sessions live in `PI_CODING_AGENT_SESSION_DIR` / `~/.pi/agent/sessions`.
- **setModel**: magpie ls manages `Pi` (currently `magpie/grok/grok-4.7`); per-run
  `--model provider/id[:thinking]`.
- **installSharedContext**: native per-run `--skill <path>` / `--extension <path>` /
  `pi install <source>`; shared set via magpie library.
- **bridgeHooks**: extensions exist but no event names in help ⇒ stream bridge over `--mode rpc`.

### 2.8 opencode — `plugins/agent-opencode`

Grounded in `opencode-help.txt` + [opencode plugin docs](https://opencode.ai/docs/plugins/).

- **runHeadless**: `opencode run --prompt "<prompt>" [--session <id>] [--auto] [--standalone]`.
- **resume**: `opencode run -s <id>` / `-c` for last. `opencode session` manages sessions;
  `opencode stats` gives usage statistics.
- **server mode** (the interesting one): `opencode serve` starts the v2 API + web server;
  `opencode api` makes requests against the running server; `--server <url>` connects a client to
  it. This makes opencode the most **remote-controllable** local agent after DSH: mola can treat a
  long-lived `opencode serve` on jlu-pc as a worker endpoint.
- **setModel**: magpie ls manages `OpenCode` (`magpie/codex/gpt-6-luna`);
  `opencode models` lists; provider plugins via `magpie plugin` (magpie help line 70–72).
- **bridgeHooks**: **native, documented** — an opencode plugin (JS file in
  `~/.config/opencode/plugins/`) subscribes to server events (`permission.asked`,
  `message.updated`, `file.edited`, …) via `ctx.event.subscribe({ types: [...] })`
  ([docs](https://opencode.ai/v2/docs/build/plugins/server/)). Bridge = one mola-shipped plugin
  file; note OpenCode 2.x requires the new default-export plugin shape
  ([lazysh#616](https://github.com/mihazs/lazysh/issues/616)).

### 2.9 omp — `plugins/agent-omp` (DEGRADED)

`omp-help.txt` is not a help page: it is a **Bun `SyntaxError` crash** from
`C:\Users\22494\.bun\install\global\node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js`. On this
machine `omp` cannot even print help. Design consequences:

- `detect()` runs `omp --version` with a 10 s timeout; on non-zero exit or crash text the adapter
  reports `health: 'broken'` and the router excludes omp from all routes (a broken binary must not
  receive work).
- omp is `@oh-my-pi/pi-coding-agent`, i.e. pi-derived, and magpie manages it
  (`~\.omp\agent\config.yml`, currently `magpie/gemini/gemini-3.1-pro-preview`). **Smallest
  workaround**: the adapter declares `capabilities = pi-compatible` *only after* a runtime probe of
  `omp --help` succeeds on a fixed install; until then it is detect-only. Do not copy pi's flag
  grammar blindly — that would be inventing flags.
- Routing consequence: tasks that would go to omp fall back to pi (same heritage) per ADR-0003 §4.

### 2.10 dsh (DeepSeek Harness, WSL headless profile `mola-cli`) — `plugins/agent-dsh`

Grounded in `dsh-cli-help.md`, `dsh-architecture.md`, and the **tested** invocation in
`skills/m-dispatch/references/harness-commands.md`.

- **detect**: on Windows, probe WSL: `wsl -e bash -lc 'command -v dsh && dsh --version'`.
  magpie manages the WSL profile (`\\wsl.localhost\Ubuntu\root\.dsh\profiles\mola\cordis.patch.yml`,
  route `magpie/group/smart-split`).
- **runHeadless** (tested, writes files):
  ```sh
  wsl -e bash -lc 'source ~/src/mola-dsh-stack/scripts/env.sh; cd <wsl-path>; \
    dsh --profile mola-cli --patch <model-overlay.yml> --json "<task>"'
  ```
  - Model overlay (mola generates it per run):
    `- id: agent-default-model / config: {provider: magpie, model: group/smart-split}`.
    **Never `deepseek/*` direct** — a 402 there kills every worker at once (FRAMEWORK §6).
  - Headless flags: `--json` (NDJSON run events), `--session-id <id>` (resume), `--permission-mode
    <preset>`, `--approval-policy ask|never`, `--add-dir <path>`.
  - Windows path `E:\x` ⇒ `/mnt/e/x`; from Git Bash prefix `MSYS_NO_PATHCONV=1`.
- **resume**: `--session-id <id>` ("adopt the persisted Session with this id").
- **setModel**: magpie already writes the profile patch; per-run route change = a new `--patch`
  overlay. No other mechanism.
- **bridgeHooks**: the **richest** surface — DSH is a Cordis plugin tree with durable session
  events (`turn/start`, `step/*`, `tool/call`, `tool/result`) and live `agent/*` and `tools/*`
  events. Bridge = a small `dsh-mola-bridge` plugin mounted via `--patch` that forwards events to
  the bus (ADR-0004 §4). Plugin install: `dsh plugin --profile mola-cli add <pkg>`.
- **parallel workers**: one `wsl -e bash <script> <id>` per worker in background, each logging to
  `logs/<id>.out`; headless prints only the final answer, so watch written files, not stdout
  (harness-commands.md).
- **usage**: via magpie (all dsh traffic rides magpie routes).

### 2.11 orca — `plugins/agent-orca` (ORCHESTRATOR, optional)

Orca is not an agent; it is a desktop + CLI orchestrator whose workers *are* the other agents
(claude, codex, omp, pi, grok, …). It therefore implements a second interface:

```ts
interface OrchestratorAdapter {
  startWorker(spec: string, opts: { worktree: 'current' | 'new-top-level'; agent: string;
    model?: string; repoId?: string; name?: string }): Promise<WorkerHandle>; // dispatch:<id>
  send(to: WorkerHandle, subject: string, body: string): Promise<void>;
  reply(messageId: string, body: string): Promise<void>;
  createHandoffWorktree(name: string, agent: string, prompt: string): Promise<WorktreeRef>;
}
```

Grounded in `inputs/orca-cli.md` / `orchestration.md`:

- start: `orca orchestration worker-start --spec "<task>" --worktree current --agent codex`
  (or `orca worktree create --name <n> --no-parent --agent <a> --prompt "<brief>" --json` for
  nothing-expected-back handoffs).
- talk: `orca orchestration send --to dispatch:<id> --subject … --body …`;
  answer: `orca orchestration reply --id <message_id> --body …`.
- settle: `worker_done` settles; `escalation` + `stopReason` = stopped without delivering.
- **detect**: `orca` on PATH. FRAMEWORK §9.2 says Orca is **not currently installed** ⇒ adapter
  ships disabled; the router only offers it when `detect()` succeeds (matches the mstack rule
  "`orca` 在 PATH 上才用"). Rules the adapter must enforce, from the source docs: never poll (Orca
  wakes you), never steer a worker through its terminal (use `send`), `--no-parent` for independent
  handoffs.

---

## 3. Tool adapter mappings

### 3.1 git + gh — `plugins/tool-git`

Grounded in `gh-help.txt`. **Gap**: no `git-help.txt` was captured; the adapter restricts itself
to stable porcelain verbs (`git worktree add/remove/list --porcelain`, `git status --porcelain=v2`,
`git rev-parse`) and `mola doctor` verifies behavior instead of flag strings.

- **worktrees** (isolation for dispatched subtasks, FRAMEWORK §6):
  `git worktree add ../<repo>-<task> -b agent/<task>`; each subtask gets its own worktree; no two
  subtasks edit the same file. Native agent flags (`claude -w`, `codex --worktree`, `grok -w`) are
  preferred when the run is single-agent; the tool adapter is used when the router creates the
  workspace *before* choosing the agent.
- **PRs**: `gh pr create`, `gh pr checks`, `gh pr view --json`, `gh pr checkout`, plus
  `gh run view`/`gh workflow` for CI. `gh agent-task` (preview) and `gh skill` (preview) exist —
  noted, not depended on. All outward actions (`gh pr create`, merge, comment to others) sit behind
  the approval gate (constraint 7).
- **rtk compaction**: agent-facing output of `git`/`gh` goes through `rtk git` / `rtk gh` unless
  `rtk bypass` semantics are requested (see 3.3).

### 3.2 OMC — `plugins/tool-omc`

Grounded in `omc-help.txt` and the machine's coexistence rules.

- **Boundary (decided by the workspace rules, not reopened)**: OMC's workflow skills that overlap
  mstack (autopilot, ralph, ultragoal, team skill, plan, review, verify, debug, deep-interview,
  research, …) are **superseded by mstack skills**; mola never routes to them. OMC remains for:
  - **agents & team CLI**: `omc team [args...]` (worker lifecycle), `omc interop` (Claude+Codex
    split-pane), `omc launch`.
  - **state/notepad**: exposed as **MCP tools** into Claude Code by OMC's install
    (`omc install --target ~/.claude`); they are not omc CLI subcommands — the adapter talks to
    them through the agent's MCP, or falls back to `.mstack/` files when absent (mstack's own rule).
  - **plan/interview/brainstorm**: mola routes these to `m-think`/`m-plan` (mstack), not OMC.
  - **worktrees**: `omc teleport '#123'` (git worktree for isolated development).
  - **quota/rate-limit**: `omc wait` (rate-limit wait + auto-resume) — a building block for
    ADR-0003 §4 quota recovery on Claude accounts; `magpie quota wait` is the cross-provider one.
  - **hooks**: `omc config-stop-callback <file|telegram|discord|slack>` (stop-hook notifications),
    `omc hud` (statusline). OMC's keyword-detector/persistent hooks are **off** on this machine
    (`OMC_SKIP_HOOKS`); mola keeps them off and bridges stop notifications through the hook bus
    instead (ADR-0004).
  - diagnostics: `omc doctor`, `omc info`, `omc capabilities` (lockfiles), `omc session[s]`.

### 3.3 rtk — `plugins/tool-rtk`

Grounded in `rtk-help.txt`.

- Role: output compaction between tool subprocesses and agent context. mola uses three
  commands directly:
  - `rtk rewrite <cmd>` — canonical rewrite of a raw command to its RTK form ("single source of
    truth for hooks"); adapters call it before logging a command into an agent prompt.
  - `rtk bypass <cmd>` — raw output when it matters (failing log, byte diff, output we parse);
    matches the machine rule.
  - `rtk gain` / `rtk cc-economics` — savings telemetry, surfaced by `mola doctor` and `mola cost`.
- `rtk pipe` lets mola compact arbitrary captured output before feeding it back to an agent.
- Which agents run their shells through RTK is magpie's domain (`magpie library rtk on|off <agent>`);
  mola reads that state, never sets it.

### 3.4 magpie — `plugins/tool-magpie` (the model-routing tool)

Grounded in `magpie-help.txt`, `magpie-agents.txt`, `magpie-routes.txt`, `magpie-library-help.txt`.

- **models**: `magpie models [<agent>]`, `magpie model name|efforts`, `magpie visible`.
- **routes**: `magpie groups`, `magpie group add <name> models=… routing=smart|order|rotate|usage|
  pace|weight|free|fast|cheap|drain|expiring`. Current groups (magpie-routes.txt):
  `group/smart-split` (难题给强模型，简单的给便宜模型 — the default for dsh workers), `group/forcp`,
  `group/group-2` (无监管), `group/claude-cheap`, `group/claude-ultra`, plus `auto/*` single-model
  routes. dsh's visible set is exactly the line in magpie-routes.txt — the router must not emit a
  route outside an agent's visible set.
- **quota & fallback**: `magpie quota [<provider>] --json`, `magpie quota wait <provider|account>`,
  `magpie provider fallback <id> <provider/model>…` (used when a provider is out of quota or down).
- **library**: `magpie library instructions|mcp|skill …` (shared instructions/MCP/skills into every
  agent), `magpie library sync` after changes.
- **usage/cost**: `magpie usage [today|7d|30d|all] [--csv]`, `magpie sessions [--json]`,
  `magpie accounts --json`.
- **discovery**: `magpie ls` (agents + current model + config path), `magpie agents` (supported
  list: claude, codex, gemini, opencode, mimocode, deveco, pi, goose, cursor, zed, copilot, crush,
  aside — plus detected Kimi Code, Grok Build, Devin, omp, DeepSeek Harness on this machine).
- **gateway keys for remote workers**: `magpie gateway-key issue --ttl 1h --models a,b --cost USD`
  hands a cloud VM or a teammate's machine a short-lived, budget-capped key — the secrets-safe way
  (constraint 7) to let off-machine agents ride the main magpie gateway instead of copying keys.
- **health**: `magpie healthcheck` (exit 0 when the gateway answers) — used by `mola doctor` and by
  the router's machine-availability probe for `local`.

### 3.5 LayerFS — `plugins/tool-layerfs`

**Gap**: no `layerfs --help` was captured (the repo is `Ephemeral-AI-Lab/layerfs`, Rust; the design
inputs only describe semantics). Per `inputs/04-session-resume.md`, LayerFS provides
**workspace checkpoint + branch** as the transportable unit for cross-machine handoff ("ephemeral
workspace, durable shared history"). The adapter therefore ships in a later batch with:
- `detect()`: `layerfs --version`; B1 acceptance includes capturing `layerfs --help` into
  `cli/design/inputs/` and replacing the assumed verbs below.
- assumed verbs (to verify): `checkpoint`, `branch`, `restore`, `diff`. Until verified, the router
  uses `git worktree` + WIP commit as the checkpoint mechanism and treats LayerFS as optional.

### 3.6 docker — `plugins/tool-docker`

**Gap**: no `docker-help.txt` captured. Thin adapter over universally stable verbs:
`docker run --rm -v <ws>:/ws -w /ws <image> <cmd>` for sandboxed execution of untrusted
third-party plugins and for reproducing CI; `docker compose up -d` for service deps. Agent-facing
output compacted via `rtk docker`. Docker also underpins the "externally sandboxed" story that
makes `danger-full-access`-class modes acceptable (claude/codex help texts both say their bypass
flags are intended for externally sandboxed environments).

---

## 4. The routing layer (summary — full decision in ADR-0003)

```ts
interface RouteRequest {
  taskKind: 'implement' | 'review' | 'research' | 'debug' | 'plan' | 'qa' | 'ship' | 'chat';
  prompt: string;
  prefersAgent?: string;         // user pinned it
  budgetUsd?: number;
  requiresCapability?: Partial<AgentCapabilities>; // e.g. { nativeHooks: true }
  workspace: { repo: string; isolation: 'worktree' | 'layerfs' | 'shared' | 'cloud' };
  approval: 'interactive' | 'batch-approved';      // constraint 7
}
interface RouteDecision {
  agent: string;                 // adapter id
  machine: string;               // 'local' | 'wsl:Ubuntu' | tailscale host | 'devin-cloud'
  workspaceDir: string;          // created by tool-git / tool-layerfs / the agent's own -w flag
  modelRoute: string;            // magpie route, ALWAYS group/* or auto/* for headless fleets
  fallbacks: Array<{ agent: string; modelRoute: string }>;
  reason: string;                // one line, logged to .mstack/runs/
}
```

Rules the policy encodes (details and alternatives in ADR-0003):

1. **Two-level routing**: mola picks agent + machine + workspace; **magpie picks the model**. mola
   never writes agent configs and never routes around magpie.
2. **Route whitelist**: headless fleets use only `group/*` / `auto/*`; `deepseek/*` direct is banned
   for workers (402 blast radius — all workers die together, observed).
3. **Availability probe**: tailscale peer status + adapter `detect()` per machine; per
   `inputs/01-topology.md`, only main / jlu-pc / muse are reliably online ⇒ jlu-pc is the default
   remote worker host; a sleeping machine is simply absent from the candidate set.
4. **Quota failure normalization**: adapters map provider errors to `QuotaFailure` (DeepSeek 402,
   Claude rate-limit, …); recovery = (a) magpie-level `provider fallback` / `quota wait`, then
   (b) mola-level re-dispatch of the *remaining* work on a different route (harness-commands.md
   pattern: list files already written, re-dispatch the rest on e.g. `auto/kimi-k3`).
5. **Safety**: `permissionProfile` ≥ workspace-write and any outward action require
   `approval: 'batch-approved'` or an interactive yes.

---

## 5. mola commands → skills → adapters

The mstack skills are the "how to work"; `mola` commands wrap them with routing and adapters.
Each `mola <verb>`: (1) resolves/creates `.mstack/` state per the skill, (2) asks the router for a
`RouteDecision`, (3) launches via the chosen `AgentAdapter`, (4) reports in the mstack format.

| mola command | wraps skill | primary adapters used | notes |
|---|---|---|---|
| `mola run "<task>"` | — (bare dispatch) | router → any AgentAdapter `runHeadless` | the B1 workhorse; `--agent`, `--route`, `--machine` pin the decision |
| `mola think` | `m-think` | interactive-capable agent (claude/kimi/devin with plan mode) | brainstorm/interview stay in mstack, not OMC (§3.2) |
| `mola plan` | `m-plan` | same; critic pass routed to a *different* agent/model (principle 6) | output `.mstack/plans/<date>-<slug>.md` |
| `mola goal <slug>` | `m-goal` | DSH headless fleet (`--session-id` per checkpoint) or claude `--bg` | closeout mandatory; goal file `.mstack/goals/<slug>.md` |
| `mola team <slug>` | `m-team` | rounds of `mola dispatch`; optional orca orchestrator | team config `.mstack/team/<slug>/v<N>.md` |
| `mola dispatch` | `m-dispatch` | claude (Agent tool), **dsh WSL fleet**, codex exec, orca workers | isolation via tool-git worktrees; one prompt template (`subtask-prompt-template.md`) |
| `mola review` | `m-review` | reviewer ≠ writer (different agent and/or model route) | parallel angles via dispatch; summary `.mstack/reviews/` |
| `mola ship` | `m-ship` | tool-git (`git`, `gh pr …`), agent for fixes | **approval gate** before `gh pr create`/push; rtk compacted CI logs |

Hook-bus touchpoints: every adapter run emits `run.started` / `run.finished`; `mola ship` emits
`pr.created` only after the approval event `approval.granted` (ADR-0004).

---

## 6. Unified hook bus (summary — full decision in ADR-0004)

Canonical events (namespace `mola.<domain>.<verb>`), envelope, and per-agent bridges are specified
in ADR-0004. Two bridge kinds:

- **Native-hook bridges**: claude (`--settings` hooks + `--include-hook-events`), codex
  (`CODEX_HOME` overlay `hooks.json`), opencode (plugin `ctx.event.subscribe`), dsh (Cordis bridge
  plugin via `--patch`), OMC (`config-stop-callback` → bus).
- **Stream bridges**: parse headless NDJSON into the same canonical events — kimi `stream-json`,
  grok `streaming-json` (ACP-shaped), agy `stream-json`, pi `--mode json/rpc`, claude/codex text
  fallback, dsh `--json`.

Persisted to `.mstack/runs/<run-id>/events.jsonl` so `mola goal`/`mola team` can reconstruct what
happened without the agent.

---

## 7. Known gaps and smallest workarounds (honesty list)

1. **omp is broken on this machine** (Bun SyntaxError in its own dist) — adapter is detect-only
   until `omp --version` exits 0; route its work to pi meanwhile. (§2.9)
2. **No `git-help.txt`, `docker-help.txt`, `layerfs-help.txt` captured** — adapters restricted to
   stable porcelain verbs; B1 task: capture the three `--help` outputs into `cli/design/inputs/`.
   (§3.1, §3.5, §3.6)
3. **codex headless resume flags not captured** — probe `codex exec --help` at detect; interim
   workaround is `codex queue` into the app-server session. (§2.2)
4. **agy has no session-listing command** — mola persists its own run/session registry in
   `.mstack/runs/`. (§2.5)
5. **Only claude has a native budget cap** (`--max-budget-usd`); elsewhere the router enforces
   budget by polling `magpie usage` and killing the run. Declared capability gap, not hidden. (§2)
6. **Hook event names for claude/codex come from their docs, not the captured help** — adapters
   verify at detect time against the installed version. (§2.1, §2.2)
7. **grok/agy/pi plugin event surfaces undocumented** in captured material — stream bridges only
   until verified.
