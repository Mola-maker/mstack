# Changelog

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
