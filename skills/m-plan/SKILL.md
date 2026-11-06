---
name: m-plan
description: "Turn a design into ordered, verifiable steps with an independent critic pass. Use before coding, 拆任务/做计划/先规划."
whenToUse: "When a design spec exists (from m-think) or a detailed request is ready, and you need a step-by-step, independently-checked implementation plan."
---

# m-plan — 把设计拆成可验证的步骤

m-plan turns a spec into a plan a fresh engineer (or agent) can execute without re-asking the user: exact files, names, signatures, testable steps, and a per-step "how to verify". A separate critic (a different model or agent) then checks the plan before anything runs.

## When to use / not use

Use when `m-think` has produced an approved spec, or the request is detailed enough to skip thinking and go straight to planning. Do not use when the design is not yet agreed (return to `m-think`), when the task is a single focused fix (delegate directly or use `m-debug`), or when the goal is a long-running loop rather than a bounded plan (use `m-goal`). For reviewing an existing plan without planning, use `m-review`.

## Procedure

1. **Read the spec and the ground.** Read the spec (the binding authority), then map the codebase with Read/Grep/Glob so every task cites real files. Note the spec's global constraints.
2. **Two shapes, when the boundary is new.** If this work adds a module boundary or a public type, write at least two shapes that differ in structure, not two edits of one shape. Each shape is an interface sketch only (≤15 lines): names, signatures, who owns the data, who calls whom. Put them under `## Shapes` and do not expand them into tasks yet. Skip this step when you are only filling in an existing boundary.
3. **Size the tasks.** One task = the smallest unit that ends in an independently testable deliverable and is worth a reviewer's separate gate. Fold setup/scaffolding/docs into the task whose deliverable needs them. Each step is one action with a checkable result: write failing test → run it (see it fail) → implement minimally → run it (see it pass) → commit. The new test file is required. m-verify's anti-cheat gate flags a modification or deletion of an existing test, fixture, conftest, grader, or CI config — never a new test.
4. **Write the plan.** For each task give Files (create/modify/test paths), Interfaces (what it Consumes and Produces with exact signatures), and numbered steps. Test steps carry the test name and exact spec values; verification steps carry the exact command and the output that means pass. A step must let the implementer write exactly one reasonable thing — no "TBD", "handle edge cases", or "add validation".
5. **State and invariants, when behavior is stateful.** If any task touches a state machine, lock, watcher, retry loop, or other shared mutable state, add `## 状态与不变量` before the tasks: the states, the allowed transitions, and 3–5 invariants. Each invariant names the test that checks it. Do not send the plan to the critic without this section.
6. **Add a Review Focus section.** List the 5 input classes or failure modes the spec implies but no task's tests yet exercise, each with a line naming the condition and expected behavior, most likely to bite first; pin a test for each to the owning task. If step 2 ran, leave both sketches in the plan and leave a blank line for the choice; step 8 fills that line.
7. **Self-review.** Check spec coverage (every requirement → a task), step scan (each step unambiguous and nothing more), type/name consistency across tasks, and proportion (a plan much longer than the spec is a transcript, not a plan). Fix inline.
8. **Independent critic pass.** Read `references/critic.md` and send it, with the spec and the plan, to one fresh reviewer (another model or an `m-dispatch` agent — the author must not self-review, principle 6). One pass. It rates assumptions, picks a shape if step 2 ran, and returns a 3-scenario pre-mortem. Sort its findings; fix Critical/Important, rule on the rest and record each ruling. Mark the chosen sketch, paste the critic's reason into Review Focus, and turn any unmapped pre-mortem scenario into a task or a Review Focus line. Then stop — do not open a second critic round.
9. **Hand it off.** Present the plan and ask the user to confirm it captures the intent, then hand the approved plan to `m-dispatch` to run.

Save to `.mstack/plans/<YYYY-MM-DD>-<slug>.md` with `- [ ]` checkboxes for tracking, marking status as each task completes.

## Output

`.mstack/plans/<YYYY-MM-DD>-<slug>.md` containing header (goal, architecture, tech stack, spec path), Global Constraints, the shape sketches (only if step 2 ran), `## 状态与不变量` (only if step 5 applies), Review Focus, and tasks with Files/Interfaces/checkbox steps. Report to the user: the plan path, the critic's verdict (assumption ratings plus pre-mortem mappings), and the rulings you made.

## Stop conditions

Stop for approval before execution (planning never mutates code). Stop and return to `m-think` if the spec has gaps no task can cover. Ask only for a choice that is a genuine trade-off; settle reversible choices yourself and record them. If the critic and author cannot agree after one fix round, surface the disagreement to the user rather than looping. A missing `## 状态与不变量` on stateful work, or a new public boundary with only one shape, blocks the handoff — fix the plan, do not start coding.

## Harness notes

- Claude Code: dispatch the critic via `Agent`/`Task(subagent_type=...)` on a different model; DSH uses `subagent`/`subagent_fork`; Codex uses `codex exec` to a second model.
- In DSH `todo_write` tracks the plan's tasks; in code-first runs use the plan's own `- [ ]` checkboxes.
