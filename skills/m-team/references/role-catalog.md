# Role catalog (m-team)

Roles are invented per round to fit the current bottleneck — this catalog is a starting menu, not a fixed roster. Mix, rename, split, or invent new roles; retire any role whose job is done. Every role contract has four parts: **duty**, **may change**, **must not touch**, **delivers** (evidence, as files — never a prose summary alone). Every role reads `SYNTHESIS.md` before starting.

## Focused Debugger

- **Duty:** reproduce and root-cause one named failure.
- **May change:** only its isolated branch (`agent/debug-<slug>`) and its scratch files.
- **Must not touch:** the main artifact and any other role's branch.
- **Delivers:** a minimal failing case, the root cause with `file:line`, a proposed fix as a diff against the isolated branch.
- **Add when:** the same failure has survived several rounds, or debugging is churning the main artifact (supervisor pattern 3).

## Disciplinarian

- **Duty:** keep the team on the chosen architecture and working method.
- **May change:** nothing directly — it reviews and rejects.
- **Must not touch:** implementation code.
- **Delivers:** a per-commit verdict: architecture respected? one change per commit? measured before editing? Rejects with reasons.
- **Add when:** rounds drift toward whatever is easy to implement, or commits mix several unmeasured changes (diagnosis: discipline problem).

## Knowledge Integrator

- **Duty:** merge findings from prior rounds into one actionable document.
- **May change:** `SYNTHESIS.md` and `LEARNINGS.md` only.
- **Must not touch:** the artifact under optimization, branches, configs.
- **Delivers:** an updated `SYNTHESIS.md` (current best design, known dead ends, open questions) and deduped `LEARNINGS.md` entries.
- **Add when:** a conclusion from an earlier round was lost, re-derived, or contradicted (supervisor pattern 2).

## Challenger

- **Duty:** attack the claim that the metric has reached its ceiling.
- **May change:** its own branch and benchmark scripts.
- **Must not touch:** the main branch.
- **Delivers:** either a counter-example (a measurement beating the "ceiling") or a written argument with data for why the ceiling is real.
- **Add when:** the metric is flat and the team's only explanation is "we're at the limit" (diagnosis: exhausted search).

## Auditor

- **Duty:** independently re-check delivered evidence before the supervisor scores it.
- **May change:** nothing.
- **Must not touch:** everything — read-only.
- **Delivers:** byte-level comparison of claimed vs actual artifacts: does the diff exist, do the numbers reproduce, do the gates actually run.
- **Add when:** any role's report and its artifacts disagreed, or scoring decisions felt shaky last round.

## Profile-Driven Optimizer

- **Duty:** improve the metric, but only where fresh measurements point.
- **May change:** the main artifact on its assigned branch.
- **Must not touch:** anything outside the profiled hot path.
- **Delivers:** a fresh profile taken this round, each change tied to a hot spot, before/after measurements for every commit.
- **Add when:** tuning decisions are citing measurements from before the last structural change (supervisor pattern 4).

## Dead-End Revisitor

- **Duty:** re-open one hard direction that an earlier round abandoned.
- **May change:** its own branch; may reuse prior failed attempts as a starting point.
- **Must not touch:** the current best candidate.
- **Delivers:** what was tried before (from `history.md`), what is different now, and either a working spike or a sharper explanation of the blocker.
- **Add when:** `history.md` shows an abandoned direction whose blocker may no longer hold (new knowledge, new tools, changed architecture).

## Research

- **Duty:** fill a named knowledge gap from external sources.
- **May change:** only its notes file under the round's knowledge placement.
- **Must not touch:** code, configs, benchmarks.
- **Delivers:** sourced findings (multi-channel, cross-checked per `m-research`), each marked verified or single-source.
- **Add when:** the diagnosis is knowledge gap — the team needs facts it doesn't have (hardware behavior, library semantics, prior art).

## Architect

- **Duty:** redesign the structure when incremental work cannot reach the target.
- **May change:** a design doc and a spike branch.
- **Must not touch:** the main branch directly.
- **Delivers:** a concrete redesign (what changes, in what order, what it enables), plus a spike proving the riskiest part.
- **Add when:** several rounds of optimization produced only marginal gains and the bottleneck is structural (diagnosis: exhausted search).

## Composing a round

- One role can be the whole team (coordination shape: solo) when the diagnosis points at a single bottleneck.
- Pipeline (Research → Architect → Profile-Driven Optimizer) when knowledge must precede structure which must precede tuning.
- Parallel branches (Focused Debugger isolated + main-line work continuing) when a bug blocks progress but the metric work shouldn't stop.
