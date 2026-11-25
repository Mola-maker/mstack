# AGENTS.md — working in the mstack repo

mstack = 17 workflow skills (`skills/`) + the `mola` CLI (`cli/`). The spec is `FRAMEWORK.md`; read the section you are changing first.

## Verify before you claim done
- Skills: `node scripts/check.mjs` (structure, ≤150 lines, ≤12000 bytes, frontmatter, no upstream names, eval cases). Must print `OK`.
- Bug fixes: `node skills/m-verify/scripts/prove.mjs --cmd "<test cmd>"` exits 0 only when the new test fails on the base and passes now.
- Skill helper scripts: `node --test "skills/<name>/scripts/*.test.mjs"` and `node --test "hooks/*.test.mjs"` (glob form: Node 24 rejects a bare directory).
- Benchmark harness: `node --test bench/bench.test.mjs` (free; the real runs in `bench/README.md` cost money).
- CLI: `cd cli && pnpm -r build && pnpm -r --no-bail test`. Windows skips POSIX-only cases; CI (Linux) runs them all.
- Routing evals (cost money, run on purpose, not on every change): `claude plugin eval . --trust-plugin --runs 3 --threshold 0.8 --no-publish --max-cost-usd 2`.

## Hit every surface (before you say a change is done)
A change that works where you tried it and is missing elsewhere is the most common defect here. Say which of these applied:
- **Entry points**: `/go` (commands/go.md), the `mola` CLI, `mola web`, `mola tui`, the status line, `mola mcp`, the DSH plugin, the Codex skill copies.
- **Builtins**: a new plugin under `cli/packages/plugins/` is in `BUILTIN_PLUGIN_PACKAGES` and in `cli/packages/mola/package.json` (`check.mjs` fails otherwise).
- **Reverse states**: every way in has a way out and a way to see it — install/uninstall, pause/resume, add/rm, stop/resume, rewind/undo. A one-way door is a bug.
- **Refusals name real commands**: a hook or error that tells an agent to run `mola x` needs `mola x` to exist.
- **Outside text** (web form, webhook, PR comment, issue) goes through `stripInvisible` / `wrapUntrusted` (`@mola/plugin-sdk`) before a prompt.

## Conventions
- A SKILL.md keeps its six sections in order; detail goes in `references/`, executables in `scripts/` (Node, zero deps).
- Frontmatter values are quoted; descriptions ≤130 chars and lead with the trigger words.
- Never name a skill like the plugin (`mstack`); refer to siblings as `m-xxx`.
- Rewrite, do not copy, from upstream sources (`.sources/` is reference only and gitignored).
- Long commit messages: `git commit -F <file>`; the shell mangles multi-line `-m`.
- Built by DSH workers from briefs in `tasks/`; a different agent reviews (`reviews/`).
