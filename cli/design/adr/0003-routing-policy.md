# ADR-0003: Routing policy — two-level routing, magpie owns models, quota failures are first-class

- Status: proposed
- Date: 2026-11-06
- Inputs: `cli/design/BRIEF.md` (constraints 3, 7), `inputs/magpie-help.txt`, `magpie-routes.txt`,
  `magpie-agents.txt`, `inputs/01-topology.md`, `inputs/03-llm-gateway.md`,
  `skills/m-dispatch/references/harness-commands.md`, `FRAMEWORK.md` §6.

## Context

`mola` must decide, for each task: **which agent, on which machine, in which workspace, with which
model route**. The hard constraints: magpie owns every agent's model list and rewrites drifted
configs (~15 s), so any routing that edits agent configs is fighting magpie and will lose. The
machine fleet is mostly offline (`01-topology.md`: only main, jlu-pc, muse reliably online), so
"machine availability" is a real input, not a nicety. And quota failures are not exceptional: a
DeepSeek **402 on a direct route kills every worker in a fleet at once** (observed, recorded in
harness-commands.md and FRAMEWORK §6).

## Decision

### 1. Two-level routing

1. **mola picks: agent + machine + workspace.** It scores candidates from adapters' detected
   capabilities, machine probes, and the task kind.
2. **magpie picks: the model.** mola passes only a *route id* (`group/smart-split`,
   `auto/kimi-k3`, …) — via `magpie <agent> <route>` for persistent choice, or the agent's per-run
   model flag / dsh `--patch` overlay for per-run choice. mola never names a raw provider model for
   a headless worker and never edits a config file.

### 2. Policy file

`~/.mola/policy.yml` (user-editable; a repo may add `.mola/policy.yml` that mola merges under it):

```yaml
version: 1
defaults:
  budgetUsdPerRun: 2.00
  permissionProfile: workspace-write     # read-only | workspace-write | full-auto | plan
  approval: interactive                  # interactive | batch-approved
routes:
  byTaskKind:
    implement: { agents: [dsh, claude, codex], route: group/smart-split }
    review:    { agents: [codex, claude], route: auto/claude-sonnet-5-5, differentFromWriter: true }
    research:  { agents: [dsh], route: group/smart-split }
    debug:     { agents: [claude, dsh], route: group/smart-split }
    plan:      { agents: [claude, kimi], permissionProfile: plan }
    ship:      { agents: [claude], approval: interactive }
machinePreference: [local, wsl:Ubuntu, jlu-pc]   # tailscale names; offline ones are skipped
modelRoutes:
  allowedHeadless: ["group/*", "auto/*"]          # glob whitelist
  bannedHeadless:  ["deepseek/*"]                  # 402 blast radius — see §4
fallback:
  onQuotaFailure: [retry-same-route-once, magpie-quota-wait, switch-route, switch-agent, report]
  alternateRoutes: [auto/kimi-k3, auto/gemini-3.8-flash, group/claude-cheap]
isolation:
  codeChange: worktree            # worktree | layerfs | shared | cloud
```

### 3. Scoring

For a `RouteRequest`, the router filters then scores:

```ts
function route(req: RouteRequest, world: WorldState): RouteDecision {
  const candidates = world.agents
    .filter(a => a.health === 'ok' || a.health === 'degraded')
    .filter(a => hasAll(a.capabilities, req.requiresCapability ?? {}))
    .filter(a => world.machines[a.info.machine]?.online)
    .filter(a => !req.prefersAgent || a.info.id === req.prefersAgent);

  const ranked = candidates.map(a => ({
    a,
    score:
      w.kind   * kindAffinity(req.taskKind, a.info.id) +      // e.g. dsh: great at implement fleets
      w.cost   * cheapness(world.quotaFor(a)) +               // from `magpie quota --json`
      w.model  * routeFit(req, world.routesVisibleTo(a)) +    // route must be in the agent's visible set
      w.machine* machineRank(a.info.machine, policy.machinePreference) -
      w.fail   * recentFailures(a.info.id),                   // decayed failure memory, .mstack/routing-state.json
  })).sort((x, y) => y.score - x.score);

  const best = ranked[0];
  const modelRoute = pickRoute(req, best.a, policy);          // whitelist-enforced
  return {
    agent: best.a.info.id,
    machine: best.a.info.machine,
    workspaceDir: yield makeWorkspace(req.workspace),         // tool-git / tool-layerfs / agent -w flag
    modelRoute,
    fallbacks: ranked.slice(1, 3).map(r => ({ agent: r.a.info.id, modelRoute: pickRoute(req, r.a, policy) })),
    reason: explain(best),
  };
}
```

Inputs, concretely: task kind (from the wrapping skill, §5 of the section doc), budget, capability
requirements, machine availability (`tailscale status` probe + adapter `detect()`), quota
(`magpie quota --json`), failure memory. Output: agent + machine + workspace + model route +
fallback chain + a one-line `reason` logged to `.mstack/runs/<id>/decision.json`.

### 4. Quota failures are first-class

Adapters normalize provider errors into `QuotaFailure { provider, route, status, retryAfterSec? }`
(DeepSeek 402, Claude 429/rate-limit, …). Recovery ladder, in order, each step logged:

1. **Retry once** on the same route (transient).
2. **`magpie quota wait <provider|account> --timeout <d>`** — block until the window resets;
   for Claude accounts, `omc wait` does rate-limit wait + auto-resume.
3. **Switch route** within the same agent: re-issue the run with the next `alternateRoutes` entry.
   This is the tested pattern from harness-commands.md: on `QUOTA: 402`, list the files workers
   already wrote and re-dispatch **only the remainder** on a different magpie route.
4. **Switch agent/machine**: take the next entry of the decision's `fallbacks`.
5. **Report**: if the ladder is exhausted, stop and report — per principle 9 (same error 3× → stop).

Additionally, at the magpie layer, `magpie provider fallback <id> <provider/model>…` is configured
once by the human (not by mola) so a drained provider degrades gracefully for *interactive* use too.

### 5. Safety coupling

`permissionProfile: full-auto` or any outward action (push, PR, publish, message) requires
`approval: batch-approved` in the request or an interactive confirmation at the gate. The router
refuses to emit such a decision otherwise (constraint 7). Budget: only claude has a native cap
(`--max-budget-usd`); for other agents the router enforces budget by sampling `magpie usage` and
terminating the run — a declared approximation, not a hidden one.

## Alternatives considered

- **mola routes models itself** (per-provider registry, own fallback logic). Rejected: duplicates
  magpie, fights its config ownership, and loses its quota/account machinery (`quota wait`,
  `accounts switch`, provider fallback).
- **Static table routing** (task kind → one agent, no scoring). Rejected: cannot react to offline
  machines or quota failures, which are the common case on this fleet.
- **Always-cheapest routing.** Rejected: `review`/`ship` need strong models; cost is a weight, not
  the objective.

## Consequences

- B1 can ship the filter+score core with only local + WSL candidates and still be useful.
- The banned-route list makes the 402 fleet-kill structurally impossible for headless workers.
- Failure memory (`recentFailures`) gives the 3-strike rule a machine-enforced form.
- New machines/agents join routing by adding an adapter + a policy row; no core changes.
- Risk: route ids in policy can drift from magpie's actual groups; `mola doctor` validates
  `allowedHeadless` and every policy route against `magpie groups` / `magpie models` output.

## References

- [magpie gateway/quota mechanics — local help capture](../inputs/magpie-help.txt)
- [Tested quota-failure recovery pattern](../../../skills/m-dispatch/references/harness-commands.md)
- Section doc: [adapters-routing.md](../sections/adapters-routing.md) §4
