# Changelog

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
