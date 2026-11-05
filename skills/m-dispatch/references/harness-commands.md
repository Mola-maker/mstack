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

- `Agent`/`Task` tool with `subagent_type` (executor / explorer / verifier), `run_in_background: true`.

## Orca (optional backend — use only when `orca` is on PATH)

Desktop + CLI orchestrator: each worker (Claude Code / Codex / OpenCode / Pi) runs in its own worktree, and progress can be watched from a phone. Not installed by default — check `orca` resolves before using any of this.

Start one worker per self-contained subtask, then **end your turn**: Orca wakes you when there is mail. Never poll and never write watch scripts — a script's plain `check` swallows the mail Orca would wake you with.

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
