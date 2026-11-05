# `mola` — delivery batches

Derived from [DESIGN.md](DESIGN.md), the three sections and the five ADRs. Every batch is
useful on its own and is accepted by exact commands. Live acceptance runs are env-gated
(`MOLA_TEST_LIVE=1`) per [core-plugins §9](sections/core-plugins.md); model traffic always
rides magpie `group/*` / `auto/*`, never `deepseek/*` direct.

---

## B1 — skeleton + today's working flow (land fast)

**Goal:** `mola` exists, boots its plugin core, and wraps what already works today: DSH
headless dispatch (`tasks/dispatch.sh` flow), magpie model routes, rtk, agent discovery,
plus `mola doctor`. Packaged inside the mstack repo.

**Scope**
- Packages: `cli/` pnpm workspace; `packages/mola` (bin), `packages/core` (boot, loader,
  router, bus skeleton, config layers, JSON state store, logging/traceId, exit codes),
  `packages/plugin-sdk` (types + `mola-plugin.json` schema), `packages/rpc` (client half
  only; no sidecar yet).
- Plugins (all `builtin` tier): `cmd-doctor`, `cmd-config` (get/set), `cmd-plugin`
  (list/validate), `cmd-dispatch`, `cmd-model`, `cmd-rtk`, `agent-dsh`, `tool-magpie`
  (discovery + `healthcheck`), `tool-rtk`, `tool-git` (detect only), `policy-approval`
  (route whitelist + conservative argv classifier feeding the `mola.tool.before`
  waterfall).
- Crates: none (B1 is TS-only; sidecars start B3).

**Out of scope:** third-party plugin install/update, `mola run` scoring router, agent
adapters other than dsh, hook bridges/stream parsing, SQLite, sidecars, envs, sessions,
collaboration, skills-install convenience.

**Acceptance commands** (from `/mnt/e/mstack` on the main machine; dsh/WSL path per
`skills/m-dispatch/references/harness-commands.md`):

```sh
# 1 — health report covers the whole B1 surface
mola doctor --json
# expect exit 0; stdout is one {"schemaVersion":1,...,"data":{"checks":[...]}} envelope;
# checks include node>=22, plugins.plan-ok, magpie.healthcheck (exit 0), agent.dsh
# (machine "wsl:Ubuntu"), tool.rtk, tool.git — failing check ⇒ non-zero per core §8.3

# 2 — plugin registry is exactly the B1 builtin set
mola plugin list --json | jq -r '.data[] | "\(.id) \(.tier)"'
# expect 10 lines, all "builtin": cmd-doctor cmd-config cmd-plugin cmd-dispatch
# cmd-model cmd-rtk agent-dsh tool-magpie tool-rtk policy-approval

# 3 — agent discovery merges PATH probes with `magpie ls`
mola agents list --json
# expect .data[] includes dsh (managedByMagpie true, health "ok") plus every agent
# `magpie ls` reports; omp present with health "broken" (Bun crash) and never routed

# 4 — dispatch wraps today's tested DSH headless flow
printf 'Reply with exactly: mola-b1-ok\n' > tasks/b1-smoke.md
mola dispatch tasks/b1-smoke.md
# expect exit 0; mola generated the group/smart-split overlay (provider: magpie) and ran
#   wsl -e bash -lc 'source ~/src/mola-dsh-stack/scripts/env.sh; dsh --profile mola-cli \
#     --patch <overlay> --json - < tasks/b1-smoke.md'
# the worker's final answer ("mola-b1-ok") is printed; logs/dispatch-<runId>.out ends
# with "exit=0"; .mola state records the run (traceId, argv, exit code)

# 5 — model routes only through magpie, whitelist enforced (BRIEF #3)
mola model show dsh                          # expect: group/smart-split (source: profile patch), exit 0
mola model set dsh auto/kimi-k3              # expect exit 0; runs `magpie dsh auto/kimi-k3`; show reflects it
mola model set dsh group/claude-cheap         # restore: `magpie dsh` targets the Windows web profile, whose real model is group/claude-cheap — the test must not leave it changed
mola model set dsh deepseek/deepseek-chat    # expect exit 77, stderr error code ROUTE_BANNED (deepseek/*)

# 6 — rtk passthrough (raw output when it matters)
mola rtk bypass git status --porcelain | head -1   # expect a raw porcelain line, exit 0
mola rtk gain > /dev/null                          # expect exit 0 (savings report passthrough)

# 7 — exit-code contract for consuming agents
mola agents show nope --json
# expect exit 66; stdout clean; stderr one {"error":{"code":"AGENT_NOT_FOUND",...}} line

# 8 — policy waterfall is live
mola dispatch tasks/b1-smoke.md --route deepseek/deepseek-chat
# expect exit 77 before any worker starts (banned route rejected at task.pre-dispatch)
```

**Depends on:** nothing new — magpie running on 127.0.0.1:3425, `dsh` in WSL with profile
`mola-cli`, `rtk` on PATH, `tasks/dispatch.sh` as the reference flow. All already true.

---

## B2 — routing engine, more agents, hook bus, plugin install

**Goal:** `mola run` becomes the general router (ADR-0003 filter+score, quota ladder);
claude + codex adapters; the hook bus records replayable runs; third-party plugins are
installable with permission diffs.

**Scope:** routing engine + `~/.mola/policy.jsonc`; `agent-claude`, `agent-codex`
(stream bridges; native-hook bridge for claude per-run `--settings`); SQLite `state.db`;
`.mstack/runs/<runId>/events.jsonl`; `mola hooks list`, `mola runs list|show`;
`mola plugin install|update|remove|enable|disable|doctor` (pnpm-forwarded, permission
diff, SHA-512 pin, trust tiers); `mola skills install`; skill commands `mola think|plan|
goal|team|review|ship`; `mola completions`, `mola version`; capture
`git/docker/layerfs --help` into `cli/design/inputs/` (adapters-routing gap #2).

**Out of scope:** remote machines (B3), NATS (B4), handoff (B5).

**Acceptance:**
```sh
mola run "count TODOs in README.md and print the number" --json
# expect exit 0; decision.json in .mstack/runs/<runId>/ names agent+machine+modelRoute
# (route ∈ group/*|auto/*); NDJSON run events on stderr
mola run "review this diff" --agent codex --route group/claude-cheap --json   # exit 0
mola hooks list --json   # expect listeners owned by policy-approval + the two stream bridges
cat .mstack/runs/<runId>/events.jsonl | jq -r '.kind' | sort -u
# expect ≥ {mola.session.started, mola.agent.message, mola.turn.completed, mola.session.ended, mola.task.done}
mola plugin install ./fixtures/fake-plugin --yes
# expect permission diff printed, ~/.mola/plugins.json gains the sha512, `mola plugin list` shows it (untrusted)
MOLA_TEST_LIVE=1 mola doctor   # on a machine with magpie+dsh: still exit 0
```
**Depends on:** B1 (core, loader, dsh reference adapter, policy gate).

---

## B3 — environments + remote sessions (attach-first)

**Goal:** mola sees and reaches the other machines; sessions on jlu-pc are listable and
attachable from main (mola-infra Phase 1).

**Scope:** crates `mola-proto`, `mola-ptyd` (first sidecar; `mola.hello` handshake);
env adapters `env-local`, `env-wsl`, `env-ssh-peer` (tailscale ssh/rsync/nc);
`mola envs list|probe`, `mola doctor --envs`; `mola sessions list|attach` (tmux + dsh
`--session-id` + claude `--bg` registries); remote session registration via a minimal
`mola daemon` on jlu-pc; `mola sidecar list|restart`.

**Out of scope:** NATS/cloud sync (B4), handoff/transcript move (B5), phones (B6).

**Acceptance:**
```sh
mola sidecar list --json         # expect mola-ptyd adopted, protocolVersion 1 handshake ok
mola envs --json                 # expect local, wsl, jlu-pc (reachable, latencyMs from tailscale ping);
                                 # kamin/whymola reported absent if offline, command still exit 0
mola doctor --envs               # per-env probe table; offline env = warning, not failure
mola sessions --json             # expect tmux + dsh sessions from jlu-pc (kind, agent, cwd, resumable)
mola sessions attach --id <sid>  # expect: attaches over tailscale ssh; detaching leaves the session alive
mola dispatch tasks/b1-smoke.md --on jlu-pc   # expect the same run executed on jlu-pc, exit 0
```
**Depends on:** B2 (run/events pipeline); tailscale mesh + jlu-pc reachable.

---

## B4 — collaboration base (NATS + goal/task/lease)

**Goal:** two machines coordinate over one goal: claims, artifacts, presence, replay
(envs-collab §7's B3; ADR-0005).

**Scope:** crate `mola-syncd` (NATS JetStream/KV/ObjectStore over JSON-RPC); NATS master
on tencent-cloud 4c4g + leaf node per machine (per-machine credentials, subject-scoped);
collab model `Goal/Task/Claim/Artifact/Presence/GateRequest` + `mola goal
create|status|archive`, `mola task add|claim|done|message`; orca bridge (disabled until
orca is on PATH); OMC `omc wait` wired into the quota ladder.

**Out of scope:** handoff/workspace transfer (B5), LayerFS + phone (B6).

**Acceptance:**
```sh
mola goal create design-review --tasks tasks/d1.md,tasks/d2.md --json   # goal_<id>, 2 ready tasks
# on jlu-pc:
mola task claim task_1 --json        # claim with epoch; second claim attempt on main exits 77 (lease held)
mola task done task_1 --evidence logs/d1.out --json
mola goal status design-review --json
# expect: task_1 done with evidence, one claim; backend "nats"
# resilience: stop jlu-pc leaf node 30 s → local events during the gap replay after
# reconnect, no loss/duplication (JetStream dedupe by (goalId, seq))
# degraded: kill nats on tencent → mola goal status shows backend "degraded",
# local file-lock claims still work; restart → state reconverges
```
**Depends on:** B3 (mola daemon on peers, sidecar plumbing, tailnet reachability).

---

## B5 — handoff (session moves between machines)

**Goal:** an agent session + its WIP moves main ⇄ jlu-pc and resumes (mola-infra Phase 3).

**Scope:** single-writer lease via KV + fencing epoch on artifacts; workspace freeze
(WIP commit, never push); transcript export for claude (`~/.claude/projects/...`) and
codex (`~/.codex/sessions/`); `paths.toml` path rewrite (mola-env); session-pack via
NATS Object Store (fallback `tailscale file`); `mola session handoff --id --to`; resume
with `claude --resume` / `codex resume` / `dsh --session-id`.

**Out of scope:** LayerFS checkpoints (B6), phones, dsh/kimi transcript paths (open
question — dsh handoff limited to `--session-id` resume).

**Acceptance:**
```sh
mola session handoff --id <claude-session-on-main> --to jlu-pc
# expect: probe ok → lease taken → WIP commit created (no push) → transcript + pack
# transferred → lease released → jlu-pc resumes:
#   on jlu-pc: claude --resume <id> -p "continue"   # answers with full prior context;
#                                                  # WIP commit present in the worktree
mola goal status <goal> --json    # during handoff a concurrent claim attempt exits 77 (lease)
```
**Depends on:** B4 (KV leases, Object Store).

---

## B6 — LayerFS checkpoints + remote control (phones)

**Goal:** handoff stops copying directory trees; a phone can watch goals and approve gates.

**Scope:** crate `mola-layerfs` (checkpoint/branch/restore/diff — verbs verified against a
captured `layerfs --help` first); LayerFS replaces WIP-commit as the handoff unit where
available; `mola serve --remote` (bound to the tailnet IP, `tailscale serve` fronting;
endpoints `GET /sessions`, `POST /sessions/:id/prompt`, `GET /goals`,
`POST /gates/:id/approve`; tailscale-whois allow-list + bearer token); gate push via the
existing AstrBot/NapCatQQ channel; optional: second NATS node, Trigger.dev plugin for
long-running orchestration.

**Out of scope:** a native phone app (QQ bot + `mola serve` API is the decided answer);
`tailscale funnel`/public exposure.

**Acceptance:**
```sh
mola session handoff --id <sid> --to jlu-pc --checkpoint layerfs
# expect: no directory-tree copy in the transfer log; checkpoint ref in the artifact record;
# resume on jlu-pc works as in B5
mola serve --remote &      # expect: listens on the tailnet IP only; unknown peer → 403
# phone (or curl over tailnet): POST /gates/<id>/approve → gate.resolved event;
# an unapproved gate expires fail-closed (action never runs)
tailscale serve status     # expect the https://<host>.<tailnet>.ts.net → mola serve mapping
```
**Depends on:** B5 (handoff flow), B4 (gates); LayerFS available on the target machines.
