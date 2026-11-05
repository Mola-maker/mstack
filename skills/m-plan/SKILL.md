---
name: m-plan
description: "Turn an approved design into an ordered plan of verifiable steps, then have an independent critic review it before execution. Use when ready to plan before coding, or on \"拆解/定计划/先规划\"."
whenToUse: "When a design spec exists (from m-think) or a detailed request is ready, and you need a step-by-step, independently-checked implementation plan."
---

# m-plan — 把设计拆成可验证的步骤

m-plan turns a spec into a plan a fresh engineer (or agent) can execute without re-asking the user: exact files, names, signatures, testable steps, and a per-step "how to verify". A separate critic (a different model or agent) then checks the plan before anything runs.

## When to use / not use

Use when `m-think` has produced an approved spec, or the request is detailed enough to skip thinking and go straight to planning. Do not use when the design is not yet agreed (return to `m-think`), when the task is a single focused fix (delegate directly or use `m-debug`), or when the goal is a long-running loop rather than a bounded plan (use `m-goal`). For reviewing an existing plan without planning, use `m-review`.

## Procedure

1. **Read the spec and the ground.** Read the spec (the binding authority), then map the codebase with Read/Grep/Glob so every task cites real files. Note the spec's global constraints.
2. **Size the tasks.** One task = the smallest unit that ends in an independently testable deliverable and is worth a reviewer's separate gate. Fold setup/scaffolding/docs into the task whose deliverable needs them. Each step is one action with a checkable result: write failing test → run it (see it fail) → implement minimally → run it (see it pass) → commit.
3. **Write the plan.** For each task give Files (create/modify/test paths), Interfaces (what it Consumes and Produces with exact signatures), and numbered steps. Test steps carry the test name and exact spec values; verification steps carry the exact command and the output that means pass. A step must let the implementer write exactly one reasonable thing — no "TBD", "handle edge cases", or "add validation".
4. **Add a Review Focus section.** List the 5 input classes or failure modes the spec implies but no task's tests yet exercise, each with a line naming the condition and expected behavior, most likely to bite first; pin a test for each to the owning task.
5. **Self-review.** Check spec coverage (every requirement → a task), step scan (each step unambiguous and nothing more), type/name consistency across tasks, and proportion (a plan much longer than the spec is a transcript, not a plan). Fix inline.
6. **Independent critic pass.** Dispatch one fresh reviewer (another model or `m-dispatch` agent — the author must not self-review, principle 6). It checks the plan against the spec, flags gaps and weak steps. Sort its findings; fix Critical/Important, rule on the rest and record each ruling.
7. **Hand it off.** Present the plan and ask the user to confirm it captures the intent, then hand the approved plan to `m-dispatch` (subagent-driven execution) to run.

Save to `.mstack/plans/<YYYY-MM-DD>-<slug>.md` with `- [ ]` checkboxes for tracking, marking status as each task completes.

## Output

`.mstack/plans/<YYYY-MM-DD>-<slug>.md` containing header (goal, architecture, tech stack, spec path), Global Constraints, Review Focus, and tasks with Files/Interfaces/checkbox steps. Report to the user: the plan path, the critic's verdict, and the rulings you made.

## Stop conditions

Stop for approval before execution (planning never mutates code). Stop and return to `m-think` if the spec has gaps no task can cover. Ask only for a choice that is a genuine trade-off; settle reversible choices yourself and record them. If the critic and author cannot agree after one fix round, surface the disagreement to the user rather than looping.

## Harness notes

- Claude Code: dispatch the critic via `Agent`/`Task(subagent_type=...)` on a different model; DSH uses `subagent`/`subagent_fork`; Codex uses `codex exec` to a second model.
- In DSH `todo_write` tracks the plan's tasks; in code-first runs use the plan's own `- [ ]` checkboxes.
