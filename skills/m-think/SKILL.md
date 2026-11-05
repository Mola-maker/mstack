---
name: m-think
description: "Think it through before building — attack the premise, ask the fewest questions (max 3 at a time with recommended defaults), then write a design spec. Use when the request is new, vague, or \"先想想/帮我梳理/这个想法\"."
whenToUse: "Before any creative or new work, whenever a request is vague or exploratory, or when the user says \"先想想\", \"brainstorm一下\", \"这个想法怎么样\"."
---

# m-think — 动手前想清楚

m-think finds out what the user actually wants before anything gets built, then writes a design spec a builder could plan from. It attacks the premise early (principle 1), asks a minimum of questions, and lands every guess as an explicit assumption with a recommended default.

## When to use / not use

Use for new features, unclear goals, "is this worth building", and any request where intent is thin. Do not use when the request is a fully-specified one-line edit (just do it), or when an existing design/plan already exists (hand to `m-plan`). If the request is a bug report, use `m-debug`; if it is a stated multi-step plan to review, use `m-plan`.

## Procedure

1. **Assess what you already know.** If everything that matters is in the request, say what you will do and do it. If anything non-trivial is missing, start the conversation.
2. **Open with one question.** First line: offer to skip questions and just start. Second: one open question that gets them describing a real moment ("walk me through the last time this bit you"). Never list example answers.
3. **Attack the premise before proposing.** Challenge whether the problem is real, whether doing nothing is fine, and whether a simpler framing exists. Record the premises as statements; if any is wrong, rethink before designing.
4. **Ask the fewest questions.** At most 3 per message, each with a recommended default the user can accept with a "yes". Cover: what this is and why now; goals, non-goals, anti-goals; prior art they loved or hated; what already exists; the details they care about. Get them describing in their own words before offering options.
5. **Use defaults, don't stall.** For reversible choices, proceed with a sensible default and say it out loud; the user course-corrects. Only a choice that is irreversible, external, or a genuine taste call goes to them. Gather codebase facts yourself (Read/Grep/Glob) before asking anything the repo already answers.
6. **Play back as you go.** When one part is clear, restate it in ~200 words, mark guesses as yours, ask what is wrong or missing, then move to the next part.
7. **Write the design.** Cover intent/why, goals/non-goals/anti-goals, constraints, the how-decisions they made, and what is left to the builder. Include an `## Assumptions` section listing every guess: statement, basis, reversibility. An assumption that is hard to reverse, surprising, or a real trade-off goes to a `decisions-pending` list instead of being silently assumed.

Save to `.mstack/specs/<YYYY-MM-DD>-<slug>.md`.

## Output

A design spec at `.mstack/specs/<YYYY-MM-DD>-<slug>.md`. Give the user the top findings first, then offer the rest. A small change may stay in chat; a project always gets the document. Nothing gets built until the user approves the spec (or opts out of questions).

## Stop conditions

Stop for approval before building anything beyond reading/exploring (or a throwaway spike the user asked for). Stop early if the premise is simply wrong and say so. Otherwise do not stall — every unanswered question becomes a recorded default, not a block (principle 8).

## Harness notes

- Question tool: Claude Code `AskUserQuestion`; DSH has no native ask tool, so ask inline with numbered choices and recommended defaults.
- Keep questions in chat text so they survive across Claude Code / DSH / Codex.
