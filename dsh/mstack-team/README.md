# mstack-team — optional DSH preset for m-team

Turns on DeepSeek Harness's experimental Agent Teams tools so `m-team` can use native roles and a shared task board. It is opt-in: mstack works without it, and nothing in mstack installs it for you.

## What it does

Adds three plugins from the DSH experimental agent-team packages: the team domain, the tool set (`spawn_teammate`, `wait_agent`, `team_task_create` / `_get` / `_list` / `_update`, and team versions of `send_message`, `list_agents`, `interrupt_agent`) and the Web roster UI. Settings are copied from DSH's own `agent-team-profile`: 8 members, 256 tasks, 64 KiB per message.

## What it deliberately does not do

DSH's stock profile disables `subagent`, `subagent_fork` and the child controls for the whole profile. This preset disables **only** `tool-subagent-control`, the one plugin whose tool names (`send_message`, `list_agents`, `interrupt_agent`) collide with the team tools. `subagent` stays, because it is the only delegation tool with a `cwd`, and m-dispatch needs that to put code-changing children in separate worktrees. It never turns `subagent` off globally.

Cost of that choice: the team versions of the three shared names replace the child-control ones, so a `subagent` follow-up message uses the team `send_message` (`target`, not `agent_id`). Verify this in step 3 below before relying on it.

## Version pin

Pinned to `0.2.2-alpha.2` of the three packages (the version in the DSH checkout read on 2026-11-06). The package describes itself as an experimental prototype with no stability promise, and its upgrade guide has already changed `send_message`'s return value and removed a config key. On any DSH upgrade, re-read the agent-team README and re-run the smoke test; do not bump the pin blind.

## Install (per profile; not run)

Use DSH's plugin manager against a profile you can afford to break; every action there affects all sessions of that profile and asks for approval:

```
plugin_manager action=install_bundle target=<path to this directory>
```

Check the result reports `application: applied` (`restart-required` means it is not active yet). To remove it, `plugin_manager action=remove_bundle` for the same target. The install form for a local path was not checked in this round; if DSH rejects it, publish the folder as a package or copy `cordis.patch.yml` into a profile patch.

## Smoke test (run once before trusting it)

1. `list_agents` shows the lead, and your tool list has `spawn_teammate` and `team_task_create`.
2. `subagent` with a `cwd` still works: spawn one child that runs `pwd` and returns it.
3. Spawn one teammate (`spawn_teammate`, name `m-explorer-test`), create one task with `write_scopes`, `wait_agent`, then `team_task_list` shows it `completed`.
4. Send a follow-up to the `subagent` child and to the teammate; note which argument names each accepted.

If step 2 fails, the preset is not safe for m-dispatch; remove it and use the default tool set.

## Use

Load `m-team`. Its DSH notes and `references/dsh-team.md` map each step onto these tools. Teammates share the lead's working directory: have the lead create worktrees for code roles and put the path in each prompt. The m-team solo baseline runs through `subagent` with its own worktree `cwd` (this preset keeps `subagent` for exactly that); it never runs in the lead's cwd.
