# Harness commands (m-dispatch)

Cross-harness dispatch commands, tested and ready to copy. Read this when Step 3 of m-dispatch needs the exact invocation per harness.

## DSH headless (WSL, tested — writes files)

```sh
wsl -e bash -lc 'source ~/src/mola-dsh-stack/scripts/env.sh; cd <wsl路径>; \
  dsh --profile mola-cli --patch <model-overlay.yml> "<task>" > <log> 2>&1'
```

- Model overlay (for `<model-overlay.yml>`): `- id: agent-default-model / config: {provider: magpie, model: group/smart-split}`. Always route through magpie (`group/*` or `auto/*`), never a direct `deepseek/*` route — that hits DeepSeek directly and drains the balance. `group/smart-split` takes no `reasoningEffort`.
- Windows path `E:\x` maps to `/mnt/e/x` inside WSL. Add `--json` for an event stream.
- From Git Bash, prefix with `MSYS_NO_PATHCONV=1`, or `/mnt/e/...` gets rewritten to a Git install path.
- Parallel workers: put the command in a script and start one `wsl -e bash <script> <id>` per worker in the background, each writing `logs/<id>.out`. Headless prints only the final answer, so watch the files the workers write, not stdout.
- On `QUOTA: 402`, every worker on the failing route dies together. Re-dispatch the remaining files with a different magpie route (e.g. `model: auto/kimi-k3`), and list which files already exist.

## DSH interactive session

- `subagent` — spawn a subtask with the DSH tools; accepts a `send_message` follow-up.
- `subagent_fork` — spawn a child that inherits this session's context.
- `subagent_claude_code` / `subagent_codex` — one-shot second opinion from another model; no follow-up.
- `workflow` — run a JavaScript orchestration script that fans work across many subagents with phases and structured results.

## Codex CLI

```sh
codex exec "<task>"
```

## Claude Code

- `Agent`/`Task` tool with `subagent_type` (executor / explore / verifier), `run_in_background: true`. `explore` is the read-only name in the installed agent set; `explorer` was not verified.

## herdr (when `herdr` is installed and its server runs)

herdr (github.com/herdrdev/herdr) keeps each worker in a terminal pane that survives a closed client, and marks every pane `working`, `blocked` or `idle`. Use it when the person wants to watch or step into the workers, or when workers are interactive agents (Claude Code, Codex, OpenCode, …) rather than headless runs. `herdr status server --json` says whether its server runs; without it, use the other executors. The workspace, pane and agent commands print JSON (`status` needs `--json`); take IDs from the answer, never guess them.

```sh
# one workspace for the dispatch, one pane per worker, each in its own worktree
ws=$(herdr workspace create --cwd <worktree-1> --label <run-id> --no-focus)
pane=$(printf '%s' "$ws" | jq -r '.result.root_pane.pane_id')
herdr agent start w-<task> --kind claude --pane "$pane"        # or codex, opencode, gemini, …
herdr agent prompt w-<task> "<the brief>" --wait --timeout 1800000
herdr agent read w-<task> --source recent-unwrapped --lines 200   # the RETURN block
# a second worker: a pane in its own worktree, then the same three steps
split=$(herdr pane split "$pane" --direction right --cwd <worktree-2> --no-focus); pane2=$(printf '%s' "$split" | jq -r '.result.pane.pane_id')
```

- **State, not polling.** `herdr agent wait <name> --timeout <ms>` returns when the worker is idle, done or blocked (`--until <state>` for one of them); `blocked` means it is asking a question. `agent prompt` to a blocked agent is refused with `agent_blocked` before anything is sent: read it, answer with `herdr agent prompt`, or report it. This replaces step 5's two status reads for the agent part; the worktree reads still apply.
- **A timeout proves nothing.** `agent prompt --wait` timing out, or `agent_prompt_stalled`, does not mean the prompt was not delivered. Read the agent before prompting again, or the worker gets the brief twice.
- **Names are per server.** `[a-z][a-z0-9_-]{0,31}`, unique; `w-<task>` keeps them apart from the person's own panes.
- **Long answers**: a full-screen agent may not show its whole reply in `agent read`. Ask for the RETURN block as a file in the worktree (`.mstack/dispatch/<task>.md`) and read the file.
- **What the person sees**: the herdr sidebar lists every worker and its state. A `mola` run started inside a herdr pane reports its own state there too (working, blocked with the reason, idle when over), and `mola web` lists herdr's agents beside mstack's runs.
- Model routing still applies to what each agent runs: pass the role's model to the agent after `--` (for Claude Code, `-- --model <alias>`); DSH workers stay on magpie routes.

## Orca (not the default)

Use this session's own subagent unless the job needs another vendor's agent, or a worktree a human will keep working in. Only then, and only when `orca` is on PATH, use the commands below. Desktop + CLI: each worker (Claude Code / Codex / OpenCode / Pi) gets its own worktree, and a phone can watch progress.

Start one worker per self-contained subtask, then **end your turn**: Orca wakes you when there is mail. Never poll and never write watch scripts — a script's plain `check` swallows the mail Orca would wake you with. If `orca` does not resolve, do not invent a replacement command.

```sh
orca orchestration worker-start --spec "<self-contained task>" --worktree current --agent codex
orca orchestration worker-start --spec "<self-contained task>" --worktree new-top-level --repo id:<repoId> --name <short-name> --agent claude
orca repo list --json    # gives <repoId>
```

- `--worktree current` shares your workspace; `new-top-level` gives the worker its own checkout (use it when sharing would conflict).
- Talk to a worker: `orca orchestration send --to dispatch:<id> --subject "<topic>" --body "<message>"`. Answer a worker's question: `orca orchestration reply --id <message_id> --body "<answer>"`.
- A `worker_done` message settles the task; never mark a reported failure completed. An `escalation` with a `stopReason` means the worker stopped without delivering — steer it with `send`, or retry it, or tell the user.
- Hand off work that needs nothing back (the human continues in that workspace):

```sh
orca worktree create --name <name> --no-parent --agent codex --prompt "<task brief>" --json
```

`--no-parent` keeps the handoff worktree top-level instead of stacked under the current one — use it for independent hand-offs.

## Isolation

- Code-changing subtask → its own `git worktree` (`agent/<task>` branch) or a LayerFS branch; no two subtasks edit the same file.
