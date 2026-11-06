# Critic brief (m-plan)

Read this at m-plan step 8, before dispatch. Send this file plus the spec and the plan to one fresh reviewer. The reviewer returns text only and does not edit the plan. One pass — do not start a second round, and do not turn this into a multi-round debate.

## Reviewer instructions

You are checking an implementation plan against its spec. You did not write either. Do not rewrite the plan into the one you wish existed. Return the four blocks below, in this order.

### 1. Assumptions

List every assumption in the spec's Assumptions section, plus any further assumption the plan relies on (a library, a file layout, an unstated caller). Rate each one:

- **VERIFIED** — you checked it against the spec or the repo and can point to a file:line or a command you ran.
- **REASONABLE** — nothing you checked contradicts it, and a wrong guess is cheap to reverse.
- **FRAGILE** — the plan depends on it, and you could not check it, or the spec and the code disagree. Say what breaks if it is wrong.

Do not invent rows to fill the table. If there are no assumptions, write "none".

### 2. Shape

If the plan includes two or more interface sketches for a new module boundary or a public type, pick one. Name the structural difference that decided it, and what the rejected shape did better. One short paragraph — the planner pastes it into Review Focus.

A sketch only counts if it stays an interface (names, signatures, ownership, callers) and is ≤15 lines. A task list is not a second shape.

If the plan adds a module boundary or a public type and only one qualifying shape is present, file a Critical finding. If no new boundary or public type is involved, write "n/a".

### 3. Pre-mortem

Write exactly three scenarios in which this plan gets implemented and then fails. Each one names a concrete trigger, what breaks, and how someone would notice. Map each scenario to an existing task (by its name) or to one Review Focus line (quote it).

If you cannot map a scenario, file a finding that proposes the missing Review Focus line. An unmapped scenario means this block is not finished.

### 4. Findings

Sort as Critical / Important / Note.

- Critical: stateful or concurrent behavior (state machine, lock, watcher, retry, shared mutable state) with no `## 状态与不变量` section; fewer than 3 invariants; an invariant with no test name; a step a fresh implementer could satisfy in two different ways; a spec requirement with no task; a new boundary with only one shape.
- Important: more than 5 invariants where the extras are vague padding; a named test that is not a step in any task; a pre-mortem scenario you had to invent a Review Focus line for.
- Note: anything real that does not block execution.

When `## 状态与不变量` is present, check that it lists states, allowed transitions, and 3–5 invariants, and that each test name appears as a step. Do not demand this section for work with no state and no concurrency.

Do not drop a spec requirement to make the plan look finished. Do not schedule a follow-up review.
