# ADR-0001: TS↔Rust boundary — sidecar binaries over JSON-RPC, not napi-rs

- Status: proposed
- Date: 2026-11-06
- Deciders: mola core design
- Related: `cli/design/sections/core-plugins.md` §7

## Context

Hard constraint 1 of the brief: TypeScript (Node ≥22, pnpm workspace) is the host; Rust
is used where it earns its place — **process supervision/PTY, the sync daemon, LayerFS
bindings, anything hot or long-running**. We must pick how the TS host talks to the Rust
code:

- **Option A — napi-rs in-process addon.** Rust compiles to a `.node` addon loaded by the
  CLI process, exposed as JS functions ([napi.rs](https://github.com/napi-rs/napi-rs/)).
- **Option B — sidecar binaries over JSON-RPC.** Rust compiles to standalone executables
  (`mola-ptyd`, `mola-syncd`, …) that the TS host spawns and supervises, speaking
  JSON-RPC 2.0 over stdio.

The decision is driven by the *shape* of the Rust work, not by language preference:

1. **The Rust components are daemons, not function calls.** The sync daemon and the PTY
   supervisor must outlive any single `mola` CLI invocation — a dispatched DSH headless
   worker (`dsh --profile headless …`) runs for minutes and its PTY must stay attached
   and observable after the dispatching command exits. A napi addon's lifetime is the
   host process's lifetime: the CLI exits, the supervisor dies, the PTY is orphaned.
2. **Crash isolation.** A panic inside a napi addon aborts the Node process. With the
   plugin loader, command router and event bus all in one Node process, one bad PTY edge
   case would kill every in-flight task and lose the event log tail. A sidecar crashes
   alone; the host logs `sidecar/crash`, respawns it, and reattaches.
3. **Multi-machine fit.** On the user's topology (01-topology.md: Windows main, WSL,
   jlu-pc Ubuntu 4090, cloud VMs on Tailscale), a sidecar can run standalone on a remote
   peer with no Node installed and be reached over a Tailscale socket — the same
   protocol, a different transport. A napi addon can never exist outside a Node process.
4. **Distribution is equally solved for both, but simpler for binaries.** The idiomatic
   npm pattern — one meta package plus per-`{os,cpu,libc}` packages wired through
   `optionalDependencies` — is used by esbuild, swc, biome and turborepo for plain
   binaries ([platform-packages guide](https://thekevinscott.github.io/putitoutthere/guide/npm-platform-packages),
   [biome distribution](https://deepwiki.com/biomejs/biome/2.3-distribution-and-packaging)),
   and by napi-rs for addons ([napi.rs release docs](https://napi.rs/docs/deep-dive/release),
   [oxc bindings](https://deepwiki.com/oxc-project/oxc/11-node.js-integration-(napi))).
   Plain binaries avoid the Node-API level matrix entirely: no "which Node-API version
   does this user's Node 22.x provide" support surface
   ([napi.rs compatibility](https://napi.rs/docs/more/support-compatibility)), no
   `@napi-rs/cli` build toolchain for contributors on Windows.
5. **Debuggability.** A sidecar is a normal program: run it by hand, pipe it JSON, attach
   `cargo` tooling, read its own log file. This matches the mstack principle "evidence
   before conclusions" — `mola doctor` can literally invoke each sidecar with a
   `mola.hello` handshake and report the result.

The cost we accept: no shared-memory, every call crosses a process boundary (NDJSON,
~microseconds–tens-of-microseconds per message). None of the listed Rust jobs are
chatty-per-keystroke FFI workloads; PTY output is a stream, which is exactly what
notifications are for. If a genuinely hot, call-per-operation Rust function appears
(e.g. a diff engine inside the command router's hot path), revisit with a *scoped*
napi-rs addon for that function only — this ADR does not forbid that as a later,
separately-justified exception.

## Decision

**Option B: sidecar binaries over JSON-RPC 2.0 on stdio (NDJSON framing).**

### Architecture

```text
mola (Node ≥22, TypeScript)
 ├─ in-process: plugin loader, command router, event bus, config, state, logging
 │     (all first-party TS plugins)
 ├─ spawn/supervise ── mola-ptyd   (Rust; portable-pty; ConPTY on Windows, forkpty elsewhere)
 ├─ spawn/supervise ── mola-syncd  (Rust; sync/event backend, see envs-collab section)
 └─ spawn/supervise ── mola-layerfs (Rust; thin wrapper over the existing LayerFS crates)
```

- **Framing:** newline-delimited JSON, one JSON-RPC 2.0 message per line, UTF-8,
  `\n`-terminated, no embedded raw newlines inside a message. Streams (PTY output, sync
  progress) travel as server→client *notifications*. If PTY throughput ever demands it,
  the protocol version negotiates length-prefixed binary frames; NDJSON is v1.
- **Handshake:** the host sends `mola.hello {protocolVersion: 1, host: "mola@<ver>"}` as
  the first request; the sidecar answers with its name, version, and capability list.
  Mismatch on major version → sidecar exits non-zero, host reports exit 69
  (`EX_UNAVAILABLE`) with a "reinstall/upgrade mola" hint. `mola doctor` runs exactly
  this handshake against every installed sidecar.
- **Supervision contract:** sidecars are children of the host *or* adopted daemons.
  Short-lived helpers are spawned per command and reaped. Long-running ones
  (`mola-syncd`) are started detached, registered in the state store
  (`~/.mola/state.db`), and re-adopted by PID + handshake on the next invocation; the
  host owns restart with exponential backoff (max 3 restarts in 60 s, then stop and
  surface — the mstack "3 failures → stop" rule, FRAMEWORK.md §4 principle 9).
- **Types:** `crates/mola-proto` holds the Rust (serde) types; JSON Schemas are generated
  from them into `cli/packages/rpc/schemas/`, and the TS side generates its types from
  those schemas. One source of truth, both sides checked in CI (§testing in the core
  section).

### Distribution

Rust sidecars ship as platform packages under the esbuild/biome pattern
([reference](https://engineered.at/articles/packaging-rust-applications-for-the-npm-registry)):

```jsonc
// cli/packages/mola/package.json (excerpt)
{
  "name": "mola",
  "bin": { "mola": "./bin/mola.js" },
  "engines": { "node": ">=22" },
  "optionalDependencies": {
    "@mola/ptyd-win32-x64": "0.1.0",
    "@mola/ptyd-linux-x64-gnu": "0.1.0",
    "@mola/ptyd-linux-arm64-gnu": "0.1.0",
    "@mola/syncd-win32-x64": "0.1.0",
    "@mola/syncd-linux-x64-gnu": "0.1.0"
    // …per-target, built by CI from crates/
  }
}
```

The resolver (`@mola/core/sidecars`) picks the matching package, falls back to a binary
on `PATH` (for dev checkouts and for machines where a user built from source), and as a
last resort offers `cargo install --path crates/<x>` instructions. WSL note: the Windows
host resolving `win32-x64` must not leak into WSL — resolution is per-process, keyed off
`process.platform`, so a WSL `mola` resolves the `linux-*` package. That is the desired
behavior (mola runs *inside* WSL there, per the DSH-over-WSL dispatch model in
`skills/m-dispatch/references/harness-commands.md`).

## Alternatives considered

| Option | Why rejected |
|---|---|
| napi-rs in-process addon | Daemon lifetime tied to CLI process; a Rust panic kills host + all in-flight work; Node-API support matrix; can't run standalone on a Tailscale peer. ([napi.rs](https://napi.rs/docs/deep-dive/release) solves distribution, not lifetime/isolation.) |
| WASM plugins/components | No PTY, no OS process supervision, no Tailscale sockets — the Rust jobs are precisely the OS-touching ones WASM can't do. |
| gRPC / HTTP between host and sidecar | Heavier schema toolchain, localhost port management, and auth questions on multi-user machines, for zero benefit at stdio's scale. Stdio JSON-RPC is the same pattern `dsh --profile sdk` already uses successfully (dsh-cli-help.md). |
| Vendored single fat binary (pkg/deno compile + embedded Rust) | Complicates the pnpm workspace story and code signing; platform packages are the solved, boring path. |

## Consequences

- `mola doctor` must verify sidecar presence, version, and handshake — it becomes the
  on-machine acceptance check for the boundary (B1).
- Every sidecar gets `--version` and a `mola.hello` implementation from day one; both are
  exercised by the shared protocol fixture tests in `crates/mola-proto/tests/fixtures/`.
- Plugin manifests may name a sidecar entry point (`entry.bin`, ADR-0002); third-party
  Rust plugins therefore inherit process isolation for free.
- Revisit trigger: a measured hot path where NDJSON IPC dominates (>5 % of a command's
  wall time in a trace) justifies a scoped napi-rs addon ADR.
