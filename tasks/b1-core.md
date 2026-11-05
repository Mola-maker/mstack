You are building batch B1 of the `mola` CLI, step 1 of 2: the core skeleton. The current directory is the mstack repo root (/mnt/e/mstack).
Read cli/design/BATCHES.md (section B1), cli/design/DESIGN.md, cli/design/sections/core-plugins.md and cli/design/adr/0001-0002. They are the spec; follow them, including the Resolved conflicts table.
Build in cli/: a pnpm workspace with packages/mola (the bin `mola`), packages/core (boot, plugin loader reading `mola-plugin.json`, command router, a minimal event bus with the mola.* vocabulary plus waterfall and broadcast listeners, config layers in JSONC at ~/.mola/config.jsonc, JSON state store ~/.mola/state.json, logging with traceId, the exit-code contract and the --json envelope), packages/plugin-sdk (types + manifest JSON schema), packages/rpc (client stub only). Builtin plugins in this step: cmd-plugin (list, validate), cmd-config (get, set), cmd-doctor (framework with node>=22 and plugins.plan-ok checks; other plugins will register more checks through the SDK).
Rules:
- Dependencies: only `typescript` (dev) and Node built-ins. Tests use `node:test`. No native-binary packages (the node_modules is shared between WSL and Windows).
- Build with `tsc -b`; the bin must run as `node cli/packages/mola/dist/bin.js` on both Linux and Windows, and paths must work on both.
- Leave clear extension points (SDK functions to register commands, doctor checks, agents and listeners) for step 2, which adds cmd-dispatch, cmd-model, cmd-rtk, agent-dsh, tool-magpie, tool-rtk, tool-git and policy-approval.
- Write cli/README.md (dev commands). Do not run git. Do not touch skills/ or other repo files except cli/.
When done run: cd cli && pnpm install && pnpm -r build && pnpm -r test && node packages/mola/dist/bin.js plugin list --json && node packages/mola/dist/bin.js doctor --json; echo exit=$?
Reply with the file tree (depth 3), the test summary, and the output of the last two commands.
