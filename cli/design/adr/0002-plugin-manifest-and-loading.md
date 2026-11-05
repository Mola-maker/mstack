# ADR-0002: plugin manifest format and loading model

- Status: proposed
- Date: 2026-11-06
- Deciders: mola core design
- Related: `cli/design/sections/core-plugins.md` §4–§6, ADR-0001

## Context

Hard constraint 2: *everything is a plugin* — agent adapters, tool adapters,
environments, sync backends, and even built-in commands. The core only loads plugins,
routes commands and events, and holds config and state. We need (a) one manifest format
that works for both TypeScript and Rust plugins, and (b) a loading model that is honest
about what Node.js can and cannot sandbox.

Prior art on this machine: DSH composes profiles from bundles whose plugins are declared
in `package.json` under a `dsh` field and mounted into a shared Cordis context, with
config layers patched on top (dsh-architecture.md). DSH's `dsh plugin` command forwards
verbatim to pnpm in the profile directory (dsh-cli-help.md). Claude Code's plugin format
(mstack itself: `.claude-plugin/plugin.json`) is a manifest-only package with no code
entry point. Neither solves "a plugin that is a Rust binary".

Constraints from the brief and repo:

- Plugin kinds are fixed: `agent | tool | env | sync | command | policy`.
- Third-party plugins must be installable (and therefore must declare what they can do).
- Safety constraint 7: irreversible/outward actions need policy approval; plugins are
  code, so plugin *installation* and *permission escalation* are themselves policy-gated
  events.
- mstack's own pain register includes "plugin conflicts" (omc vs superpowers) and
  "tool-call death loops" (FRAMEWORK.md §1) — the loader must detect conflicts and the
  runtime must be able to kill a misbehaving plugin.

## Decision

### 1. One manifest file per plugin: `mola-plugin.json`

Every plugin — TS or Rust, first- or third-party — has exactly one manifest at its root.
TS plugins *additionally* have a `package.json` used only for dependency installation;
the manifest is the source of truth mola reads. (We deliberately do **not** bury the
manifest in a `package.json` field the way DSH does, because Rust plugins have no
`package.json` and two declaration styles would drift.)

```jsonc
// mola-plugin.json — agent adapter example (first-party)
{
  "schemaVersion": 1,
  "id": "mola-agent-claude",            // unique, kebab-case, reverse-dns optional
  "version": "0.1.0",                   // semver
  "kind": "agent",                      // agent|tool|env|sync|command|policy
  "displayName": "Claude Code adapter",
  "mola": ">=0.1.0 <1.0.0",             // core API semver range
  "engine": { "node": ">=22" },         // TS plugins only
  "entry": {
    "ts": "./dist/index.js"             // ES module, exports default Plugin factory
    // Rust sidecar plugin instead:
    // "bin": "./bin/mola-syncd", "protocol": "jsonrpc-stdio"
  },
  "provides": ["agent:claude"],         // capability ids other plugins may require
  "requires": [],                       // capability ids that must exist before activation
  "capabilities": [                     // what this plugin can *do* in mola terms
    "agent.run", "agent.resume", "agent.stream-json", "hooks.bridge"
  ],
  "permissions": {                      // what this plugin is *allowed* to touch
    "process.exec": ["claude"],         // argv[0] allow-list
    "fs.read":  ["~/.claude/**"],
    "env.read": ["ANTHROPIC_*", "CLAUDE_*"],
    "net.connect": [],                  // none needed: magpie owns model traffic
    "mola": ["events", "config.read", "state.kv"]
  },
  "hooks": {                            // bus wiring declared, not hard-coded
    "emit": ["agent/run-started", "agent/run-finished"],
    "listen": ["task/pre-dispatch"]
  },
  "conflicts": ["mola-agent-claude-legacy"],
  "configSchema": { "type": "object", "properties": { /* … */ } }
}
```

Rules:

- `id@version` is the install identity; two versions may coexist on disk, one is active.
- `kind` is single-valued. A plugin that does two jobs ships two manifests (a package may
  contain multiple manifests, e.g. an adapter + its policy plugin).
- `provides`/`requires` are the *only* ordering mechanism; load order is a topological
  sort, and a cycle or a missing provider is a load error (exit 65), never a silent skip.
- `conflicts` is checked across the active set at load time — this is the direct answer
  to the omc-vs-superpowers class of failure recorded in FRAMEWORK.md §1.
- Manifests are validated against a versioned JSON Schema (`mola plugin validate`), and
  `schemaVersion` allows future migration without a flag day.

### 2. Loading: two phases, three trust tiers, reversible activation

```text
resolve ──► validate ──► plan (topo sort, conflict check, permission diff)
      ──► activate (grant permissions, call plugin.activate(ctx), register effects)
      ──► ready ──► deactivate reverses every effect (Cordis-style dispose stack)
```

- **Resolve.** Sources, in precedence order: built-ins bundled with `mola` → user plugins
  in `~/.mola/plugins/` (recorded in `~/.mola/plugins.json` with the permission snapshot
  granted at install time) → project plugins declared in `.mola/config.jsonc`.
- **Trust tiers** (recorded at install, shown by `mola plugin list`):
  1. `builtin` — compiled into the release; loaded in-process.
  2. `verified` — third-party, installed from a registry with a recorded tarball
     SHA-512; loaded in-process *only* if its permission set is a subset of a
     policy-approved profile, otherwise in an isolated worker (below).
  3. `untrusted` — local path or unknown registry; always loaded in a
     `node:worker_threads` isolate whose only communication channel is the plugin RPC
     bridge. Worker isolation is containment, not a security boundary against a
     determined attacker (see §3) — the permission gate at install/update time is the
     real control.
- **Reversible activation.** `activate(ctx)` receives a `PluginContext`; every
  registration it makes (commands, event listeners, timers, child processes) is tracked
  and unwound on deactivate/unload, so a failed plugin never leaves dangling handlers.
  A plugin whose `activate` throws, or that trips the death-loop brake (the same
  listener rejecting/erroring 3 times in a row, per the mstack guard rule), is
  deactivated, quarantined, and reported — the rest of the system keeps running.
- **Rust plugins** activate as sidecars per ADR-0001: the loader spawns the binary,
  performs `mola.hello`, and exposes the same `PluginContext` over JSON-RPC. Process
  isolation is inherent.

### 3. Sandboxing honesty

Node.js has no strong in-process sandbox: a JS plugin that can `require('child_process')`
can do anything the user can. We therefore do not pretend otherwise:

- The **declared permission model is enforced at the mola API layer**: plugins receive
  capability handles (`ctx.process.exec`, `ctx.fs`, …) that check the granted set on
  every call. This catches accidents and makes intent auditable — every privileged call
  is logged with plugin id and trace id.
- **Enforcement against malice is at install/update time**: permission diff review (the
  installer prints added permissions and asks, gated by policy), tarball hash pinning,
  and the tier system above. This mirrors how DSH treats profiles/patches: configuration
  is the control plane (dsh-architecture.md).
- Worker isolation for `untrusted` plugins raises the bar (no shared memory, bridge-only
  capabilities) and is the default answer for anything not reviewed by the user.
- Secrets never enter the plugin surface at all: `env.read` grants are name-scoped, and
  provider keys live in magpie/password manager, which mola shells out to — plugins get
  routes (`group/smart-split`), never keys (BRIEF constraints 3 and 7).

## Alternatives considered

| Option | Why rejected |
|---|---|
| DSH-style `package.json` field only | No story for Rust plugins; two manifest styles would drift. (We keep the *idea* of DSH's patch-layer config and reversible effects.) |
| ESM dynamic import with no manifest | No permission declaration → no install-time review; conflicts undetectable; exactly the omc/superpowers failure mode. |
| Deno/WASM plugin runtime | Loses the pnpm/Node ecosystem every adapter needs (spawning `claude`, `dsh`, `codex exec`, `gh`); over-engineering for a personal tool. |
| Plugins as MCP servers | MCP gives tools, not commands, config, routing policy, or hook participation; mola plugins need the full `PluginContext`. (An MCP *bridge* plugin can expose mola commands to agents later — different concern.) |

## Consequences

- `mola plugin install|update` must implement permission-diff review and hash pinning
  before any third-party plugin support ships (post-B1; B1 has only `builtin` tier).
- `mola plugin doctor` runs the resolve→plan half without activating: catches conflicts,
  missing providers, and stale `mola` API ranges. It is part of `mola doctor`.
- The death-loop brake and conflict checker are core features, not plugin
  responsibilities — they encode lessons already paid for (FRAMEWORK.md §1).
- A plugin authoring SDK (`@mola/plugin-sdk`) exports the `Plugin` and `PluginContext`
  types and a `definePlugin()` helper; manifest JSON Schema lives beside it and is the
  CI-checked contract.
