# DSH-native dispatch (m-dispatch, m-team)

Read this when running inside DeepSeek Harness. Source: research/round3/dsh-team.md (read from the DSH docs and schemas; the script below has not been run in DSH, so run it once on a toy input before you trust it).

## Two tool sets that differ in delegation tools

| Mode | Delegation tools | Cwd per child |
|---|---|---|
| Default DSH | `subagent`, `subagent_fork`, `subagent_claude_code`, `subagent_codex`, `workflow` | `subagent` takes `cwd` |
| Agent-team preset (opt-in, `dsh/mstack-team/`) | `spawn_teammate`, `wait_agent`, `team_task_*`, plus team `send_message` / `list_agents` / `interrupt_agent`; `workflow` and `subagent` stay | `subagent` takes `cwd`; teammates and `workflow` have none |

`send_message`, `list_agents` and `interrupt_agent` exist in both sets with different arguments (`agent_id` versus `target`). Call `list_agents` first to see which set this session has; do not mix their arguments. DSH's stock agent-team profile disables `subagent`; the mstack preset keeps it (see `dsh/mstack-team/README.md`).

## Team-mode tools

- Roles: `spawn_teammate(name, description, prompt, context: fresh|fork)`; the lead only; name is lowercase kebab and fixed. Name teammates `m-implementer-<slice>` or `m-explorer-<slice>`.
- Task board: `team_task_create(subject, description, blocked_by, write_scopes)`, `team_task_list`, `team_task_update(action, expected_revision)`. `write_scopes` is advisory, not a lock; treat it as the file-ownership table and check it against `git status`.
- Waiting: `wait_agent(timeout_ms)` returns `noProgress` at once if nobody else runs. Wake an inactive teammate with `send_message` first. Re-list after every wake.
- Rounds: `create_goal` with `max_goal_rounds`; `update_goal` complete or blocked (blocked needs 3 rounds). One goal round is one m-team round.
- Wake-ups: `schedule_create` with `target=this_session`. Subagents cannot call it.
- Task owners are not released when a teammate fails. Check `team_task_list` and reassign.

## The isolation trap

Teammates and workflow `agent()` calls run in the lead's cwd. They have no `cwd` argument, no worktree, and no file lock. Two of them editing the same tree collide silently.

- Edits that need isolation go to `subagent` (it takes `cwd`), or
- the lead creates the worktree first (`git worktree add ../<repo>-<task> -b agent/<task>`) and writes its absolute path into the prompt with the instruction to run `pwd` and stop if it differs.
- Read-only work (m-explorer) can share the cwd safely.
- If this profile is the stock agent-team one and `subagent` is hidden, say so and run code-changing slices one at a time instead. The solo baseline of m-team is such a slice: it needs its own worktree.

## Workflow template

For one shape applied to N items. `args.roles` is a list of `{name, prompt}`; worktrees were created by the lead and their paths are in the prompts. `provider` must be a magpie route.

```js
phase('dispatch');
const RESULT = {
  type: 'object',
  properties: {
    status: { enum: ['done', 'blocked'] },
    files: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'string' },
  },
  required: ['status', 'files', 'evidence'],
  additionalProperties: false,
};
const results = await parallel(args.roles.map(r => () =>
  agent(r.prompt, { label: r.name, phase: 'dispatch', schema: RESULT })));
const gaps = results.map((x, i) => (x ? null : args.roles[i].name)).filter(Boolean);
phase('verify');
const VERDICT = {
  type: 'object',
  properties: { verdict: { enum: ['APPROVE', 'REQUEST CHANGES'] }, reason: { type: 'string' } },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};
const verdicts = await pipeline(
  results.filter(Boolean),
  (prev, item) => agent(
    `Review this result without knowing who wrote it: ${JSON.stringify(item)}`,
    { label: 'verify', phase: 'verify', provider: args.verifierProvider, schema: VERDICT }));
return { gaps, results, verdicts };
```

- The `schema` is the RETURN contract. `null` from `agent()` is a gap; count it, re-run that role once, and do not fill it in. Allowed schema keywords: type, properties, required, additionalProperties, items, enum, const, oneOf.
- `parallel` waits for all; `pipeline` has no barrier between stages. There is no race hook, so a `first pass` rule is done by counting inside a `pipeline` stage or by choosing by hand.
- The verifier family comes from `references/model-routing.md`, passed in as `args.verifierProvider`.
- The script has no filesystem, network or timers. Everything it needs comes through `args`.
- Per-run caps exist (`maxTotalAgents`, default 1000; concurrency about `min(16, cores-2)`), and the default child depth is 1: a child cannot spawn children.

## Known doc conflict

`send_message` return shape differs between DSH docs (a message id in some, `{ "sent": true }` in the generated catalog). Trust the catalog and treat the return value as "accepted", not "read".
