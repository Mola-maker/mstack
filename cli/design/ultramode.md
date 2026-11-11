# mola-ultramode — design (draft, 2026-11-11)

Status: approved 2026-11-11 ("按设计开工"). Building on branch
`feat/mola-ultramode`; this file is the spec the build follows.

Evidence: `ultramode-cli-map.md` (CLI architecture spike, read-only, all
line numbers verified against the checkout) and
`frontierharness-live.md` (FrontierHarness Kimi K3 board recomputed from
`results/eval-data.json`; the live board's 21-harness numbers are not
retrievable, no public endpoint exists).

## 1. Goal

`mola-ultramode` is a new mode inside the `mola` CLI, modeled on
poteto-mode. One goal in, routing, review, interrogation, and shipping out.
It is the mode for long, high-stakes work that must survive unattended runs
without losing evidence, reviewer independence, or the approval boundary.

Interpretations the user has not corrected yet, recorded as assumptions:
RSI means recursive self-improvement (search a round, interrogate a round,
feed the result into the next round). Grilling applies to both sides: the
AI's output and the human's assumptions in the goal itself.

## 2. Non-goals

- No new core primitive. The CLI has no "mode" concept, and ultramode does
  not add one. It is a command plugin plus policy hooks plus KV state.
- No `--yes` as approval. No whitelist bypass, ever. The whitelist is
  structural: magpie owns the models, mola only names route ids.
- No merge without the user. The mode ships a PR and watches CI. It never
  merges.
- No re-implementation of routing. `cmd-run`'s `prepareRun` / `executeRun`
  is the router. The mode reuses it.
- No prompt-only gates. A skill telling the agent to review is not a gate.

## 3. Shape

New package `cli/packages/plugins/cmd-ultramode/` with `mola-plugin.json`
(`kind: "command"`, `provides: ["cmd:ultramode"]`). Registration points,
all verified in the map:

1. Add the package to `BUILTIN_PLUGIN_PACKAGES` in
   `cli/packages/mola/src/bin.ts:25`.
2. In `activate()`, `ctx.commands.register({ path: ["ultramode"], … })`
   (needs the `commands` capability).
3. In `activate()`, `ctx.events.hook("mola.task.pre-dispatch" |
   "mola.tool.before" | the new gates in §5, …)` (needs `events`).
4. Mode bookkeeping in `ctx.state` KV (`~/.mola/state.*`, needs
   `state.kv`). Goal, team, and run evidence in `.mstack/` under the
   workspace, at paths owned by the skills that own them (never invented
   by the mode).

Route precedence stays as-is: `--route` flag, then policy
`routes.byTaskKind` row, then `model-routing.json` picks, then policy
default. The quota ladder stays as-is: retry same route, `magpie quota
wait`, switch route, switch agent, report.

## 4. Triggers (the poteto-mode pattern: non-negotiables)

- No claim without fresh evidence. `m-verify`: run the real test, read the
  real output, test behavior not implementation.
- Reviewer is never the writer. Enforced at the gate (§5), not only in the
  skill prompt. The policy schema flag `differentFromWriter` is the knob.
- Same error 3 times: stop, change approach. This matches the bus
  death-loop brake (3 consecutive failures quarantines the plugin), so the
  mode must never loop a denial.
- Closeout on every exit path. `m-goal`: any exit writes the closeout.
- No outward action without a recorded grant plus the `mola.tool.before`
  waterfall (§6). Outward actions: `git push`, `gh pr create`, `publish`.
- The whitelist is never bypassed and never loosened by the mode. A repo
  layer may tighten it, never loosen it.

## 5. Review environment (CLI-enforced gates)

Review and verification today are prompt-level skills. `cmd-run` never
calls `mola.tool.before`, so outward actions inside a routed agent bypass
the classifier entirely. I verified this myself: the only waterfall call
in `cmd-run/src/index.ts` is `TaskPreDispatch` at line 640, and
`mola.tool.before` appears in `cmd-dispatch` only.

The mode adds two new waterfall gates in the plugin-sdk event vocabulary
(`cli/packages/plugin-sdk/src/events.ts`):

- `mola.ultramode.review`: inspects evidence files before anything ships.
  Required evidence: `.mstack/reviews/<id>.md` (reviewer named, different
  from writer), the test/check output it cites, and `decision.json` for the
  run. Missing or failing evidence denies the ship. The gate reads files,
  it does not trust a prompt's claim that a review happened.
- `mola.ultramode.ship`: runs immediately before an outward action. It
  checks the recorded grant (§6) and invokes `mola.tool.before` itself
  with the exact argv, because `cmd-run` does not call that gate.

Review-file schema (minimal, unit 3): the file is
`.mstack/reviews/<slug>.md` and the gate parses it, never trusting a
prompt's claim. It must carry a `Reviewer: <name>` line, the last
non-empty line must be the verdict `APPROVE` (`REQUEST CHANGES` or a
missing verdict denies), the reviewer must differ from the writer (the
agent from the goal's last outcome; when no outcome exists the check is
skipped, since sameness cannot be proven), and it must cite evidence: a
`repro: <command> → <output>` line, a backticked test command, or a
`.mstack/` file path. Any failure denies with a specific reason, and a
denial is a stop, not a retry: the mode records the outcome, writes the
closeout line, and returns 77.

After a PR is created, the mode polls `gh pr checks`. A failed check blocks
the "shipped" verdict. A blocked verdict is reported, not retried in a
loop, and never auto-merged.

## 6. Shipping and the approval model

There is no sanctioned approval concept for unattended shipping in the
repo. `--yes` is the only classifier bypass, and the route whitelist cannot
be bypassed at all. The gate-request / remote-approve flow that would grant
unattended approval is B5/B6 collab work. So ultramode defines its own
grant, scoped and recorded:

- A grant is per goal and per workspace. It is recorded in `~/.mola/state`
  via `ctx.state` (machine-local, revocable), with the traceId that granted
  it. A policy row in `.mola/policy.jsonc` may also carry it for a repo.
- With a grant, the mode pushes, opens the PR, and watches CI.
- Without a grant, the mode stops at a prepared PR: branch pushed
  nowhere, PR body written, and it says so. Preparation without push is
  the safe default.

How `yes` reaches the classifier (unit 3): the ship gate sets `yes: true`
on the `mola.tool.before` value only when its own recorded grant exists
for that goal and workspace. It never reads `io.yes`, so `--yes` without
a grant still denies. On success the mode emits `mola.approval.granted`
with approver `ultramode-grant:<traceId>` — the traceId that granted it —
so the bus record names the grant as the real authority instead of
"--yes". `mola ultramode ship --check <slug>` exercises both gates with
a sample `gh pr create` argv and reports pass or the denial reason,
without any outward action.
- The ship gate never denies three times in a row. A denial is a stop
  condition: record it, write the closeout, stop. Repeated denials would
  trip the bus brake and quarantine the mode's own policy plugin.

## 7. Routing (FrontierHarness evidence)

Routing decisions come from `frontierharness-live.md`. The Kimi K3 board
(9 harnesses, 12 configurations, 30 tasks, 360 runs, one model):

- Route on effective cost per pass, not on raw pass rate. Pass rates span
  1.33x (66.7% to 50.0%) while effective cost per pass spans 17.5x ($1.05
  to $18.34). Claude Code and DSH Creator tie at 63.3% pass rate, but
  Claude Code costs $18.34 per pass against $3.28 for DSH Creator.
- Default route is DSH Creator class: 63.3% pass rate, $3.28 per pass,
  84.3% cache hit, 6m 44s median duration. No other configuration beats it
  on quality and cost at once.
- Cache behavior is the lever, not token counts. Field-weighted cache is
  92.4%; Claude Code sits at 67.8% on the same model. The mode preserves
  prefix cache across steps and runs, and measures cache-hit rate per run.
- Cap turns. Codex took 62.4 mean turns and 4.7M mean input tokens per
  task against OpenCode's 11.2 turns and 153K tokens, yet finished only 5
  tasks ahead. Turns, not tokens, are the cost driver to watch.
- Metric care: the website labels effective cost per pass as "median cost
  per task", but it is not a median. For Codex the true median cost per
  task is $0.23, not $3.47. The two numbers answer different questions.
  Routing prices the pass with the first and budgets the task with the
  second. OpenCode's $0.06 median success cost counts successes only and
  is a trap: once failures are paid for it costs $3.24 per pass at 50.0%.

## 8. Interrogation (grill)

Two sides, one stage, before any ship:

- AI side: multi-model adversarial review, the pstack interrogate / arena
  pattern. Two routes argue the plan or the findings; a third judges.
  Every claim is checked against evidence (`m-verify`); a claim without a
  cited file, line, or test output does not survive.
- Human side: the mode grills the goal statement itself. It attacks the
  premises (m-think), asks at most 3 questions with recommended defaults,
  and records the human's answers and assumptions in the goal file as
  attackable premises, not as settled facts.

## 9. RSI search (recursive self-improvement loop)

Rounds: search, then interrogate, then refine the goal or plan, then search
again. Each round writes its evidence under `.mstack/`:

- Search uses m-researcher: at least 3 independent channels in parallel,
  deduplicated and cross-validated, every key claim sourced.
- Interrogation is §8, applied to the round's findings.
- Refinement rewrites the goal file or the plan, and the rewrite is itself
  recorded as evidence.

Stop predicate, whichever hits first: evidence saturation (a round adds no
new finding), a round cap, a budget cap, or the m-goal stop conditions.
Counters live in `.mstack/goals/<slug>.state.json`.

## 10. mgoal loop

The mode runs the m-goal loop for the whole task. Goal file
`.mstack/goals/<slug>.md` holds the objective, sub-goals, checkpoints, and
a `## Closeout` section. The state file holds loop counters. Every exit
path, including a stopped loop and a denied ship, writes the closeout.

## 11. Rulings on the spike's 3 unknowns

1. Design-vs-source drift: the source is authoritative. `cmd-run` exists
   in the bin's builtin list and registers `run` plus six skill commands.
   Ultramode builds on it as stable. The README's B1 status (11 plugins,
   no `cmd-run`) and the DESIGN text (`mola run` debuts B2) are stale; the
   doc fix is a separate item, not part of the build.
2. Approval for unattended shipping: the scoped recorded grant in §6, not
   `--yes`. No grant means a prepared PR only.
3. Prompt-level review: fixed by the CLI-enforced gates in §5 plus the
   mode invoking `mola.tool.before` itself, plus the CI poll. Prompts
   alone are not gates.

## 12. Rollout (atomic units, riskiest first)

1. Skeleton command plugin: registers `ultramode`, `--help`, the `--json`
   envelope, exit codes. Design doc moves to `cli/design/ultramode.md`.
2. Routing and state: reuse `prepareRun` / `executeRun`, the
   FrontierHarness default route, `ctx.state` bookkeeping, the `.mstack/`
   goal file.
3. Review gate and ship gate: evidence inspection, self-invoked
   `mola.tool.before`, the grant model. The dangerous part lands before
   the nice parts.
4. Shipping: push, `gh pr create`, CI poll, prepared-PR fallback.
5. RSI search and interrogation loop: rounds, stop predicate, arena
   judging.
6. Verification: `node scripts/check.mjs` OK, `pnpm -r build` and
   `pnpm -r test` green, one real task driven end to end through
   `mola ultramode` in a scratch repo, independent review by a different
   agent, PR opened, no merge.

## 13. Open questions (not blocking the design)

- RSI and grill-the-human are my readings of the user's words. If either
  means something else, the design changes in §8 and §9 only.
- Whether the DESIGN / README drift fix (unknown 1) should ride along
  with this build or stay separate.
