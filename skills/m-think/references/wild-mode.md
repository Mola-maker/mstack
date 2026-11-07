# m-think wild mode: think from every angle, search outcomes, then converge

Use when the user asks for it ("全方位想 / 往死里想 / 发散 / think wild / 想到极致"), or when the design is open, expensive to reverse, and the obvious answer came too fast. Wild mode widens the search before step 8 (write the design); it does not replace the premise attack or the question cap.

## 1. Lenses (diverge, one short paragraph each)

Run every lens. A lens that yields nothing gets one line saying so; skipping is not allowed.

| # | Lens | Question to answer |
|---|---|---|
| 1 | Job | What is the user really trying to get done, and what would make them stop caring about this feature? |
| 2 | First principles | Strip it to physics: data, bytes, latency, people. What must be true, and what is just habit? |
| 3 | Inversion | How would we guarantee failure? Each failure path becomes a constraint. |
| 4 | Scale ×10 / ÷10 | What breaks at 10× the machines, users or data? What becomes trivial at 1/10? |
| 5 | Constraint removal | With unlimited budget? With zero budget and one afternoon? |
| 6 | Analogy | Who solved a structurally similar problem in another field (version control, CDNs, game netcode, CRDT editors, logistics)? |
| 7 | Adversary | Attacker, flaky network, compromised machine, a hostile or careless agent. |
| 8 | Operations | Who restarts it at 3 a.m.? What does it look like when half-broken? |
| 9 | Time | Now, in 1 year, in 5 years: which choice ages badly? |
| 10 | Outcomes | What actually happened when others built this (section 2)? |

## 2. Outcome search (search before you invent)

Look for outcomes, not opinions: post-mortems, benchmarks, migrations away, issue threads where it broke, abandoned projects and why.
- Fan the search out in parallel (`m-research`, or one subagent per angle: `m-researcher` per channel, `m-explorer` for repo evidence). Use ≥3 independent channels and cite every claim.
- Each searcher returns: what was tried, what happened (with numbers when available), why it worked or failed, source URL.
- Mark single-source claims. An outcome you could not verify is an assumption, not evidence.

## 3. Wild round (no filtering yet)

Produce at least 12 options. At least 3 must be deliberately outrageous: they break a stated constraint, use an unusual medium, or delete the problem. Steal from the analogy lens. Do not judge during this round; judging too early is how the obvious answer wins by default.

## 4. Converge (now be ruthless)

Score every option 1–5 on: value to the job, cost to build, operational risk, reversibility, and fit with what already exists. Then:
- Keep the top 3. Steelman the runner-up in two sentences: why someone smart would pick it.
- Mine the outrageous options: name one idea from them that survives into the chosen design, or write "none" with a reason.
- Kill list: every dropped option with a one-line reason, so it is not re-proposed later.
- The chosen design must survive the inversion lens: each failure path from lens 3 is mitigated or explicitly accepted.

## 5. What goes into the spec

Add these sections to the design spec, before `## Assumptions`:
- `## Lenses`: one row per lens with the finding.
- `## Outcomes`: the evidence table from section 2, with sources.
- `## Options`: the scored matrix, top 3, the steelman, the idea kept from the wild options, and the kill list.

Budget: a wild-mode pass should cost at most about 1 hour of agent time plus the parallel searches. If it would take longer, converge on what you have and record the open angles in `decisions-pending`.
