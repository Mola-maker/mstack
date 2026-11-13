---
name: m-think
description: "Think before any design decision: premise attack, ≤3 questions, spec; wild mode for 全方位/往死里想/发散/brainstorm/先想想."
whenToUse: "Before any creative or new work, whenever a request is vague or exploratory, or when the user says \"先想想\", \"brainstorm一下\", \"这个想法怎么样\"."
when_to_use: "Before any creative or new work, whenever a request is vague or exploratory, or when the user says \"先想想\", \"brainstorm一下\", \"这个想法怎么样\"."
---

# m-think — 动手前想清楚

m-think finds out what the user actually wants before anything gets built, then writes a design spec a builder could plan from. It attacks the premise early (principle 1), asks a minimum of questions, and lands every guess as an explicit assumption with a recommended default.

## When to use / not use

Use for new features, unclear goals, "is this worth building", and any request where intent is thin. Do not use when the request is a fully-specified one-line edit (just do it), or when an existing design/plan already exists (hand to `m-plan`). If the request is a bug report, use `m-debug`; if it is a stated multi-step plan to review, use `m-plan`.

## Procedure

1. **Assess what you already know.** If everything that matters is in the request, say what you will do and do it. If anything non-trivial is missing, start the conversation.
2. **Open with one question.** First line: offer to skip questions and just start. Second: one open question that gets them describing a real moment ("walk me through the last time this bit you"). Never list example answers.
3. **Attack the premise before proposing.** Challenge whether the problem is real, whether doing nothing is fine, whether a simpler framing exists, and what result would make us stop. Record the premises as statements; if any is wrong, rethink before designing.
4. **Run it before you ask.** If a question you were about to ask can be settled by a run of 30 minutes or less (a spike, a throwaway script, a measurement), run it and record the command plus the output. That run does not use a question slot, and it does not raise the cap of 3 questions per message. Still ask when the answer is taste, an irreversible or external action, or a fact only the user knows. Keep the spike off the path that will ship; do not commit it. If you cannot bound the run by 30 minutes, stop it and fall back to a default or a real question.
4b. **Wild mode (when asked, or when the design is open and costly to reverse).** Run all 10 lenses, fan out a parallel outcome search (≥3 channels, cited), generate ≥12 options including ≥3 deliberately outrageous ones, then converge with a scored matrix, a steelman of the runner-up, the one idea kept from the wild options, and a kill list. Follow `references/wild-mode.md`; it adds `## Lenses`, `## Outcomes` and `## Options` to the spec. Searches and spikes do not use question slots.
5. **Ask the fewest questions.** At most 3 per message, each with a recommended default the user can accept with a "yes". Cover: what this is and why now; goals, non-goals, anti-goals; prior art they loved or hated; what already exists; the details they care about. Get them describing in their own words before offering options. A question answered by step 4 is not one of the three.
6. **Use defaults, don't stall.** For reversible choices, proceed with a sensible default and say it out loud; the user course-corrects. Only a choice that is irreversible, external, or a genuine taste call goes to them. Gather codebase facts yourself (Read/Grep/Glob) before asking anything the repo already answers.
7. **Play back as you go.** When one part is clear, restate it in ~200 words, mark guesses as yours, ask what is wrong or missing, then move to the next part.
8. **Write the design.** Cover intent/why, goals/non-goals/anti-goals, constraints, the how-decisions they made, and what is left to the builder. Include an `## Assumptions` section listing every guess: statement, basis, reversibility. An assumption that is hard to reverse, surprising, or a real trade-off goes to a `decisions-pending` list instead of being silently assumed. Put spike results next to the assumption they settled.

At the top of the spec, under the title, add this block. Each value is your self-score from 0 (not stated) to 1 (a builder need not guess). The three rows are 目标, 约束, and 验收标准.

```markdown
## Readiness (reference only, not a gate)
- goal: <0-1>
- constraints: <0-1>
- acceptance: <0-1>
```

The numbers are a note for the next reader. They are not a threshold: do not ask more questions to push a score up, and do not refuse to write the spec because a score is low. A low score stays a gap in `## Assumptions` or `decisions-pending`.

Save to `.mstack/specs/<YYYY-MM-DD>-<slug>.md`.

## Output

A design spec at `.mstack/specs/<YYYY-MM-DD>-<slug>.md`, with the readiness block at the top. Give the user the top findings first, then offer the rest. A small change may stay in chat; a project always gets the document. Nothing gets built until the user approves the spec (or opts out of questions). Spike output is evidence in the spec, not the product.

## Stop conditions

Stop for approval before building anything beyond reading, exploring, or a ≤30 minute throwaway spike from step 4. Stop early if the premise is simply wrong and say so. A spike that would push, publish, pay, or run past 30 minutes is not step 4 — record a default or ask. Otherwise do not stall — every unanswered question becomes a recorded default, not a block (principle 8). Do not add questions because readiness looks low.

## Harness notes

- Question tool: Claude Code `AskUserQuestion`; DSH has no native ask tool, so ask inline with numbered choices and recommended defaults.
- Wild-mode outcome search: spawn `mstack:m-researcher` (one channel per agent, Claude Code `subagent_type`) for web channels and `mstack:m-explorer` for repo or local evidence; in DSH use `subagent` with the same names as labels.
- Keep questions in chat text so they survive across Claude Code / DSH / Codex.
