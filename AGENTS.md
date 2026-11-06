# AGENTS.md — working in the mstack repo

mstack = 16 workflow skills (`skills/`) + the `mola` CLI (`cli/`). The spec is `FRAMEWORK.md`; read the section you are changing first.

## Verify before you claim done
- Skills: `node scripts/check.mjs` (structure, ≤150 lines, ≤12000 bytes, frontmatter, no upstream names, eval cases). Must print `OK`.
- Skill helper scripts: `node --test "skills/<name>/scripts/*.test.mjs"` and `node --test "hooks/*.test.mjs"` (glob form: Node 24 rejects a bare directory).
- CLI: `cd cli && pnpm -r build && pnpm -r --no-bail test`. Windows skips POSIX-only cases; CI (Linux) runs them all.
- Routing evals (cost money, run on purpose, not on every change): `claude plugin eval . --trust-plugin --runs 3 --threshold 0.8 --no-publish --max-cost-usd 2`.

## Conventions
- A SKILL.md keeps its six sections in order; detail goes in `references/`, executables in `scripts/` (Node, zero deps).
- Frontmatter values are quoted; descriptions ≤130 chars and lead with the trigger words.
- Never name a skill like the plugin (`mstack`); refer to siblings as `m-xxx`.
- Rewrite, do not copy, from upstream sources (`.sources/` is reference only and gitignored).
- Long commit messages: `git commit -F <file>`; the shell mangles multi-line `-m`.
- Built by DSH workers from briefs in `tasks/`; a different agent reviews (`reviews/`).
