# mstack agent writes on LayerFS 2.0

Date: 2026-11-17. Status: design, with the file path proved on a real install; the Sandbox path not yet run.

## Why change

mstack isolates each code-changing worker in a `git worktree` on `agent/<task>`. That costs a full checkout per worker. Workers can still step outside their folder, and the merge is a text merge done after the fact. LayerFS 2.0 (`@layerfs/node@2.0.0-rc.1`, published 2026-11-08) gives a project one store with:

- a cheap Branch per agent;
- one Commit per write;
- a structural `branch.diff`;
- a `branch.merge` that refuses conflicts and creates nothing;
- `publish` and `project.export` to bring the result back to a normal folder.

The earlier design (cli/design/sections/envs-collab.md §2.3, B5) assumed 1.1.0 and kept LayerFS as a placeholder. This replaces that assumption.

## What was proved (WSL Ubuntu, glibc 2.43, Node 24, throwaway home)

Probe: `research/layerfs2/probe.mjs` (run with `research/layerfs2/run.sh` inside WSL).

| Step | Call | Result |
|---|---|---|
| one project from the repo folder | `store.create`, `project.init(store/app, folder)` | ok |
| a Branch per worker | `branch.fork(p, "agent-a", "main")` | `Forked` |
| worker writes | `file.write`, `file.edit` (old/new), one Commit each | `Committed` |
| review input | `branch.diff(p, "main", "agent-a", {paths_only})` | the changed paths |
| integrate two workers | `branch.merge(p, "agent-ab", "agent-a", "agent-b")` | `Merged`, not fast-forward |
| two workers changed the same line | `branch.merge(p, "agent-ac", "agent-a", "agent-c")` | `Conflict`, "nothing was created" |
| accept | `branch.publish(p, "agent-ab")` | `Added`: main's next Layer |
| back to a git folder | `project.export(p, dest)` | all four files, with the edit |

**Branch names cannot contain `/`.** `agent/a` is refused with `InvalidInput`. LayerFS branches are therefore named `agent-<task>`; the git branch made at the end keeps `agent/<task>`.

## Limits that shape the design

- The addon ships for **linux x64 with glibc ≥ 2.39** only. On Windows this means WSL, where the DSH workers already run. Windows-native and macOS are not supported in this version.
- **Sandboxes and Workspaces** (`workspace.mount/exec/commit`) let a worker run commands on its Branch. They need a machine (`native`, Docker, VM). The 2.0 manual lists the Linux host as *not verified*. Until it is run here, a worker that must run tests uses the file path for edits and a plain checkout for running them (below).
- Every call is one attempt, with no retries. A lost reply means: read the state again (`branch.get`), never repeat the write blindly.
- One store is held open per process: call `close()` before exit.

## The flow (m-dispatch step 4, Isolate, and step 6, Merge)

1. **Once per dispatch**:
   - `project.init(<store>/<repo>, <repo folder>)` if the project does not exist yet; otherwise `branch.get(p, "main")`.
   - When main is behind the folder's HEAD, init a fresh project for this dispatch rather than sync. Re-basing main is not in 2.0.
2. **Per worker**:
   - `branch.fork(p, "agent-<task>", "main")`.
   - The worker gets the project and Branch names and writes only through `file.write` / `file.edit` / `file.apply`. `apply` takes a list of changes as one Commit, all or none.
   - The commit message is the step from the plan.
   - The worker never sees the folder, so it cannot write outside its Branch.
3. **Worker needs to run something** (tests, build). Until Sandboxes are proved:
   - `project.export(p, <tmp>, {branch: "agent-<task>"})` to a scratch folder;
   - run the command there;
   - report the output.
   - Edits still go through `file.*`. Once a Sandbox run is proved, this becomes `sandbox.create` + `workspace.mount(sbx, "agent-<task>")` + `workspace.exec` + `workspace.commit`.
4. **Review**: the reviewer reads `branch.diff(p, "main", "agent-<task>")` and `file.read` at the Branch. That is the same evidence as a git diff, without a checkout.
5. **Integrate**:
   - Fold the worker Branches pairwise with `branch.merge` into `agent-int-<n>`.
   - A `Conflict` stops that pair. Report the two tasks and the file; m-dispatch's "no two subtasks edit the same file" rule is now enforced, not just asked for.
   - The final Branch is verified (step 3 on it) and reviewed (step 4).
6. **Accept**:
   - `branch.publish(p, "agent-int-<n>")`, then `project.export(p, <repo folder or a worktree>)`.
   - Then an ordinary `git switch -c agent/<slug>`, commit, PR.
   - Git stays the system of record; LayerFS is the workspace.
7. **Hand-off between machines** (envs-collab B5): the unit to move is the store (`store push` / `store pull`), not a folder copy. Not part of this change.

## What changes in mstack

- `skills/m-dispatch/SKILL.md` step 4: name the LayerFS Branch `agent-<task>` and point to the flow above.
- `skills/m-dispatch/references/harness-commands.md`: a LayerFS 2.0 section with the calls, the naming rule, and how to read a `Conflict`.
- A `tool-layerfs` plugin for `mola` (next step, not in this change):
  - `ctx.tools.layerfs` wraps `@layerfs/node` in WSL (`wsl -d <distro> -- node …` from Windows);
  - `mola doctor` reports `layerfs.available` (WSL, glibc, the addon loads);
  - `mola go` picks LayerFS isolation when it is available and git worktrees otherwise.

## Not decided

- Store location (one per repo under `~/.mola/layerfs`, or one shared). The default here is one per repo.
- Whether workers call `@layerfs/node` directly (a small `mola lfs` command inside the worker's shell) or through MCP. The manual says an MCP server is not built (O32), so the default is a `mola lfs` command.
