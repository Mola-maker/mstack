# Harness commands (m-dispatch)

Cross-harness dispatch commands, tested and ready to copy. Read this when Step 3 of m-dispatch needs the exact invocation per harness.

## DSH headless (WSL, tested — writes files)

```sh
wsl -e bash -lc 'source ~/src/mola-dsh-stack/scripts/env.sh; cd <wsl路径>; \
  dsh --profile mola-cli --patch <model-overlay.yml> "<task>" > <log> 2>&1'
```

- Model overlay (for `<model-overlay.yml>`): `- id: agent-default-model / config: {provider: magpie, model: deepseek/deepseek-v4-pro}`; use `deepseek/deepseek-v4-flash` for light work.
- Windows path `E:\x` maps to `/mnt/e/x` inside WSL. Add `--json` for an event stream.
- From Git Bash, prefix with `MSYS_NO_PATHCONV=1`, or `/mnt/e/...` gets rewritten to a Git install path.
- Parallel workers: put the command in a script and start one `wsl -e bash <script> <id>` per worker in the background, each writing `logs/<id>.out`. Headless prints only the final answer, so watch the files the workers write, not stdout.
- On `QUOTA: 402` (DeepSeek balance), all `deepseek/*` workers die together. Re-dispatch the remaining files with `model: auto/kimi-k3` (or another magpie route), and list which files already exist.

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

## Isolation

- Code-changing subtask → its own `git worktree` (`agent/<task>` branch) or a LayerFS branch; no two subtasks edit the same file.
