# m-team on DSH's native team tools

Read this when running inside DeepSeek Harness with the opt-in preset `dsh/mstack-team/` active (check with `list_agents`: team members appear, and `spawn_teammate` is in your tool list). Tool names and the isolation trap are listed in m-dispatch's `references/dsh-native.md`; this file maps m-team's steps onto them. The mapping comes from the DSH docs and schemas and has not been run end to end.

## Mapping, one row per m-team step

| m-team step | DSH-native action |
|---|---|
| Set up the run | Lead calls `create_goal`: objective, noise band, stop rules, `max_goal_rounds` = round cap. |
| Design the team | Lead writes `v<N>.md`. Each role becomes one `team_task_create`: `subject` = duty, `write_scopes` = the files it may change, `blocked_by` for pipeline order. |
| Dispatch the round | `spawn_teammate` per role with `context: fresh`, name `m-implementer-<role>` or `m-explorer-<role>`, and a prompt that names its task id. Code roles get a worktree the lead created and a path in the prompt. |
| Solo baseline | One `subagent` whose `cwd` is its own worktree, which the lead created first. Never the lead's cwd, a teammate, or a `workflow` `agent()` (they share the lead's tree). The mstack preset keeps `subagent`. Only on the stock agent-team profile, which hides `subagent`, fall back to a `workflow` `agent()` told to work in a worktree the lead made, and say so in `history.md`. |
| Wait | `wait_agent`, then `team_task_list`; repeat until every task is `completed`. If it returns `noProgress`, `list_agents`, `send_message` to each inactive required member, then wait again. |
| Coordinate | Artifacts on disk; `team_task_update` with `expected_revision` for status. A teammate's message is never evidence. |
| Score | A `workflow` with `agent(prompt, {schema, provider})` over the labelled packet, `provider` a magpie route from a family no candidate used. The schema is the verdict contract (score, gate results). |
| Supervise | Lead only, per `supervisor-checklist.md`; writes `history.md` and `LEARNINGS.md`. Teammates do not write them. |
| Next round or stop | `update_goal` complete or blocked. A goal round is one team round; blocked is accepted only after 3 rounds. |
| Supervisor cadence | `schedule_create` with `target=this_session` (RRULE) to wake the lead. Subagents cannot call it. |

## Limits that bite

- Shared cwd: every teammate sees the lead's working tree. `write_scopes` warns but does not lock. After each round compare `git status` to the scopes you gave; a file outside a role's scope voids that candidate.
- A failed or inactive teammate keeps its task claimed. Reassign with `team_task_update` (`reassign` or `release`) before waiting on it.
- Messages are neither retried nor deduplicated. A send that returned means "accepted"; the teammate may not have read it.
- Flat roster: only the lead creates members; teammates cannot spawn. Names cannot be changed or reused.
- The package is marked experimental with no stability promise, and its docs disagree on defaults (member cap 8 in the profile patch against 16 in the README). Pinned version and checks: `dsh/mstack-team/README.md`.
- Metric noise, "two rounds without gain" and the solo comparison are not DSH primitives. They stay in `history.md` and the goal's objective text, judged by the lead.

## Without the preset

If `spawn_teammate` is not available, run roles through `subagent` (with cwd) or one `workflow` per round, as in `m-dispatch`. Everything in m-team's Procedure still holds; only the tool names change.
