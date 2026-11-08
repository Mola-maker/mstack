You are finishing the branch guard for mstack 1.0. Your current directory is YOUR OWN clone of the repo, on branch agent/h3b. Work only inside it.

Hard rules, first. These come from a real incident: the previous worker on this task ran `git reset --hard` and `git push --all` in the owner's main repo because a `cd` failed, and wiped other workers' work.
- Never cd to, read from or write to /mnt/e/mstack. Your clone is the repo.
- Every shell command that changes directory uses `cd <dir> || exit 1` or `set -e`. Git experiments happen only in `mktemp -d` repos, addressed with `git -C "$tmp"`.
- You may commit on agent/h3b in your clone (small commits, clear messages). Never push. Push is disabled in this clone; do not re-enable it.

Read FRAMEWORK.md §13.4 (the design and the incident), tasks/h3.md (the original brief: all requirements still apply), and the guard core that already exists: hooks/guard-git.mjs and hooks/guard-git.test.mjs (27 tests). Check them first: run `node --test hooks/guard-git.test.mjs` and fix anything that fails. The previous worker reported one flaky pre-push case whose last repro ran in the wrong repo.

Remaining work, all specified in tasks/h3.md:
1. Wire the hooks/hooks.json PreToolUse Bash entry, and add hooks/guard-git.test.mjs to the CI step that runs hooks/hooks.test.mjs (.github/workflows/check.yml).
2. Build the policy-guard plugin (cli/packages/plugins/policy-guard): `mola guard env`, `mola guard check`, `mola guard receipt` and `mola land`.
3. Merge the guard env into agent-dsh and agent-codex run(), with tests.
4. Leave tasks/resume.sh alone: it is already updated (it gives each worker its own clone and exports the guard env when /root/.mola/guard/bin/git exists).
5. Close two bypasses the design names:
   - Block `push --all` and `push --mirror` everywhere, not only toward protected refs.
   - Treat `git -c core.hooksPath=...` and `GIT_CONFIG_*` overrides inside a command string as a bypass in claude-hook mode.

Another worker (h6) is editing plugin-sdk/src/agents.ts (RunRequest gets an AbortSignal) and the adapters' run() for abort handling. Keep your adapter change to the env merge only, so the two merge cleanly.

Done:
- `node --test hooks/*.test.mjs` passes.
- `cd cli && pnpm install --frozen-lockfile && pnpm -r build && pnpm -r --no-bail test` has 0 failures.
- Your work is committed on agent/h3b.

Reply with:
- what you built (file:line);
- test counts;
- a real demo in a mktemp repo through the shim: a refused `git commit` on main (show the message), an allowed commit on agent/x, and `mola land` refusing without a receipt and then succeeding with --local after a receipt;
- the remaining bypasses;
- `git log --oneline` of your branch.
