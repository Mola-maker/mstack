# Changelog

## 0.6.0 — 2026-11-12
Manager practices: an audit of the stack against the "managing agents is managing a team" practices (give the agent a check it can run, say what the repo cannot show, enforce only what cannot bend, preflight unattended runs).
- **Acceptance ladder** (`skills/m-verify/references/ladder.md`): every verdict names its level, L0 static to L5 non-functional. A project's verify skill declares `Required level: L<n>`; a claim below it is PARTIAL. A verify skill without the line gets a warning and is treated as L1.
- **Verify receipt** (`skills/m-verify/scripts/receipt.mjs`): one receipt per working-tree hash under `.mstack/verify/receipts/`; any file change voids it. The tree hash covers uncommitted and untracked files and excludes `.mstack/`.
- **Stop reminder** (`hooks/stop-verify.mjs`): opt-in per project (create `.mstack/verify/gate`). When the current code has no receipt at the required level it shows a reminder. It never blocks.
- **m-qa** verify skill Doctor section probes for tools that are installed but not on PATH.
- **m-dispatch** brief gains WHY and OUT OF SCOPE; a shared interface lands before the fan-out.
- **m-goal** `init` requires `Boundaries` and `Output & approver` in the goal file when it exists; batch goals run 3 items first.
- **m-review** reports correctness and security by default; style only on request. **m-think** asks what result would make us stop.
- **Wording**: the all-caps rule lines in 9 skills are now sentence case with the same content; `check.mjs` rejects 4+ consecutive all-caps words.
- CI runs the skill and hook script tests.

## 0.5.0 — 2026-11-07
Round 3, after owner feedback ("prompts rough, agents weak, no model-based assignment, teams invisible in DSH"). Research: research/round3/ (six haiku agents: superpowers craft, OMC agents, pstack craft, Arena routing, DSH team, 262 starred repos). Built by DSH workers r1–r5 on auto/claude-sonnet-5-5 (group/smart-split was switched off in magpie); independent review reviews/2026-11-07-round3.md (15 findings) fixed by g1–g3.
- **Model layer**: `config/model-routing.json` — 11 task kinds → ranked magpie routes with Arena evidence (2026-11-06), 9 model families with prompt-adapter rules. Shared by skills (m-dispatch/references/model-routing.md) and mola: `mola run` guesses the task kind (printed and recorded; `--kind` overrides), picks the route, adapts the prompt per family without adding instructions, and walks picks + policy fallbacks on quota failure; `mola models rank [kind]`.
- **Agents**: 7 plugin agents (m-explorer, m-implementer, m-debugger, m-verifier, m-reviewer, m-critic, m-researcher) with model tiers, read-only tool denials and output contracts matched to the skills' parsers.
- **Prompt craft**: iron laws with closed loopholes, cited rationalization tables, red flags, countable stops and Ruling records, claim→evidence gate tables, "Using m-xxx" announce lines across the core skills.
- **DSH-native teams**: m-team/m-dispatch drive spawn_teammate, team_task_*, wait_agent, create_goal/update_goal, workflow agent() with schema; shared-cwd isolation trap documented; optional pinned preset `dsh/mstack-team`.
- check.mjs validates agents (frontmatter, read-only denials) and the routing file (magpie routes only, evidence per task). Removed stale compiled files committed under cli/packages/plugin-sdk/src in B1.

## 0.4.1 — 2026-11-06
- m-think wild mode (`references/wild-mode.md`): 10 lenses, parallel outcome search, ≥12 options incl. ≥3 outrageous, scored convergence with steelman and kill list. Trigger words 发散/全方位想.
- First use: `.mstack/specs/2026-11-06-multimachine-cowork.md` (multi-machine cowork design, research/cowork-*.md).

## 0.4.0 — 2026-11-06
Round 2: engineering practice from OMC, pstack, 26 papers and 12 high-star repos (research/, five haiku research agents), integrated by DSH workers per FRAMEWORK §11, independently reviewed (reviews/2026-11-06-round2.md, 15 findings fixed).
- Executable checks instead of prose: m-verify diff-blockers (incl. untracked files) and baseline gate; m-review split-findings and an explicit APPROVE / REQUEST CHANGES verdict; m-goal goal-state (consecutive-failure and budget breakers); m-dispatch candidate clustering; m-guard optional PreToolUse hook snippets; m-qa generates and maintains a project verify skill.
- Plugin hooks: PreCompact snapshot into an existing .mstack/handoff.md, and a post-compact reminder. Both no-ops in projects without .mstack/.
- Review: intent and standards axes, consumer census, repro per finding, position-swap and refuter stage, reviewer tier by size and risk.
- Anti-cheat: modifying or deleting existing tests, fixtures or graders fails unless the task asked for it; adding tests never does.
- evals/: 6 routing cases for `claude plugin eval` (5 should-fire + 1 boundary); all pass live (with plugin 1.0, without 0.0, $1.31).
- check.mjs: ≤12000 bytes per SKILL.md, skill dir whitelist, description ≤1024, eval case keys. AGENTS.md added.

## 0.3.1 — 2026-11-04
- Descriptions shortened to ≤130 chars. Claude Code's skill listing has a size budget and drops some skills' descriptions once it is exceeded (m-verify was listed name-only). This budget was probably also what hid `mstack:mstack` in 0.3.0, not the shared name; the `m-start` name stays.

## 0.3.0 — 2026-11-04
- **Breaking**: router skill renamed from `mstack` to `m-start`. Claude Code strips the description of a skill that has the same name as its plugin (`mstack:mstack` was listed by name only), so the model could not tell when to use it.
- Independent DSH acceptance review (`reviews/2026-11-04-acceptance.md`): 13 findings fixed. Among them: m-guard no longer promises a hard freeze it cannot enforce; m-goal alone owns the closeout (inside the goal file); the m-learn ↔ m-handoff loop is gone; DSH-only commands are marked; Orca `worktree create --no-parent`; the 3-strike rule is consistent.
- Demo animation (Remotion) in `demo/`, rendered to `assets/demo.gif` and `assets/demo.mp4`.

## 0.2.2 — 2026-11-04
- Repo furnishing: LICENSE, CI (`check.yml`: acceptance checks + YAML frontmatter + manifest JSON), CHANGELOG, plugin metadata.
- `docs/migration.md` records what was actually applied and what does not work (user-level `skillOverrides` is ignored for plugin skills).
- NOTICE credits arXiv 2610.36848 and stablyai/orca.

## 0.2.1 — 2026-11-04
- Fix: four skills (m-qa, m-ship, m-guard, m-deslop) had unquoted `: ` in their frontmatter, which is invalid YAML, so Claude Code dropped them silently. All values are now quoted, and `check.mjs` rejects the pattern.
- LF line endings enforced via `.gitattributes`.

## 0.2.0 — 2026-11-04
- New `m-team`: evolving agent teams (after arXiv 2610.36848). A supervisor redesigns roles, coordination and knowledge flow every round; persistent LEARNINGS / SYNTHESIS / history; artifact-based coordination; hard gates and evaluator hardening.
- `m-dispatch`: Orca (stablyai/orca) added as an optional backend.
- DSH workers use magpie routes only (`group/smart-split`).

## 0.1.0 — 2026-11-04
- 15 skills distilled from superpowers, gstack, pstack and oh-my-claudecode. The framework was written by Claude; the skills were built by DSH headless workers (`tasks/`).
