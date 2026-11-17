# mstack agent writes on LayerFS 2.0

Date: 2026-11-17. Status: design; the file path and the git accept path proved on a real install (WSL); per-worker scope and Sandboxes not yet run.

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
| (not used: overwrites) | `branch.publish(p, "agent-ab")` | `Added`: main's next Layer |
| export to a fresh folder | `project.export(p, dest)` | all four files, with the edit |

**Branch names cannot contain `/`.** `agent/a` is refused with `InvalidInput`. LayerFS branches are therefore named `agent-<task>`; the git branch made at the end keeps `agent/<task>`.

## Limits that shape the design

- The addon ships for **linux x64 with glibc ≥ 2.39** only. On Windows this means WSL, where the DSH workers already run. Windows-native and macOS are not supported in this version.
- **Sandboxes and Workspaces** (`workspace.mount/exec/commit`) let a worker run commands on its Branch, but they need a machine. A `native` Sandbox on Linux needs root for FUSE ("Not built" for a non-root user in limitations.md), WSL workers run as a user, and the manual lists the Linux host as not verified. Until a Docker or VM machine is proved here, a worker runs tests on an export of its Branch (step 3).
- **`branch.merge` conflicts only on the same lines.** Two Branches that change different lines of one file merge silently. The rule "no two subtasks edit the same file" is checked on the paths, before merging (step 5).
- **`branch.publish` overwrites; it does not merge.** A Branch based on an older main replaces main's newer files and reports `overwrote_count`, without a Conflict. This flow never publishes. Git does the integration with the rest of the world.
- **`project.export` needs an absent or empty destination** (`NotEmpty` otherwise). Results go to a fresh folder, never into the repo.
- **`project.init` imports whatever the folder holds, `.git` included.** Init from a `git checkout-index` of the base commit: tracked files as a checkout has them, with no `.git` and no gitlinks. Not `git archive`: it honours `export-ignore` and `export-subst`, and the accept step would then commit their deletion or expansion. A worker can still create `.git` folders in its Branch, so any diff path with a `.git` component (`/(^|\/)\.git(\/|$)/`, nested ones included) refuses the Branch.
- `branch.diff` answers `{items: [{path, kind, type, …}], has_more, next_page_pos}`: read every page.
- Every call is one attempt, with no retries. After a lost reply, read the state again (`branch.get`); never repeat the write blindly.
- One store is held open per process: call `close()` before exit.

## The flow (m-dispatch step 4, Isolate, and step 6, Merge)

Proved end to end on a real git repo that has `export-ignore` and `export-subst` attributes, a relative symlink, an executable and a submodule gitlink: `research/layerfs2/accept.mjs` (`run.sh accept` in WSL). The probe shows:

- a Branch where nobody wrote stages `(nothing)`;
- the refused Branches are `["agent-evil","agent-nested"]`, one with a top-level `.git` and one with `/pkg/.git`;
- for the shared-path check, `same file a & b ["/src.txt"]`;
- the integration stages `M other.txt | M src.txt | D ver.txt`;
- the link stays relative (`run.sh`), the executable bit stays, the gitlink stays `160000`, and `main` is untouched.

1. **Once per dispatch**:
   - Record the base commit: `base=$(git rev-parse HEAD)`.
   - `GIT_INDEX_FILE=<tmp> git read-tree $base && GIT_INDEX_FILE=<tmp> git checkout-index -a --prefix=<snap>/` gives the tracked files as a checkout has them: no `.git`, no attribute rewriting, symlinks as symlinks, gitlinks left out.
   - `project.init(<store>/<repo>-<base short>, <snap>)`. A new base means a new project; there is no sync of main.
2. **Per worker**:
   - `branch.fork(p, "agent-<task>", "main")`. Names cannot contain `/`.
   - The worker gets the project and Branch names and writes only through `file.write` / `file.edit` / `file.apply` (`apply` = a list of changes as one Commit, all or none). The commit message is the step from the plan.
   - Next step, not proved yet: give each worker a client scoped to its Branch (`client({scope: {project, folder: "/", branch: "agent-<task>"}})`, calls.md "Folder scope"), so that it cannot write another worker's Branch. A scope still allows merge and publish; the orchestrator alone calls those.
3. **Worker needs to run something** (tests, build):
   - `project.export(p, <fresh tmp>, {branch: "agent-<task>"})`;
   - run the command there;
   - report the output.
   - Edits still go through `file.*`.
4. **Review**: the reviewer reads the diff items and `file.read` at the Branch. That is the same evidence as a git diff, without a checkout.
5. **Checks before integrating**, for each Branch:
   - read every page of `branch.diff(p, "main", b, {paths_only: true})`;
   - **refuse** the Branch if any path has a `.git` component (`/.git`, `/pkg/.git/HEAD`);
   - **stop** when two Branches share a path. Report the tasks and the file, then split or sequence them. Merge would fold different lines of one file without a word.
6. **Integrate**: fold the Branches that passed with `branch.merge(p, "agent-int-<n>", a, b)`. A `Conflict` (same lines) creates nothing: report it. Verify (step 3) and review (step 4) the result.
7. **Accept, through git only, carrying exactly the changed paths**:
   - `project.export(p, <fresh tmp>, {branch: "agent-int-<n>"})`;
   - `git worktree add -b agent/<slug> <wt> $base`;
   - for every path in the integration Branch's diff (all pages), and nothing else:
     - gone from the export → remove it in the worktree;
     - a folder → `mkdir -p`;
     - a symlink → recreate it with the same link text (`readlink`), never followed or rewritten;
     - a file → copy it and its mode.
   - Delete the export, then `git add -A` and commit.
   - Files the workers did not touch are never rewritten, so attributes, symlinks, gitlinks and untracked files stay as they were. A Branch with no changes commits nothing.
   - Then the usual review, PR and merge.
   - LayerFS `main` is never published; it stays the base snapshot. Git is the system of record; LayerFS is the workspace.
8. **Hand-off between machines** (envs-collab B5): the unit to move is the store (`store push` / `store pull`), not a folder copy. Not part of this change.

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
