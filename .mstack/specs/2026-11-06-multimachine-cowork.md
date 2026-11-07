# 多机协同：上下文同步、云端改代码、多传输通道（m-think wild mode）

## Readiness (reference only, not a gate)
- goal: 0.6
- constraints: 0.8
- acceptance: 0.4

## Facts measured today (2026-11-06)
- Tailscale 在线：main(wandanghe)、jlu-pc、kamin(ROG)、muse；whymola 20 天、iPhone 6 天、小米 15U 27 天、Pad 100 天离线。
- **main → jlu-pc 只能走 DERP 香港中继，677 ms，无直连；main → ROG 2 s 后超时。**最近的 DERP 是洛杉矶；阿里云自建 DERP 未生效。
- 三台云机（阿里云 2c2g / 腾讯云 4c4g / BWH LA 2c2g）**不在 tailnet 上**。
- 已有的同步通道：GitHub（代码）、magpie 的 WebDAV/S3/GitHub 配置同步、Feishu/QQ bot、DSH remote（P2P E2E）。
- mola 设计 B3–B5：Environment 插件、attach-first 会话、NATS(腾讯云)+Yjs+Tailscale、handoff、LayerFS checkpoint。

## Premise attack
1. "把上下文同步到每台机器"可能是错的问题：多数机器长期离线；ADR-0002 的 attach-first（一台常驻机干活，其他设备只连上去）更省。要同步的应是**小而关键的状态**（任务、决策、handoff、memory），不是整棵工作区。
2. "在云上改"要先定义哪个云：2c2g/4c4g 云机不适合跑开发；真正能跑的是 jlu-pc（4090）、Claude Code / Codex 云会话、GitHub。云机更适合当**中继/信箱/常驻协调者**。
3. "多传输通道"是真实需求（今天的实测证明 Tailscale 是瓶颈），但核心不是多加通道，而是**一层自动选路 + 回退 + 断网可续传**。

## Lenses
| # | 视角 | 结论 |
|---|---|---|
| 1 | Job | 真实需求：在任何设备上（含手机）说一句"继续"，就能接着上次的工作；agent 在常驻机上不断线地干活；换机器不丢决策与进度。 |
| 2 | 第一性 | 需要搬动的只有三类字节：小状态（KB 级 JSON/MD）、代码改动（git 对象）、大产物（模型/数据/截图，MB–GB）。三者应走不同通道。 |
| 3 | Inversion | 必败路径：①依赖原机器在线；②双向自动同步工作区导致冲突/.git 损坏；③单一通道（Tailscale 中继 677 ms）卡死；④密钥被同步到云；⑤两个 agent 同时改同一文件。每条都要被设计挡住。 |
| 4 | ×10/÷10 | ×10 机器：点对点同步 N² 爆炸 → 必须有 hub（信箱）。÷10：只有 main+jlu-pc 时，git + tmux attach 就够了。 |
| 5 | 去约束 | 无限预算：每台机器挂 Codespaces 式云开发机。零预算一下午：jlu-pc 上 tmux + git push/pull + 一个 `.mstack/` 同步脚本。 |
| 6 | 类比 | 游戏 netcode（权威服务器 + 客户端预测）→ jlu-pc 是权威；邮件/信箱（store-and-forward）→ 离线设备；git（内容寻址 + 合并）→ 代码；CDN（就近节点）→ 选路。 |
| 7 | 对手 | 校园网封 UDP、NAT 对称；云机被扫；某台笔记本被偷；agent 误删；中间人。 |
| 8 | 运维 | 凌晨 3 点 jlu-pc 关机/实验室断电：需要第二常驻点（腾讯云做协调者，不做算力）；半坏状态要在 `mola dash` 一眼看出走的是哪条通道。 |
| 9 | 时间 | 1 年后：LayerFS 成熟可接管工作区分支；5 年后：Tailscale/NATS 可能被替换——通道必须插件化。 |
| 10 | Outcomes | 见下节：会话搬运普遍不可靠；代码走 git 最稳；Tailscale 在硬 NAT 下必走中继，自建 DERP 需域名。 |

## Wild round（未筛选，≥12，含 ≥3 离谱项）
1. attach-first：jlu-pc 常驻 tmux，所有设备 mosh/ssh attach，不同步工作区。
2. git 作为唯一工作区通道：每个 agent 一个分支 + 自动 checkpoint commit，推 GitHub/Gitee/自建 Gitea。
3. NATS hub（腾讯云）+ 各机 leaf node：事件、任务、租约、KV；离线 store-and-forward。
4. `.mstack/` 状态目录走 CRDT（Yjs）同步，多机并发写不冲突。
5. 对象存储信箱（OSS/COS/R2）：大产物与快照异步投递，离线设备上线后拉取。
6. 自建 DERP（阿里云）+ 打通直连：把 677 ms 降到国内水平。
7. EasyTier/frp/rathole 作为 Tailscale 的备用隧道。
8. "云上改代码"= 在 jlu-pc 或 Claude Code 云会话里改，本地只看 diff 和审批。
9. LayerFS：每个 agent 一个 Branch，checkpoint 作为跨机搬运单位（B5）。
10. Syncthing 只同步 `.mstack/` 与 memory（排除 .git 和工作区）。
11. **离谱**：IM（飞书/QQ bot）作为最低带宽控制通道——手机发一句话，agent 在 jlu-pc 上开干，结果回到 IM。
12. **离谱**：把整个 agent 会话（jsonl + 工作区 diff）打包成一个"胶囊"文件，任何通道（U 盘、邮件、网盘）都能搬，到哪台机器都能 `mola resume capsule.zip`。
13. **离谱**：不搬上下文，搬"重建上下文的配方"：只同步 goal/plan/决策日志，新机器上让 agent 从 git + 配方重新长出上下文（像 Nix 的可复现构建）。
14. **离谱**：手机就是 hub——手机常在线，做信箱和审批端，电脑都是 worker。
15. 选路器：每次传输按 {大小, 时效, 在线状态, 实测延迟} 自动选通道并回退（direct → DERP → frp → git → 对象存储 → IM）。

## Outcomes (evidence: research/cowork-sessions.md, cowork-files.md, cowork-transport.md)
| Topic | What happened when others tried it | Source (details in the files) | Effect on this design |
|---|---|---|---|
| Moving sessions | Claude Code `--teleport` restores only the first turn and drops history. With Remote Control, execution stays on the original machine. Copying `~/.claude/projects` to a machine with a different username breaks resume, because paths are hard-coded. | claude-code issues #94836 #92144 #45447 | **Don't move session files.** On another machine, rebuild context from a recipe. |
| Remote persistence | tmux/mosh attach is the usual pattern. A reconnecting Remote-SSH client kills the remote process group (#73304). | blogs + issue | Run tmux on the always-on machine; agents must not depend on the client connection. |
| Cloud dev environments | Codespaces bills storage even when stopped. Codex cloud caches containers for at most 12 h. A Devin handoff starts a new VM and carries only the uncommitted diff. | docs / search snippets [single] | Cloud sessions are disposable executors only. State must live in git. |
| File sync | Syncthing community consensus is not to sync `.git`. Mutagen conflicts need manual resolution. rclone with several processes sharing one cache can corrupt data. sshfs is slow on small files. | Syncthing forum, Mutagen/rclone docs | Code moves only through git; workspaces never live on network mounts. |
| Agent file systems | LayerFS 1.1.0 returns Conflict on concurrent commits to the same file (unless `.lww`) and only offers the Disposable durability tier. AgentFS is BETA and has no Windows support. | both READMEs | Defer LayerFS to B5; use git worktrees for now. |
| Direct connections | A hard NAT on either side means relayed traffic. Tailscale says typical direct-connection success is above 90%. | tailscale.com/kb/1411, blog | Today's 677 ms via the HK relay suggests the campus network is hard NAT. |
| Self-hosted DERP | Needs a domain, HTTPS (port configurable), STUN 3478, `--verify-clients`. Port 443 in mainland China needs an ICP filing (备案). | tailscale.com/kb/1118 | If molamaker.cn is already filed, use a subdomain of it. |
| Backup tunnels | No reliable data on EasyTier success rates in China. rathole only has a 2021 localhost benchmark. | one V2EX post, project READMEs [U] | Pluggable fallback; measure before making any of them a default. |
| Async channels | GitHub is slow from mainland China (one blog: ~20 KB/s); Gitee is fast. R2's quality in China is the vendor's own claim. | blogs [A]/[U] | Let the router measure, then pick GitHub or a Gitee/Gitea mirror. |

## Options (1–5: value / cost (5 = cheap) / risk (5 = low) / reversible / fit with what exists)
| # | Option | Value | Cost | Risk | Rev. | Fit | Total |
|---|---|---|---|---|---|---|---|
| 1 | Attach-first: jlu-pc works around the clock, other devices attach | 5 | 5 | 4 | 5 | 5 | **24** |
| 13 | Move the recipe, not the context (goal/plan/decisions/handoff + git rebuild) | 5 | 4 | 5 | 5 | 4 | **23** |
| 2 | git as the code channel: one branch per agent/machine + checkpoint commits | 5 | 4 | 4 | 5 | 5 | **23** |
| 8 | "Edit in the cloud" = edit on jlu-pc or in a cloud session; review the diff locally | 5 | 4 | 4 | 5 | 5 | **23** |
| 6 | Fix direct connections: self-hosted DERP (filed domain) / hole punching | 5 | 3 | 4 | 5 | 5 | **22** |
| 15 | Router: pick a channel per payload class, with automatic fallback | 5 | 3 | 4 | 4 | 4 | **20** |
| 5 | Object-storage mailbox (large artifacts, content-addressed) | 3 | 4 | 4 | 5 | 3 | 19 |
| 11 | IM as the lowest-bandwidth control channel (one line from the phone) | 4 | 3 | 3 | 5 | 4 | 19 |
| 3 | NATS hub (Tencent Cloud) + leaf nodes | 4 | 3 | 3 | 4 | 4 | 18 |
| 7 | EasyTier / frp backup tunnel | 4 | 3 | 3 | 5 | 3 | 18 |
| 10 | Syncthing for `.mstack/` and memory only | 3 | 4 | 3 | 5 | 3 | 18 |
| 12 | Session "capsule" file | 3 | 3 | 4 | 5 | 3 | 18 |
| 9 | LayerFS: one branch per agent | 4 | 2 | 2 | 4 | 5 | 17 |
| 4 | Sync `.mstack/` with a Yjs CRDT | 3 | 2 | 3 | 3 | 2 | 13 |
| 14 | Phone as the hub | 1 | 2 | 2 | 3 | 1 | 9 |

**Chosen design (three parts)**
1. **Compute in one place; devices are windows** (1 + 8). jlu-pc is the authoritative executor: agents run in its tmux sessions and git worktrees. "Editing in the cloud" means editing on jlu-pc (or in a disposable cloud session). Any device takes part through `mola sessions attach` or by reviewing the diff.
2. **Move the recipe, not the session** (13 + 2). Only three kinds of things cross machines, each on its own path:
   - **Small state** (`.mstack/` goals, plans, decisions and handoff; memory; lessons): one private git repo.
   - **Code**: project git branches (`agent/<machine>/<task>`).
   - **Large artifacts**: object storage, content-addressed.
   On a new machine the agent rebuilds its context from the recipe plus git; `~/.claude/projects` is never copied.
3. **Several channels with automatic routing** (6 + 15, absorbing 7/11/5). Choose a channel by payload class (control / small state / code / large artifact). On failure, fall back in this order: Tailscale direct → self-hosted DERP → backup tunnel (EasyTier/frp, chosen after measurement) → public git (GitHub / Gitee mirror) → object storage → IM bot (control commands and notifications only). `mola net doctor` measures every path, and `mola dash` shows which path is in use.

**Steelman for the runner-up (NATS hub)**: multi-machine m-team rounds need millisecond task claiming, leases and presence, which git can't provide. NATS leaf nodes buffer while disconnected and dial out, which suits laptops that are often offline. So it is **deferred, not cut**: add it in B4 once multi-machine m-team actually runs, keeping the `SyncBackend` interface from ADR-0005.

**The one idea kept from the wild options**: #11, IM as a control channel. Send "继续" from the phone, the agent on jlu-pc picks up from the `.mstack/` recipe, and the result comes back to IM. This still works when every network path is broken, as long as both ends can reach IM.

**Kill list**
- Syncing `.mstack/` with a Yjs CRDT: a single writer plus append-only logs is enough; a CRDT is pure addition (principle 2).
- Syncing `.git` or a live workspace with Syncthing or a cloud drive: community consensus is that it corrupts.
- sshfs/rclone mounts as agent workspaces: slow, and concurrent writes are unsafe.
- Copying `~/.claude/projects` to move sessions, or relying on `--teleport`: paths are hard-coded and only the first turn is restored.
- Phone as the hub: phones are offline for long stretches (iPhone 6 days, Pad 100 days).
- Supabase / Durable Objects / Liveblocks: already excluded by ADR-0005 (mainland network, not self-hostable).

**Inversion check**:
1. Original machine offline: the recipe is in git, so any machine can rebuild.
2. Two-way sync conflicts: code goes only through git, and state has a single writer.
3. One channel stuck: the router falls back.
4. Secrets end up in the cloud: the state repo holds only `.mstack/` and memory, a check scans for secret patterns, and `.env` never enters the repo.
5. Two agents edit the same file: one branch/worktree per agent, merged through m-review.

## Goals / Non-goals / Anti-goals
- **Goals**: from any device, one "继续" picks up work running on any machine; a laptop that was offline for days catches up on state and code with one command; when any channel breaks, traffic moves to another automatically; every path is visible in `mola dash`.
- **Non-goals**: real-time co-editing of the same file; using cloud VMs as development machines; moving native agent session files between machines.
- **Anti-goals**: syncing secrets or the whole `~/.claude` directory anywhere; adding channels for their own sake (a channel only joins the default chain once it has measured data).

## Mapping onto mola (revised B3–B5)
| Batch | Contents | Acceptance |
|---|---|---|
| **B3a Network and routing** | `mola net doctor` measures Tailscale direct/relay latency, SSH reachability, GitHub/Gitee speed and object storage. A `TransportRouter` plugin interface with one plugin per channel (tailscale, ssh, git-https, object-store, im). `mola dash` shows the path in use. | main→jlu-pc shows "via DERP(hkg) 677 ms"; after the direct-connection fix, measure again with a target under 100 ms |
| **B3b Always-on host + attach** | An `env-ssh` adapter for jlu-pc; tmux sessions on jlu-pc managed by mola; `mola sessions list/attach`; `mola run --on jlu-pc`. | Attach to a running agent from the phone or a laptop; the agent keeps running after you disconnect |
| **B3c Recipe sync** | `mola sync`: `.mstack/` + memory + lessons ↔ a private state repo (single-writer rule, append-only logs, secret scan before each commit). Code branch convention `agent/<machine>/<task>`. | ROG comes back after 3 days offline; `mola sync && mola continue` picks up the goal from jlu-pc with zero conflicts |
| **B3d IM control channel** | Feishu/QQ bot ↔ mola on jlu-pc. Carries only control commands and result summaries; needs an allowlist and confirmation. | Send "继续 <goal>" from the phone; work starts on jlu-pc within 1 minute and the result comes back to IM |
| B4 (original plan, deferred) | NATS hub + leaf nodes; tasks, leases and presence for multi-machine m-team | One multi-machine m-team round completes |
| B5 (original plan) | LayerFS checkpoints as the unit of transfer | — |

## Assumptions
| Assumption | Basis | Reversible |
|---|---|---|
| jlu-pc can stay on long-term as the authoritative executor | Online today, and mola-infra plans it this way, but the open questions about whether the lab shares it or powers it off are unanswered | Reversible (move coordination to the Tencent 4c4g VM and compute back to main) |
| molamaker.cn is ICP-filed, so `derp.molamaker.cn:443` can run on Aliyun | Memory records an earlier api.molamaker.cn relay; the personal site is deployed on Aliyun | Reversible (fall back to BWH LA or another port) |
| The cloud VMs are reachable over SSH (not measured: blocked by the permission check) | mola-infra docs | — |
| A private GitHub repo is fast enough for the state repo | Small state is KB-sized | Reversible (add a Gitee/Gitea mirror) |

## Decisions (2026-11-06, user)
1. jlu-pc 是常驻权威执行机（可长期开机）；腾讯云 4c4g 只做协调和信箱。
2. molamaker.cn 已备案：在阿里云 2c2g 上自建 DERP `derp.molamaker.cn:443`（`--verify-clients`）。
3. 状态仓库：新建私有 `Mola-maker/mola-state`，只放状态，提交前扫密钥。

## decisions-pending（已全部决定，见上）
1. Can jlu-pc stay on (shared lab, power cuts)? This decides where the authoritative executor lives.
2. Which machine and domain to use for the self-hosted DERP (you need to confirm that molamaker.cn is filed and that a subdomain can be added).
3. State repo: a new private `Mola-maker/mola-state`, or put it in the existing `mola-infra`.
