# `mola` CLI design brief (the main session owns this; DSH designers read it)

## Goal
One CLI, `mola`, that sits above every agent, tool and machine Mola-maker uses, the way magpie sits above models. It **routes, controls and coordinates** different coding agents (Claude Code, Codex, Kimi, Grok, Antigravity, Devin, Pi, OpenCode, omp, DSH, Orca), the tools around them (git, gh, OMC, rtk, magpie, LayerFS, tailscale, docker), and the environments they run in (Windows, WSL, Tailscale peers, cloud VMs), and it supports **real-time cloud collaboration** between agents on different machines: "the ultimate multi-machine agent".

It ships **inside the mstack repo** (`cli/` for TypeScript, `crates/` for Rust) and is packaged together with the mstack skills: the skills are the "how to work", `mola` is the "what runs where".

## Hard constraints (decided — do not reopen)
1. **Languages: TypeScript and Rust.** TS (Node ≥22, pnpm workspace) for the host, commands and most plugins. Rust where it earns its place (process supervision/PTY, the sync daemon, LayerFS bindings, anything hot or long-running). Decide and justify the TS↔Rust boundary (napi-rs addon vs. separate binary over JSON-RPC/stdio).
2. **Everything is a plugin.** The core only loads plugins, routes commands and events, and holds config and state. Every agent adapter, tool adapter, environment, sync backend and even built-in command is a plugin with a manifest and declared capabilities. Third-party plugins are installable.
3. **Routing layer like magpie.** Given a task and a policy, `mola` picks which agent, on which machine, in which workspace, and with which model route (through magpie, never by editing agent configs). It discovers agents and CLIs on PATH and in magpie (`magpie ls`) automatically.
4. **Integrate, don't rebuild.** Wrap what exists: magpie (models, MCP, instructions, RTK), OMC (plans, brainstorm/interview, team, state/notepad, hooks), mstack skills (m-start … m-team), gh/git (worktrees, PRs), rtk, DSH headless (`dsh --profile mola-cli --patch`), Orca CLI, LayerFS, tailscale. Where a tool already does the job, the plugin is a thin adapter.
5. **Hooks are first-class.** There is a unified event/hook bus (before/after tool run, session start/end, task done, error), with adapters that bridge each agent's native hooks (Claude Code hooks, Codex hooks, OMC hooks, DSH plugin hooks) into it.
6. **Cloud collaboration is pluggable.** Define a sync/event backend interface. Evaluate popular, easily extended options (for example NATS, Redis Streams, Supabase Realtime, Cloudflare Durable Objects / Agents SDK, Liveblocks/Yjs, Temporal / Inngest / Trigger.dev, plain Tailscale P2P), and choose **one default** that works on the user's real topology (Windows main machine + WSL, jlu-pc 4090 Ubuntu, ROG, Huawei laptop, Aliyun / Tencent / BandwagonHost VMs, all on a Tailscale mesh; phones). Note the constraints: mainland-China networks, cost, self-hosting.
7. **Safety.** Irreversible or outward actions (push, merge, publish, delete, payments, messages to people) need explicit approval in the policy. Secrets never leave the user's machine or vault. Remote control requires authenticated peers.
8. **Batches.** The design must split delivery into batches (B1, B2, …). Each batch is useful on its own and has acceptance criteria that can be checked with commands. B1 should land quickly and wrap things that already work today (DSH headless dispatch, magpie routes, rtk, mstack routing, agent discovery, `mola doctor`).

## Inputs (read them; do not invent CLI flags that are not in them)
- `cli/design/inputs/*-help.txt`: the real `--help` of every agent CLI and tool on this machine; `magpie-*.txt`: agents, routes and library.
- `cli/design/inputs/0*.md`, `mola-infra-open-questions.md`: the multi-machine architecture already drafted (topology, network, LLM gateway, session resume, knowledge/config, roadmap).
- `cli/design/inputs/orchestration.md`, `orca-cli.md`, `coordinator-loop.md`, `messaging-and-gates.md`, `low-level-topology.md`: Orca's worker model.
- `cli/design/inputs/dsh-cli-help.md`, `dsh-architecture.md`: DeepSeek Harness.
- The mstack repo itself: `FRAMEWORK.md`, `skills/*/SKILL.md` (especially m-dispatch, m-team, m-goal, m-guard), `skills/m-dispatch/references/harness-commands.md`, `skills/m-guard/references/known-traps.md`.

## Deliverables
- `cli/design/DESIGN.md`: the merged architecture (written by the synthesizer).
- `cli/design/sections/<area>.md`: one per designer (core-plugins, adapters-routing, envs-collab).
- `cli/design/adr/NNNN-<title>.md`: one ADR per significant decision (TS↔Rust boundary, plugin manifest and loading, default sync backend, routing policy, hook bus).
- `cli/design/BATCHES.md`: B1…Bn, each with scope, the packages/crates it touches, and its acceptance commands.
