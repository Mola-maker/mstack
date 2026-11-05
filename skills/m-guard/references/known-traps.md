# Mola's known traps

Each entry is a trap that has already cost real work, with what actually happens and what to do instead. Scan this before touching the DSH stack, WSL, magpie, or temp dirs.

## WSL / processes

- **Never `pkill -f <text>` in WSL.** It matches the invoking shell (killed it twice), and `pkill -f "dsh --profile mola"` also matched the default tmux server's argv and took the superagents (3082/3083) down. Kill by exact PID, or use `scripts/mola.sh stop|restart` (the `mola` profile has its own tmux socket `-L mola`).
- **Git Bash → `wsl` path mangling.** From Git Bash, `wsl -e bash /mnt/e/x.sh` gets rewritten to `C:/Program Files/Git/mnt/e/x.sh`. Prefix with `MSYS_NO_PATHCONV=1`.
- **`Wsl/Service/0x8007274c`** (connection timeout) after starting several long `wsl` jobs at once: already-running jobs keep going; new `wsl` calls fail for a while. Read their output from the Windows side (`E:\…`) instead of opening more `wsl` sessions.
- **WSL reaches magpie (:3425) only with `networkingMode=mirrored`** in `%USERPROFILE%\.wslconfig`.

## DSH stack

- **`E:\deepseek\deepseek-harness` is read-only.** It is the 3080 dev instance (`pnpm run dev:web`, pinned commit). A `git pull` there while it runs broke 3080 once. Read other versions with `git show <tag>:path`.
- **magpie owns DSH's model list.** It rewrites `cordis.patch.yml` about every 15 s. Change models with `magpie visible dsh …`, never by editing the file. A one-run model override goes in a `--patch` overlay (`agent-default-model`).
- **DeepSeek balance can run out mid-run** (`dsh: QUOTA: 402 Insufficient Balance`). Every headless worker on `deepseek/*` dies at once, leaving whatever it had written. Re-dispatch the remainder on another magpie route (e.g. `auto/kimi-k3`), and tell workers which files already exist.
- **DSH `ctx.web.fetch` refuses hosts that resolve to non-public IPs.** A fake-ip proxy DNS triggers this for every host, so fetch-based tools report "unreachable".

## Windows

- **When clearing `%TEMP%`, exclude `%TEMP%\claude`.** Claude Code writes command output there; deleting it makes commands lose their output.
- **Docker engine stuck at "stopping"**: a zombie elevated backend holds the vhdx lock. Kill the processes from an elevated (UAC) shell, then restart.
- **`rm` on a path that resolves to a drive root or home is blocked** by Claude Code's safety check. Delete specific files by full path, or leave the deletion to the user.

## Plugins

- **OMC and superpowers both inject "use me first" routing**, and they conflict (duplicate triggers for brainstorming/planning/review). Keep one router active; see docs/migration.md.
