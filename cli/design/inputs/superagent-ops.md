---
name: superagent-ops
description: Manage the dsh-superagent bots running in WSL (layerfs :3082, CAD2GIS :3083) from this Windows harness — status, pause/resume, retry or stop a Ticket, restart, the hourly health check, and saving settings.
whenToUse: The user mentions superagent / bot / Ticket / "GitHub 机器人" / "飞书机器人", asks why the bot didn't reply, wants it paused, restarted, or checked, or asks to set up the hourly check.
---

# Operating dsh-superagent from Windows

Two dsh-superagent instances run in WSL Ubuntu, each in its own DSH profile and tmux session:

| Bot | Repository | Profile | Panel / API |
|---|---|---|---|
| layerfs (+ Feishu) | Ephemeral-AI-Lab/layerfs | `superagent-layerfs` | http://127.0.0.1:3082 |
| cad2gis | Mola-maker/CAD2GIS | `superagent-cad2gis` | http://127.0.0.1:3083 |

WSL ports are reachable from Windows at 127.0.0.1. Do not install superagent into this Windows profile: it changes process-wide PATH and git settings and must restart independently.

## Management API (PowerShell)

Every request needs the header `x-orchestrator-request: 1`; the host must be 127.0.0.1:<port>.

```powershell
$h = @{ 'x-orchestrator-request' = '1' }
$api = 'http://127.0.0.1:3082/orchestrator/api'   # 3083 for CAD2GIS
Invoke-RestMethod "$api/state" -Headers $h | ConvertTo-Json -Depth 6     # setup problem, health, load, paused
Invoke-RestMethod "$api/sources" -Headers $h | ConvertTo-Json -Depth 6   # per-Source state, stats, dropped messages
Invoke-RestMethod "$api/executor/pause" -Method Post -Headers $h -ContentType 'application/json' -Body '{"paused":true}'   # false to resume
Invoke-RestMethod "$api/tickets/<id>/retry" -Method Post -Headers $h
Invoke-RestMethod "$api/tickets/<id>/stop" -Method Post -Headers $h
```

Read `state` like this:

- `setup.problem` not null → setup is incomplete. Its `code`/`detail` say what is missing (`agentCliSignedOut`: sign the agent account in with `gh-agent auth login` in WSL; `repositoryUnset`: rerun configure, see below). These are operator steps — tell the user the exact command, never ask for a secret.
- `health.<part>.state == 'error'` → report the part and `detail`.
- `load.queued` > 0 with `running == maxWorkers` → it is busy, not broken.
- Tickets waiting for a person show in the panel's Overview; send the user the panel URL.

## Commands that run in WSL

Wrap every WSL command like this (Linux PATH only):

```powershell
wsl -e bash -c 'source ~/src/mola-dsh-stack/scripts/env.sh; cd ~/src/dsh-superagent && scripts/dsh-superagent --profile superagent-layerfs --url http://127.0.0.1:3082 status'
```

- `status` / `start` / `restart` / `stop` exit with 0 = running normally, 1 = not running or unhealthy (a restart may fix it), 2 = a part reports an error (a restart will not fix it), 3 = waiting for setup.
- `--respect-stop restart` keeps an intentional stop.
- Startup logs: `~/src/dsh-superagent/.artifacts/dsh-superagent-<profile>-*.log` (newest last; the `dsh web:` line has the panel token).
- Save settings (repository, allowed list, worktree prepare command, Feishu chats):
  `node ~/src/mola-dsh-stack/superagent/configure.mjs --port 3082 --repo Ephemeral-AI-Lab/layerfs --clone ~/src/layerfs --allow Mola-maker`
  (exit 3 = some Source still needs an operator step; its message says which).

## Hourly check

Create it here with the schedule tool, hourly, with this prompt (both bots):

```text
Check the dsh-superagent bots with the superagent-ops skill. For each of superagent-layerfs (3082) and superagent-cad2gis (3083), run its `status` in WSL. Exit 0: say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Exit 1: run `--respect-stop restart`; 0 means it recovered, say nothing; otherwise read the newest log in ~/src/dsh-superagent/.artifacts/ and tell me what was wrong.
```

Never enable auto-merge, change the accept mode from `observe` to `auto`, or widen the allowed list unless the user asks for it.
