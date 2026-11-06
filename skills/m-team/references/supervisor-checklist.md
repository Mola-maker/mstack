# Supervisor checklist (m-team)

Read this at the end of every round (or at each scheduled wake) before designing the next team version. Work top to bottom; do not skip the metrics step to go straight to reorganizing.

## 1. Metrics and gates first

- Compare the team with the solo baseline before any redesign. The noise band in `v<N>.md` must have been written before this comparison. If it is missing, derive it only from measurements that predate this round; if none exist, use the measuring command's smallest resolvable delta and mark the band weak. Never set the band from this round's team-minus-solo gap.
- Unblind only after the anonymous scores exist. Gain is how far the best team label beats the solo label in the metric's success direction (higher-is-better: team − solo; lower-is-better: solo − team). If that gain sits inside the band, skip section 4: do not write a multi-role `v<N+1>.md`. Record the stop in `history.md` and hand back to `m-goal`.
- If this round's coordination shape was already solo, there is no second baseline and no gap. Say so, and do not invent one.
- Pull this round's measured metric for every candidate; compare against the round's threshold in `v<N>.md`.
- List every candidate that scored 0 and name the gate it failed. Zero-score candidates are data, not noise.
- Run the held-out checks on the best candidate. They never affect the score, but a held-out failure means the gates are blind to something.
- If a bug class passed the evaluator: add a permanent check covering it, apply it to every future candidate, and record the hole in `LEARNINGS.md` (evaluator hardening).
- Never relax a gate or a threshold to make the round look successful.

## 2. Failure patterns

Check each pattern against what the round actually did (files, diffs, measurements — not what roles claimed):

1. **Drift to the easy path.** The round picked the direction that was easiest to implement, not the one with the most headroom. A harder direction abandoned earlier stays abandoned. Symptom: many small tweaks, no structural commits.
2. **Lost insights.** A conclusion from an earlier round is missing from `SYNTHESIS.md`; a role re-derived something already known, or repeated a failed attempt recorded in `LEARNINGS.md`.
3. **Stuck in debugging.** Most of the round's budget went into one bug, or the same error was retried instead of isolating it. The main artifact got churned by the debugging itself.
4. **Micro-optimizing against a stale profile.** Tuning decisions cite measurements taken before the last structural change. Symptom: profile-driven edits, but no fresh profile in the round's artifacts.
5. **Plateau.** The metric moved less than noise for 2+ rounds and no new hypothesis was tried.

## 3. Classify the stall

Pick exactly one diagnosis per round (the dominant one):

- **Knowledge gap** — the team lacks information (how the hardware/library behaves, what the literature does, what the real bottleneck is). Fix: add Research, a profiling role, or a Knowledge Integrator round.
- **Exhausted search** — the current direction is mined out. Fix: Challenger to attack the "we're at the ceiling" claim, Dead-End Revisitor for an abandoned hard direction, or an Architect round to change the structure itself.
- **Discipline problem** — the team knows what to do but doesn't do it: unmeasured changes, several edits per commit, drift from the chosen architecture, claims without artifacts. Fix: Disciplinarian, tighter gates, an isolated branch for the Debugger.

## 4. Design the next version

Skip this section when section 1 already stopped the team.

- Write `v<N+1>.md` from `team-config-template.md`. Change only what the diagnosis demands — a re-org that doesn't map to a failure pattern is churn.
- Roles are invented per need; `role-catalog.md` gives starting points with "add when" symptoms. Drop roles whose job is done.
- Consider switching the coordination shape: solo → pipeline (research → implement → profile) → parallel branches (debugger isolated alongside main work).
- Move knowledge if it is being lost: a finding that must survive goes to `SYNTHESIS.md`, an observation with evidence to `LEARNINGS.md`.

## 5. Record the round in history.md

Append one entry per round with:

- round number and team version, budget consumed (tokens/$/wall-clock);
- metric before → after, with the command that measured it;
- solo metric, team-best metric, the noise band, and whether the gap stopped the team;
- the label-to-author map, written here only after scores came back;
- the failure pattern(s) observed and the diagnosis class chosen;
- the design decision for the next version and why;
- anything abandoned this round (so a later Dead-End Revisitor can find it).
