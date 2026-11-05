# mola — CLI (B1 skeleton)

Plugin-based agent orchestration CLI. Spec: [design/DESIGN.md](design/DESIGN.md),
[design/BATCHES.md](design/BATCHES.md) (B1), ADRs [0001](design/adr/0001-ts-rust-boundary.md) /
[0002](design/adr/0002-plugin-manifest-and-loading.md). Requires Node ≥ 22 and pnpm.

## Dev commands

```sh
cd cli
pnpm install            # only dependency: typescript (dev). No native binaries.
pnpm -r build           # tsc -b in every package (topological order)
pnpm -r test            # node:test suites (compiled to dist/test/)
node packages/mola/dist/bin.js help
node packages/mola/dist/bin.js doctor --json
node packages/mola/dist/bin.js plugin list --json
node packages/mola/dist/bin.js config get log.level
```

The bin runs as `node packages/mola/dist/bin.js` on both Linux and Windows
(paths via `node:path` only). Runtime state lives in `~/.mola/` (`config.jsonc`,
`state.json`, `logs/mola.log`, `plugins.json`); set `MOLA_HOME` to redirect it —
the test suites do exactly that with tmp dirs.

## Layout

```text
packages/mola/         the `mola` bin — global flag parsing → @mola/core boot()
packages/core/         @mola/core: plugin loader, command router, event/hook bus,
                       config layers (JSONC), JSON state store, logging/traceId,
                       exit-code contract, --json envelope
packages/plugin-sdk/   @mola/plugin-sdk: Plugin/PluginContext types, adapter
                       interfaces, manifest JSON Schema + validator — the only
                       place interfaces are defined (DESIGN §11 conflict 3)
packages/rpc/          @mola/rpc: JSON-RPC 2.0 NDJSON client stub for sidecars
                       (ADR-0001); server half arrives with sidecars in B3
packages/plugins/      builtin (tier: builtin) plugins, one package each:
  cmd-doctor/          mola doctor — framework + node>=22, plugins.plan-ok
  cmd-config/          mola config get|set (secret-shaped keys refused, exit 77)
  cmd-plugin/          mola plugin list | validate <dir>
```

## Exit codes (sysexits.h, core §8.3)

0 ok · 64 usage · 65 bad manifest/config · 66 missing input · 69 upstream
unavailable · 70 software · 77 policy denied. `--json` everywhere: one
`{schemaVersion, command, traceId, data}` envelope on stdout; errors are
`{error:{code,message}}` on stderr with stdout kept clean.

## Extension points (for B1 step 2 and B2+)

Everything user-visible is a plugin registered through `PluginContext`:

| Surface | SDK entry point | Step-2 consumer |
|---|---|---|
| commands | `ctx.commands.register({path, description, handler})` | cmd-dispatch, cmd-model, cmd-rtk |
| doctor checks | `ctx.doctor.registerCheck({id, run})` | tool-magpie → magpie.healthcheck, agent-dsh → agent.dsh, tool-rtk, tool-git |
| agents | `ctx.agents.register(adapter)` | agent-dsh |
| tools | `ctx.tools.register(adapter)` | tool-magpie, tool-rtk, tool-git |
| event listeners | `ctx.events.on/hook/onSerial` (broadcast/waterfall/serial) | policy-approval hooks `mola.tool.before` + `mola.task.pre-dispatch` |
| sidecars | `ctx.sidecars` (stub) + `@mola/rpc` client | mola-ptyd / mola-syncd (B3) |

Events use the ADR-0004 `mola.<domain>.<verb>` vocabulary; waterfalls may
rewrite or reject (`PolicyDenial` → exit 77). The death-loop brake quarantines
a plugin after 3 consecutive listener failures.

## B1 status

Step 1 (this tree): core skeleton + cmd-doctor/cmd-config/cmd-plugin.
Step 2 adds cmd-dispatch, cmd-model, cmd-rtk, agent-dsh, tool-magpie, tool-rtk,
tool-git, policy-approval (see BATCHES.md B1 acceptance commands).
