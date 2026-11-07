# Superpowers prompt craft: techniques, evidence, and three mstack rewrites

Scope: prompt technique only, not features. Sources: superpowers 7.0.0 (local cache), read in full: writing-skills/SKILL.md, persuasion-principles.md, testing-skills-with-subagents.md, brainstorming, test-driven-development, systematic-debugging, verification-before-completion, subagent-driven-development. Upstream v7.0.2 (latest, `gh api`): file-level diff only. writing-skills was slimmed (bulletproofing, discovery, flowcharts moved to `references/`); SDD was split into `references/` with a rationalization table; brainstorming was rewritten. I read v7.0.2 bulletproofing.md, the brainstorming head, and SDD fix-loop.md. The rest of the v7.0.2 text is not analysed here.

Evidence grade: "tested" = the superpowers authors describe a baseline/pressure run; "claimed" = assertion only; I have not reproduced any of these.

## Techniques

**T1. Iron Law in a fenced block, then a "No exceptions" list.** One absolute rule in a code block, then bullets that name each workaround ("don't keep it as reference", "don't adapt it").
Why: removes the negotiable surface; each named workaround is a rationalization seen in a baseline run. Grade: tested (authors' TDD-skill runs).

**T2. Spirit-vs-letter line near the top.** One sentence: violating the letter is violating the spirit.
Why: closes the whole class of "I'm following the spirit" arguments before they start. Grade: tested.

**T3. Rationalization table (Excuse | Reality).** Rows are copied from baseline transcripts, not invented. The Reality column is a counter-argument, not a restatement of the rule.
Why: the model meets its own likely sentence in the table and reads the rebuttal in the same glance. Grade: tested.

**T4. Red Flags as thoughts, with a terminal line.** A bullet list of inner monologue ("I already tested it manually") ending "All of these mean: stop and start over."
Why: it fires during reasoning, before the action, which action-level rules miss. Grade: tested; the list grows from observed violations.

**T5. Ordered Gate Function plus a claim table.** Numbered steps (IDENTIFY, RUN, READ, VERIFY, ONLY THEN) with "skip any step = not verifying". A table maps each claim to what it requires and to what is not sufficient.
Why: the "not sufficient" column names the substitutes the model actually reaches for (a linter, an earlier run). Grade: claimed.

**T6. Countable circuit breakers.** "After 3 failed fixes, question the architecture." SDD: 5 fix rounds; rounds 1-3 resume the implementer, rounds 4-5 escalate the model; adjudicate only at the cap.
Why: the stop condition is a count the model can check, instead of a feeling it has to judge ("am I stuck?"). Grade: claimed.

**T7. Exhaustive stop list plus a Ruling format.** SDD says only four things stop the run. Every other decision is logged as "Ruling: what / why / cost if wrong" and execution continues.
Why: bounds the escape hatches; turns would-be questions into auditable decisions. Compatible with the user's CLAUDE.md rule 8. Grade: claimed.

**T8. Hard gate with enumerated scope.** A `<HARD-GATE>` block lists what is forbidden before approval, the exceptions, and what is explicitly allowed ("reading and exploring are fine").
Why: the explicit allowance stops over-refusal; the explicit forbidden list stops under-refusal. Grade: claimed.

**T9. Description holds triggers only.** "Use when..." with symptoms and grep-able words; never the workflow.
Why: superpowers reports that a description summarizing the workflow made an agent follow the summary and skip the second review step. Grade: anecdotal (one observed run). Treat as a hypothesis to test in mstack.

**T10. Persuasion mapping by skill type.** Authority (MUST, "no exceptions"), commitment (announce "I'm using X", one todo per checklist item), scarcity (IMMEDIATELY after X), social proof ("every time", "X without Y = failure"). Avoid liking and reciprocity. Discipline skills: authority + commitment + social proof.
Why: cited to Meincke et al. 2025 (N=28k, compliance 33%→72%). I did not verify that paper; treat the numbers as single-source. The skill's own ethics test still applies: would the user endorse the technique if they saw it?

**T11. Match the form to the failure.** Discipline failure (knows the rule, skips it under pressure): prohibition + rationalization table + red flags. Shape failure (output too long, verdict buried): a positive recipe stating the parts in order. Omitted element: a REQUIRED field in the template. Condition-dependent behaviour: a conditional keyed to an observable predicate.
Why: the authors report that prohibitions raised the unwanted content in shaping tests (head-to-head, not replicated). Corollaries: no nuance clauses ("don't X unless…") and exemption clauses do not scope. Grade: tested by authors, small N.

**T12. Pressure scenarios as the RED test.** Three or more pressures combined (time, sunk cost, exhaustion, authority), a forced A/B/C choice, real file paths, ending "What do you do?" Capture the rationalizations verbatim. Meta-test: "How could this skill have made A the only acceptable answer?"
Why: forces a visible choice, and a failing run gives you the exact wording to counter. Grade: tested.

**T13. Micro-test wording before full scenarios.** 5+ fresh samples per variant, always a no-guidance control (if the control does not fail, there is nothing to fix), read every flagged match by hand, treat variance as a metric.
Why: single samples mislead; convergence across reps shows the wording binds. Grade: method is sound, numbers from the authors.

**T14. Ledger and handoff files, not pasted history.** Progress lives in a file that names its plan on line 1; a dispatch carries only its task and interfaces; narration is capped at one short line between tool calls.
Why: survives compaction and keeps the controller's context from filling with repeated history (the authors cite a 42k-char dispatch that was 99% history). Grade: anecdotal.

**T15. Budgets and one example.** Word targets (<150 for getting-started, <200 for frequently loaded, <500 otherwise), one excellent example rather than five languages, `<Good>/<Bad>` pairs, flowcharts only at decision points where the agent might stop early.
Why: frequently loaded prompts cost context on every turn. Grade: convention.

## Gaps in the three mstack skills (what they already do)

m-verify, m-debug and m-review already have numbered procedures, anti-cheat gates, output formats and stop conditions. Missing versus superpowers: no Iron Law line (T1), no claim→requirement table (T5), no red-flag self-check at the point of temptation (T4), and only one count-based breaker (m-debug). m-review's stop list contradicts its own output rules (see rewrite 3).

## Rewrite 1: m-verify, Procedure steps 6-8

Before (`skills/m-verify/SKILL.md`, step 6-8, excerpt): "Run it fresh, now... A previous run is not evidence." and "No 'should', 'probably', 'seems to'." Both are bare prohibitions placed after the claim has been drafted.

After (replaces steps 6-8):

```
6. **Gate every claim.** Iron Law: NO SUCCESS WORD WITHOUT THE COMMAND OUTPUT FROM THIS MESSAGE.
   Run the Gate Function for each claim. Skipping a step makes the claim unverified.
   a. IDENTIFY the one command that proves this exact claim (table below).
   b. RUN it now, in full. No `| tail -1`, no earlier run, no agent report.
   c. READ the exit code, the failure count, and the failing assertion's diff.
   d. VERIFY the output says what the claim says. If not, report the actual state.
   e. ONLY THEN write the claim, with the command and its key output beside it.

   | Claim | Requires | Not sufficient |
   |---|---|---|
   | Tests pass | full suite command, 0 failures, exit 0 | earlier run; one file only |
   | Build succeeds | build command, exit 0 | lint clean; log looks fine |
   | Bug fixed | original symptom repro now passes | code changed; "should be fixed" |
   | Regression test works | red on broken code, then green on fix | one green run |
   | Agent finished | VCS diff shows the claimed change | agent says "done" |

   **Red flags, stop and run the gate:** "should" / "probably" / "seems to"; "Done!" typed
   before step c; "just this once"; "the agent already said it passed"; "lint is clean, so
   the build is fine". Every one of these means the claim is not yet earned.
```

Why this form: m-verify's failure is discipline (the model knows the rule and reports early), so T1/T4/T5 apply. Step 6 keeps the original "no earlier run" rule and drops nothing from the anti-cheat steps 4-5.

## Rewrite 2: m-debug, Procedure (phase gate and counter)

Before (`skills/m-debug/SKILL.md`, step 8, excerpt): "Free exploration only after the fixed path stalls." The stall is not defined, so the model decides for itself when it has stalled.

After (new lead-in to Procedure, replaces the step-8 trigger):

```
**Iron Law:** NO EDIT THAT CLAIMS TO FIX THE BUG UNTIL P3 HAS A ROOT CAUSE AND A RED REPRO.

Finish each phase before starting the next. Write its exit line in the working notes:
- P1 Localize (steps 1-2). Exit: `ORIGIN: file:line | first wrong state | source of the fact`.
- P2 Reproduce (step 3). Exit: `REPRO: <command> -> <failing output>`.
- P3 Hypothesize and probe (steps 4-5). Exit: `ROOT CAUSE: <claim> because <evidence>; falsified: <list>`.
- P4 Patch and validate (steps 6-7). One change per attempt.

Counter: each patch attempt that leaves the repro red is one falsified hypothesis.
- Falsified 1-2: return to P1 and use the new output as evidence.
- Falsified 3: STOP. Ask whether the shape of the code is the bug, and present the three options in Stop conditions.

**Red flags, go back to P1:** "quick fix now, investigate later"; "change X and see if it works";
"I don't fully understand, but this might work"; "one more attempt" after two failures;
a fix that only moves the error to another file.
```

Why this form: the count is observable, so the model can check it. The original stop condition ("3 hypotheses falsified") is kept, now counted from patch attempts, which the model can see in its own log.

## Rewrite 3: m-review, Stop conditions

Before (`skills/m-review/SKILL.md`, Stop conditions): "No plan or spec to judge intent against → mark intent `not-assessed` and ask." The Output section says `not-assessed` does not block, so "and ask" contradicts it.

After (replaces the Stop conditions section):

```
## Stop conditions

Exactly three things end the review early. Each one produces output, not a question:
1. The base or diff cannot be established: write `REVIEW BLOCKED: <what failed>` and end.
2. Intent has no criterion to judge against: intent verdict `not-assessed`, quote what is missing.
   Standards and defect review continue.
3. Reviewer and refuter still disagree after one refute pass: put both sides in the report,
   marked `disputed`. Never promote a disputed finding to confirmed.

Everything else is decided inside the review and logged as a line in the report:
`Ruling: <what was decided> | <why> | <cost if wrong>`. Do not ask the author or the user about
a finding you can reproduce or drop.

**Red flags, check the repro before you write the finding:**
- "Looks risky" with no command output: Unconfirmed, not a finding.
- "Nit, but worth mentioning" about a line the diff does not add: drop it.
- A reviewer prompt containing "do not flag X": you are pre-judging. Delete the sentence.
- Adding findings because the list looks short: the count is whatever the repros support.
- Forming a verdict after reading the author's rationale: form it from the diff first.
```

Why this form: the original failure risk is a reviewer stalling or padding. The exhaustive list (T7) and the Ruling line turn would-be questions into logged decisions, and the red flags (T4) target padding and pre-judging. Behaviour change to flag: the original "and ask" is removed, so a missing spec no longer halts the review. This is deliberate, because the Output section already treats `not-assessed` as non-blocking. Confirm with the owner before merging this.

## Top five techniques

1. Countable stop conditions (T6, T7): the model can check a count, and every other decision leaves a Ruling line.
2. Rationalization table plus red flags, built from baseline transcripts (T3, T4).
3. Iron Law with an explicit loophole list (T1), so the rule has no negotiable surface.
4. Gate Function with a claim→requirement→not-sufficient table (T5), so "verified" has a concrete minimum.
5. Match the form to the failure (T11): prohibitions for discipline failures, recipes for shape failures, and no nuance clauses.

## Not done and risks

- No mstack file was edited. The three rewrites are demonstrations to review first.
- Nothing was run: the rewrites are not tested against the pressure scenarios in T12 or the micro-tests in T13. Per superpowers' own rules, they stay unverified until that happens.
- The persuasion numbers (T10) and the description-shortcut effect (T9) come from single sources.
- v7.0.2 changes to brainstorming and SDD were only partly read. Re-check before adopting any of them.
