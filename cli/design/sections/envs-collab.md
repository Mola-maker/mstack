# 3 · ENVIRONMENTS + REAL-TIME CLOUD COLLABORATION（envs-collab）

> 设计者：DSH design worker（envs-collab area）。依据 `cli/design/BRIEF.md` 硬约束与 `cli/design/inputs/` 的 01-topology、02-network、04-session-resume、05-knowledge-and-config、07-roadmap、`mola-infra-open-questions.md`、orca-cli/orchestration/coordinator-loop、tailscale-help.txt、dsh-cli-help.md。**只用输入里出现过的真实 CLI 标志**；用到的、但不在 inputs 里的标准工具（wsl.exe / tmux / docker / ssh）逐一标注为「待核实」。

---

## 0. 一句话结论

- **环境**：一个 `environment` 插件接口（exec / sync / forward / health），五个内置适配器（local-windows、wsl、ssh-peer、cloud-vm、container），全部包在已有工具（tailscale、OpenSSH、wsl.exe、docker、LayerFS）外面，不重写任何传输。
- **会话**：按 mola-infra Phase 1/3 走 attach-first——常驻主机（jlu-pc）上跑会话，其它设备只是终端；handoff（路径改写 + lease + LayerFS checkpoint）是第二层，B4 之后落地。
- **协作**：共享事件/状态模型（goal / task / claim-lease / artifact / presence / log / gate），默认后端为**自托管 NATS + JetStream**（腾讯云常驻 VM + 每机 leaf node），其它后端（Redis Streams、Supabase、Cloudflare DO、Yjs 独立、Temporal/Trigger.dev、纯 Tailscale）走同一个 `sync-backend` 插件接口。
- **安全**：tailnet 身份做 peer 认证基座，NATS 每机一张 credential，密钥只留在 mola-env（chezmoi + age），危险动作一律走 gate。

---

## 1. Environment 插件接口

### 1.1 类型草图（TS，host 侧）

```ts
// packages/mola-plugin-api/src/environment.ts
export type EnvId = string;                      // 'main-wsl'、'jlu-pc'、'aliyun' …
export type EnvKind = 'local-windows' | 'wsl' | 'ssh-peer' | 'cloud-vm' | 'container';

export interface EnvSelector { env: EnvId; workdir?: string; }

export interface ExecRequest {
  argv: string[];                                // 不经 shell 拼接
  cwd?: string;
  env?: Record<string, string>;                  // 只允许 $ref 引用，见 §6.3
  timeoutMs?: number;
  pty?: boolean;                                 // 需要交互式时（Rust 侧 PTY）
  stdin?: string;                                // '-' 语义：从调用方读
}
export interface ExecResult {
  exitCode: number; stdout: string; stderr: string;
  durationMs: number;
}
export interface SyncRequest {
  direction: 'push' | 'pull';
  paths: string[];                               // 相对 workdir
  exclude?: string[];                            // node_modules / target / .git 默认排除
  mode: 'rsync' | 'tailscale-file' | 'nats-object';   // 见 §1.4
}
export interface ForwardRequest {
  targetPort: number;                            // 远端端口
  bindPort?: number;                             // 本机端口，缺省 OS 分配
  scope: 'tailnet' | 'public';                   // tailnet → tailscale serve；public → funnel（需显式批准）
}
export interface ForwardHandle { url: string; close(): Promise<void>; }

export interface Health {
  reachable: boolean;
  latencyMs?: number;                            // tailscale ping
  detail: string;                                // 供 mola doctor 输出
}

export interface EnvironmentAdapter {
  kind: EnvKind;
  id: EnvId;
  probe(): Promise<Health>;                      // 探测，不产生副作用
  exec(req: ExecRequest): Promise<ExecResult>;
  sync(req: SyncRequest, workdir: string): Promise<{ bytes: number; manifestRef?: string }>;
  forward(req: ForwardRequest): Promise<ForwardHandle>;
}

export interface EnvironmentPlugin extends PluginManifestShape {
  capabilities: ['environment'];
  environments: EnvironmentAdapter[];
}
```

Rust 侧（`mola-syncd` / 远程执行守护进程）通过 JSON-RPC over stdio 暴露同一组方法（`env.exec`、`env.sync`、`env.forward`），TS host 不直接开网络连接——TS↔Rust 边界遵循「TS↔Rust boundary」ADR（PTY、长连接、rsync 式同步这类长驻/热路径放 Rust）。

### 1.2 五个内置适配器 → 真实工具映射

| 适配器 | kind | exec 底座 | sync 底座 | forward 底座 | 证据来源 |
|---|---|---|---|---|---|
| `local-windows` | local-windows | 直接 spawn（Rust 侧，含 PTY） | 本机文件系统 / LayerFS | `tailscale serve` | tailscale-help.txt：`serve` "Serve content and local servers on your tailnet" |
| `wsl` | wsl | `wsl.exe -d <distro> --exec <argv>`；路径经 `/mnt/e/...` 映射（MSYS_NO_PATHCONV 已知陷阱，m-guard） | 本机文件系统（Windows↔WSL 同盘） | 同上（WSL 内端口 Windows 可直接访问） | ⚠️ inputs 无 wsl.exe help；`-d`/`--exec` 为 Windows 文档化标志，实现时核实 |
| `ssh-peer` | ssh-peer | `tailscale ssh <host>`（输入里有），OpenSSH 兜底（ControlMaster 复用连接） | `rsync` over tailnet SSH；小文件走 Taildrop | `ssh -L/-R` 隧道；纯 TCP 用 `tailscale nc <host> <port>`（stdin/stdout 桥接） | tailscale-help.txt：`ssh`、`nc`、`file`、`drive` |
| `cloud-vm` | cloud-vm | 同 ssh-peer（阿里云/腾讯云/BWH，公网 22 关闭，只走 tailnet——02-network） | rsync；NATS Object Store 做跨机搬运 | `tailscale serve`/`funnel`（LA 出海节点场景） | 01-topology、02-network |
| `container` | container | `docker exec <c> -- <argv>`；compose 起停 | bind mount / `docker cp` | `docker port` + 适配器 forward | ⚠️ inputs 无 docker help；`exec`/`cp`/`port` 为标准子命令，实现时核实 |

**缺失能力与最小 workaround（按 BRIEF 要求明说）**：

1. `tailscale` 没有 `cp` 子命令。跨机小文件：`tailscale file send/recv`（Taildrop，要求两端 tailnet 在线）；目录级：`tailscale drive`（"Share a directory with your tailnet"）或 rsync over `tailscale ssh`。大块搬运（handoff）走 NATS Object Store（见 §4）。
2. 任意 TCP 端口穿透：`tailscale nc` 只提供 stdin/stdout 桥接，不是监听式转发。监听式转发用 `ssh -L`（OpenSSH 标准标志，实现时核实版本支持）；`tailscale serve` 只服务 HTTP/TLS。
3. `herdr`、`LayerFS`、`OpenAgentCore` 在 starred catalog（06）中列为目标组件，但 inputs 里没有它们任何 CLI help——它们的适配器先定义为占位插件（capability 声明了但 `probe()` 返回 `reachable:false`），等 help 抓取后补齐，**不臆造标志**。
4. Xiaomi Pad / iPhone / 小米 15U 是**客户端**，不注册为 env（见 §5）。

### 1.3 映射到用户真实拓扑（01-topology）

| 设备（01-topology 名） | mola 环境 | 适配器 | 角色 | 备注 |
|---|---|---|---|---|
| 机械师 main `wandanghe` | `main`、`main-wsl` | local-windows + wsl | magpie 路由、Orca 桌面端、日常开发 | dsh web 的「只绑具体本机 IP、拒绝通配」模式（dsh-cli-help.md `--host`）是 env 网络绑定的参照 |
| 华硕 ROG `kamin?` | `kamin` | ssh-peer（后期装 mola daemon 升级为 peer） | 第二开发机 | 长期离线（16h），所有面向它的操作必须有超时与失败提示 |
| Huawei 笔记本 `whymola?` | `whymola` | ssh-peer | Linux worker（herdr / LayerFS） | 离线 17d，同上 |
| jlu-pc（4090 Ubuntu） | `jlu-pc` | ssh-peer + 常驻 mola daemon | **常驻 session 主机**（04-attach 第一层）、langfuse、LayerFS 沙箱 | 是否可常驻是 open question；B2 验收即验证这点 |
| 阿里云 2c2g | `aliyun` | cloud-vm | 国内入口：自建 DERP、new-api | **自建 DERP 让 NATS 流量也走 tailnet 直达**（02-network） |
| 腾讯云 4c4g | `tencent` | cloud-vm | 常驻服务 → **NATS 主节点默认落点** | 4c4g 是三台云机中最宽裕的 |
| BandwagonHost 2c2g LA | `bwh` | cloud-vm | exit node、出海 | 只放轻量服务；NATS 不放这 |
| muse | `muse` | ssh-peer | nanoMuse 节点 | |
| Mix 2 | `mix2` | 不做 env | android-agent-mcp（adb over tailnet）的受控设备 | 06-starred-catalog |
| 手机 ×3 | — | 不注册 | 遥控客户端（§5） | |

设备名 `kamin`/`whymola` 是推测（open question），`mola envs` 从 `tailscale status --json` 读真实机器名，不写死——tailscale-help.txt 的 `status`/`whoami` 是唯一机器名来源。

### 1.4 health 与 doctor

`mola doctor --envs` 对每个已注册 env 依次跑 `probe()`：
1. `tailscale status --json` → 本机 tailnet 状态、peer 列表（tailscale-help.txt 有 `status`）；
2. 每个目标 `tailscale ping <peer>` 拿延迟与路径（direct/DERP）；
3. ssh/WSL 通道冒烟测试（`echo ok`）；
4. NATS leaf node 与主节点的连接状态（§4.4）。
输出一张表，失败项给出修复建议（如「自建 DERP 未生效：运行 tailscale netcheck」——`netcheck` 在 help 里）。

---

## 2. 会话、attach 与 handoff（复用 mola-infra 阶段）

mola 把 04-session-resume 的两层方案原样接进来，不新发明协议：

### 2.1 会话注册表

每台装了 mola daemon 的机器（B2 起：jlu-pc；随后各开发机）把自己可见的会话注册到 KV（§4.3 的 subject 表）：

```jsonc
// KV bucket `sessions`，key = "sessions/<host>/<id>"
{
  "id": "s_orca_42",
  "host": "jlu-pc",
  "env": "jlu-pc",
  "kind": "tmux",                    // tmux | herdr | claude | codex | dsh | orca-terminal
  "title": "mstack-cli-design",
  "agent": "claude",
  "cwd": "/home/mola/mstack",
  "resumable": true,                 // harness 有 --resume / --session-id
  "attachCmd": "tmux attach -t mstack-cli-design",
  "updatedAt": "2026-11-05T03:00:00Z"
}
```

- tmux 会话：`tmux ls`（⚠️ inputs 无 tmux help，`ls`/`attach -t` 为标准用法，实现时核实）。
- dsh headless 会话：`dsh --profile headless --session-id <id> --json`（dsh-cli-help.md）——`--session-id` 是真实标志，handoff/续跑用它。
- Orca 终端：`orca terminal list --json` / `terminal wait --for tui-idle`（orca-cli.md）。

### 2.2 attach（第一层，B2）

1. `mola sessions`：聚合所有在线 env 的 KV 会话表，按 host/agent/活跃度排序输出；
2. `mola sessions attach --id s_orca_42`：
   - 若会话在本机：直接切 tmux/Orca terminal；
   - 若在远端：`tailscale ssh jlu-pc -t "tmux attach -t …"`（tailscale-help.txt `ssh`）；Orca 会话则 `orca terminal switch`；
   - 手机场景：不 attach，走 §5 的 remote API。
3. 零同步、零冲突——与 04 的结论一致：80% 场景只做 attach。

### 2.3 handoff（第二层，B4；LayerFS 后接管，B5）

按 04-session-resume 的流程，mola 提供的是**编排与凭证**，不是新的传输：

1. `mola session handoff --id <sid> --to <env>` 发起；目标 env 必须通过 `probe()`；
2. **冻结工作区**：优先 LayerFS checkpoint（jlu-pc / whymola 上可用）；没有 LayerFS 的机器退化为 `git add -A && git commit -m "mola-handoff WIP"`（不 push）；
3. **单写者租约**：`mola.lease/session/<sid>` KV 抢锁（§4.3）；抢不到即中止——避免 jsonl 分叉（04 的核心风险）；
4. **导出会话记录**：按 harness 类型取 transcript（Claude Code `~/.claude/projects/<编码路径>/*.jsonl`、Codex `~/.codex/sessions/`；dsh/Kimi 位置是 open question，先以 `--session-id` 导出 dsh）；
5. **路径改写**：按 mola-env 的 `paths.toml`（05-knowledge-and-config 已规划）把 transcript 中 cwd 从源机路径映射到目标机路径；改写表本身也是 artifact 存档；
6. **搬运**：checkpoint + transcript 打包进 NATS Object Store（§4.3 `mola.artifacts`）；目标机拉取。fallback：`tailscale file`（两端都在线时）；
7. **释放与重取**：源机释放 lease → 目标机取 lease；
8. **恢复**：目标机恢复工作区（LayerFS checkout / git WIP）、把 transcript 放到按路径改写后的目录、`claude --resume <id>` / `codex resume` / `dsh --session-id`；
9. **不搬**：凭证、`node_modules`/`target`、缓存（05 的原则）；bootstrap 在目标机按 AGENTS.md 重建。

LayerFS 接入后，第 2、6、8 步换成 checkpoint/branch 语义（04 明确这是 LayerFS 的演示用例），mola 的流程与 lease 不变——**mola 只依赖「导出/导入一个可搬运工作区单元」这一抽象**。

---

## 3. 实时协作：共享事件/状态模型

目标：不同机器上的 agent 对同一个 goal 协作，语义对齐 Orca（run / task / worker / dispatch）与 m-team（轮次 / 角色 / 汇报），让 mola 是**总线**而不是又一个协调器。

### 3.1 核心类型（TS；Rust 侧同构 serde）

```ts
export type GoalId = `goal_${string}`;
export type TaskId = `task_${string}`;
export type AgentId = string;   // "dsh:headless@jlu-pc" | "claude@kamin" | "human:phone"

export interface Goal {
  id: GoalId;
  title: string;
  status: 'open' | 'in-progress' | 'blocked' | 'done' | 'cancelled';
  runRef?:
    | { kind: 'orca'; runId: string; terminal?: string }   // Orca run-create 的 run
    | { kind: 'mteam'; round: number }                     // m-team 当轮
    | { kind: 'mgoal'; file: string };                     // m-goal goal 文件
}

export interface Task {
  id: TaskId;
  goalId: GoalId;
  title: string;
  spec: string;                  // 自包含 brief（Orca task spec / m-dispatch 的要求）
  deps: TaskId[];
  status: 'ready' | 'claimed' | 'done' | 'failed' | 'blocked';
  claim?: Claim;
  env?: EnvSelector;             // 指定在哪台机器跑；缺省由路由策略挑
  worktree?: string;             // Orca worktree selector 或本机 worktree
}

export interface Claim {         // 租约 = claim + fencing token
  agentId: AgentId;
  epoch: number;                 // 单调递增，artifact 写入必须带
  renewsAt: number;              // 心跳续期；过期后他人可 claim
}

export interface Artifact {
  id: string;
  goalId: GoalId;
  taskId?: TaskId;
  kind: 'file' | 'checkpoint' | 'report' | 'pr' | 'session-pack';
  ref: string;                   // NATS Object Store 名 / git ref / Orca worktree id
  sha256: string;
  epoch: number;                 // 产生它的 lease epoch
}

export interface Presence {
  agentId: AgentId;
  host: string;
  env: EnvId;
  state: 'idle' | 'working' | 'blocked' | 'gone';
  sessionId?: string;
  capabilities: string[];        // 供路由层挑选（Routing ADR 用）
  since: number;
}

export type GateRequest = {      // 危险动作审批（BRIEF #7）
  id: string; goalId: GoalId; agentId: AgentId;
  action: 'push' | 'merge' | 'publish' | 'delete' | 'payment' | 'message-human';
  detail: string;
};

export type CollabEvent =
  | { type: 'goal.created' | 'goal.status'; goal: Goal; by: AgentId }
  | { type: 'task.upserted'; task: Task; by: AgentId }
  | { type: 'task.claimed'; taskId: TaskId; claim: Claim }
  | { type: 'task.done' | 'task.failed'; taskId: TaskId; evidence: string[]; epoch: number }
  | { type: 'artifact.added'; artifact: Artifact }
  | { type: 'presence.update'; presence: Presence }
  | { type: 'gate.request' | 'gate.resolved'; gate: GateRequest; approvedBy?: string }
  | { type: 'log.append'; goalId: GoalId; taskId?: TaskId; agentId: AgentId;
      cursor: number; lines: string[] };        // rtk 压缩后的日志切片
```

不变量（用例子说明，不写实现）：
- **单写者**：一个 task 同一时刻至多一个有效 claim；写 artifact/日志必须带 `epoch`，过期 epoch 被拒。
- **幂等重放**：事件带 `seq`（来自 JetStream 流的 stream sequence），客户端按 `(goalId, seq)` 去重——离线重连后重放即可重建状态。
- **spec 自包含**：Task.spec 照抄 Orca 的要求（orca-cli.md "Make each spec self-contained"），跨机 worker 不依赖协调者的上下文。

### 3.2 与 Orca worker 模型的桥

Orca 已有 run/task/worker/dispatch（orchestration.md、coordinator-loop.md），mola 桥接而不是替代：

| Orca 概念（真实命令） | mola 对应 | 桥接方向 |
|---|---|---|
| `orca orchestration run-create --objective` | `mola goal create`（写入 `runRef.kind='orca'`） | mola → Orca：goal 创建时自动 run-create |
| `orca orchestration task-create --spec --deps` | `mola task add` | 双向同步 task 行与 deps |
| `orca orchestration task-list --ready --brief` | `mola task list --ready` | worker 端任选其一 |
| `orca orchestration worker-start --spec --worktree --agent` | mola 路由层在 Orca 主机上选 env 执行 | mola → Orca：目标 env 是 Orca 主机时下发 |
| `orca orchestration send --to dispatch:<id>` | `mola task message` | 双向 |
| `orca worktree ps / terminal wait --for tui-idle` | presence 的数据源 | Orca → mola |

桥接插件（`orca-bridge`）订阅 Orca 的状态（`worktree ps --json`、`inbox`），把 worker 生命周期翻译成 `presence.update` / `task.claimed`；反之 mola task 需要落到 Orca 管理的 worktree 时直接调 `worker-start`（--on <server> 支持远程，见 orchestration.md 的 paired server 说明）。**mola 的增量价值**：Orca 只覆盖装有 Orca 的主机，mola 把 jlu-pc、云机、无 Orca 的 Linux worker 纳入同一张 task/claim 表。

### 3.3 与 m-team 轮次的桥

m-team（FRAMEWORK.md §2 #16）按轮次重组团队：每轮的角色分配写成一个 `goal.rounds[n]` 记录（supervisor = 写入者），角色 → task 的 `claim`。轮末 supervisor 读 `mola goal status --goal <id>`（聚合 task/artifact/log）做诊断，决定下轮角色——**mola 不定义角色，只提供「谁认领了什么、产出了什么证据」的状态面**。

---

## 4. 同步/事件后端：对比与默认选型

### 4.1 插件接口（TS）

```ts
// packages/mola-plugin-api/src/sync-backend.ts
export interface SyncBackend {
  id: string;                        // 'nats'（默认）| 'redis' | 'supabase' | 'cf-durable' | 'yjs' | 'p2p'
  publish(subject: string, event: CollabEvent): Promise<void>;
  subscribe(subject: string, handler: (e: CollabEvent) => void): Promise<Unsubscribe>;
  kv: KeyValueStore;                 // get/put(watch)/delete；put 返回 revision 作为乐观锁
  objects: ObjectStore;              // put/get/info/delete（NATS Obj / Redis 无 → 文件目录 / S3 兼容）
  presence?: PresenceStore;          // 可选：有 TTL 语义的后端提供
  health(): Promise<{ ok: boolean; detail: string }>;
}
```

Rust 守护进程 `mola-syncd` 持有唯一的后端连接，TS host 经 stdio JSON-RPC 调用（与 §1.1 同一条边界决策）；TS 插件也允许直连 `@nats-io/nats-core`（Node ≥22），但同一台机只允许一个连接持有者，避免双连接状态漂移。

### 4.2 候选对比（按 BRIEF #6 的七个维度）

| 后端 | 自托管 | 中国大陆可用性 | 成本 | 运维负担 | TS 客户端 | Rust 客户端 | 离线容忍 | 结论 |
|---|---|---|---|---|---|---|---|---|
| **NATS + JetStream** | ✅ 单二进制（Go），leaf node ~15–20 MB | ✅ 自托管在腾讯云，流量走 tailnet + 自建 DERP，不依赖海外服务 | 0（复用现有 4c4g VM） | 低：单进程 + 文件存储，无外部依赖 | ✅ 官方 v3 monorepo：`@nats-io/nats-core/jetstream/kv/obj` | ✅ `async-nats`（nats-io/nats.rs，活跃） | ✅ leaf node 断链时本地 pub/sub/KV/JetStream 照常，重连后 store-and-forward | **默认** |
| Redis Streams | ✅ | ✅ 自托管 / 云厂商托管 | 0 / 低 | 中：持久化（AOF/RDB）、内存管理、哨兵或主从都要自己管 | ✅ ioredis/redis | ✅ redis-rs/fred | ❌ 无离线缓冲语义，客户端断线即丢窗口 | 备选插件（已有 Redis 的部署可复用） |
| Supabase Realtime | ⚠️ 自托管整套 stack 很重（Postgres + realtime + auth + …），2c2g 放不下 | ⚠️ supabase.com 云在国内不稳；自托管可但工程量大 | 云免费档可用 | 高 | ✅ 官方 JS | ❌ 无一等 Rust 客户端 | ❌ 依赖连接在线 | 不选；Rust 客户端缺失直接违反 B1 语言约束 |
| Cloudflare Durable Objects / Agents SDK | ❌ 仅 Cloudflare 托管 | ❌ 中国网络是 Enterprise + JD Cloud + ICP 的独立订阅，且 DO 不在其可用产品清单内 | 低（美元） | 0 | ✅ | ⚠️ 仅 REST/HTTP，无原生客户端 | ❌ 强在线 | 不选（可用性 + 自托管双输） |
| Liveblocks | ❌ 自托管是 Enterprise 付费附加项 | ❌ SaaS 在国内不稳 | 订阅制 | 0 | ✅ | ❌ | ❌ | 不选 |
| Yjs / Yrs | ✅ 是**库**不是后端（CRDT） | ✅（随宿主） | 0 | 取决于承载它的传输 | ✅ yjs | ⚠️ yrs 活跃（0.28，2026-11 更新）但有一个未决的 soundness advisory | ✅ CRDT 天然离线合并 | **作为状态文档层**叠在默认后端上，不独立当后端 |
| Temporal / Inngest / Trigger.dev | Temporal 重（多组件）；Trigger.dev v4 自托管已简化为 docker compose（含 ClickHouse/Postgres/Redis） | Temporal Cloud 国内不稳；自托管可 | 0 / 低 | 中—高（Temporal 尤甚；Trigger.dev v4 compose 中） | ✅（Trigger.dev/Inngest 是 TS-first） | ❌ | ✅ durable execution | **不进 B 系；作为将来长任务编排的可选插件**，与 task/lease 模型并存 |
| 纯 Tailscale P2P | ✅（无服务） | ✅（已有自建 DERP） | 0 | 0 | —（自己写协议） | — | ❌ 节点离线即断，无持久化/重放 | **作为传输层而非后端**：NATS 流量本来就走 tailnet；单独用它缺 KV/重放 |

引用：NATS leaf node 离线缓冲（[Synadia: NATS DDIL](https://www.synadia.com/blog/nats-ddil-leaf-nodes.md)、[adaptive edge deployment](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/adaptive_edge_deployment.md)）；nats.js v3 模块拆分（[nats-io/nats.js](https://github.com/nats-io/nats.js/)）；Rust 客户端（[nats-io/nats.rs](https://github.com/nats-io/nats.rs)）；Trigger.dev v4 自托管（[docker 文档](https://trigger.dev/docs/self-hosting/docker)、[博客](https://trigger.dev/blog/self-hosting-trigger-dev-v4-docker)）；Cloudflare 中国网络与产品清单（[overview](https://developers.cloudflare.com/china-network/)、[available products](https://developers.cloudflare.com/china-network/reference/available-products/)）；Liveblocks 自托管条款（[data storage](https://liveblocks.io/docs/platform/data-storage)）；yrs（[crates.io](https://crates.io/crates/yrs)、[soundness advisory](https://github.com/rustsec/advisory-db/issues/3118)）。

单源声明标注：Trigger.dev 自托管体验依据官方文档（第一方）；yrs soundness 问题只有一个 issue 源，落地前需复核。

### 4.3 默认拓扑与 subject/流规划

```text
腾讯云 4c4g (tencent) ── nats-server (JetStream, file storage, TLS)
   ▲ leaf node            ▲ leaf node        ▲ leaf node
main(Win/WSL)        jlu-pc            其它 peer/云机      （手机走 §5 API，不接 NATS）
```

- 全部流量走 tailnet；`tailscale ping` 直连失败时经阿里云自建 DERP（02-network），**不再额外加密一层**（WireGuard 已 E2E）。
- subject / bucket 规划（一 goal 一前缀，便于按 goal 清理）：

```text
MOLA_EVENTS (JetStream stream, WorkQueue + 去重 key)
  mola.goals.<goalId>.events        # §3.1 CollabEvent 全量
  mola.logs.<goalId>.<agentId>      # rtk 压缩后的日志切片

KV buckets
  goals.<goalId>                    # Goal 快照（最后写者赢）
  tasks.<goalId>                    # Task 表
  lease.<goalId>.<taskId>           # claim JSON；心跳字段 renewsAt；epoch 单调
  sessions                          # §2.1 会话注册表
  presence                          # Presence（心跳超时 → state='gone'）

Object Store buckets
  artifacts.<goalId>                # Artifact 内容（checkpoint / session-pack / 报告）
```

- **lease 语义**：NATS KV 无 per-key TTL，因此租约 = KV 值内的 `renewsAt` 心跳 + 单调 `epoch`；claim 时用 KV revision 做 CAS（compare-and-swap），过期 claim 可被任何人用新 revision 抢走。artifact 写入带旧 epoch 即拒——fencing。
- 落点理由：腾讯云是「常驻服务」机（01-topology），NATS 主节点必须常驻；阿里云 2c2g 已承担 DERP/new-api，不再加。jlu-pc 若确认可常驻（open question），可加第二个节点做主节点故障时的兜底（先不做，见 open questions）。

### 4.4 离线与恢复

1. 每机 leaf node 持久化本地未投递消息；机器睡眠/断网期间事件不丢（leaf 特性，见引用）。
2. 重连后客户端从 JetStream 的 ` DeliverSequence` 重放自己最后确认的 seq，重建 KV 快照 → 幂等去重（§3.1 不变量）。
3. 后端整体不可达（腾讯云宕机）：mola 降级为「本机模式」——task/lease 退化为本地文件锁（同 §4.3 语义），`mola goal status` 明示 `backend: degraded`；不做自动 failover（运维负担 > 收益，BWH LA 机不适合当国内主节点）。

---

## 5. 手机 / 远程控制

组件全部复用（06-starred-catalog 第 2 节），mola 只做统一入口：

1. **控制面**：`mola serve --remote` 在本机/常驻机起一个 HTTP API（绑定 tailnet 接口的具体 IP，沿用 dsh web 的 `--host` 单 IP 模式；`tailscale serve` 反代成 `https://<host>.<tailnet>.ts.net`，可选 `--public-url`/`--trusted-host` 语义见 dsh-cli-help.md）。API 端点：`GET /sessions`、`POST /sessions/:id/prompt`、`GET /goals`、`POST /gates/:id/approve`。
2. **ds-harness-remote**（main + jlu-pc）：P2P E2E 看 dsh/Codex/Claude Code 的远程终端——手机端 UI 的「终端」页签直连它，mola 不包一层。
3. **dsh-Go**（小米 15U）：手机本地跑 dsh + 遥控电脑；它经 tailnet 调 mola serve 的 API。
4. **Orca remote runtime**（main + 手机）：Orca 已有手机远程 runtime；mola 把 `orca orchestration` 的 run/task 状态并进 `/goals`。
5. **审批通知**：`gate.request` 事件 → 腾讯云 AstrBot + NapCatQQ 推送到 QQ（常驻、国内可达），用户回复/点击即 `POST /gates/:id/approve`；未批准的 gate 到期自动拒绝（fail closed）。
6. 手机**不是 env**：没有 exec 权限，只有会话/任务/审批三个面的 API，token 见 §6。

---

## 6. 安全模型

### 6.1 peer 认证
1. **基座是 tailnet 身份**：机器间通信全部在 tailnet 内，`tailscale whois <ip>` 把来源 IP 映射到 node/user（tailscale-help.txt），mola serve 用它做准入（白名单设备名，如 `xiaomi-15-ultra`）；未知 peer 直接 403。
2. **应用层 token**：mola serve 要求 `Authorization: Bearer <token>`，token 存 mola-env（age 加密），每设备一枚、可单独吊销。
3. **NATS credentials**：每机一张（nsc 签发，按 host 限定 subject 权限——jlu-pc 的 worker 不能读别人的 KV 前缀）；TLS 由 tailnet 提供，NATS 不再双跳加密。
4. 可选加固：`tailscale lock`（tailnet lock，help 里有）锁 tailnet 成员变更。

### 6.2 审批门（BRIEF #7）
- 所有 `push/merge/publish/delete/payment/message-human` 必须产生 `gate.request`；审批渠道：手机 API、QQ bot、或本机终端确认。默认策略 = dsh 的 `--approval-policy ask`（dsh-cli-help.md 有 ask/never 两档），never 只对无副作用命令生效。
- 远程会话（手机发起的 prompt）继承同一策略：**远程不能放宽审批**，只能审批。

### 6.3 密钥与配置
- 密钥家在 mola-env（chezmoi + age，05-knowledge-and-config）；env adapter 的 `ExecRequest.env` 只接受 `$ref:secret/<name>` 引用，daemon 在执行时才解析，值不进 KV/事件/artifact。
- transcript 与日志进 NATS 前过一遍 secret 过滤（与 rtk 的输出压缩同一条管线），避免会话记录把 token 带进常驻 VM。
- SkillSpector（06：最先装）在安装第三方 mola 插件前扫描——插件的 manifest 声明 capabilities，超出声明的能力调用被 host 拒绝（复用 BRIEF #2 的插件模型）。

---

## 7. 对 BATCHES 的输入（本 area 的切分建议）

| 批次 | 内容 | 验收命令（示意） |
|---|---|---|
| B2（attach） | `mola envs` / `mola sessions` / `mola sessions attach`；jlu-pc daemon 注册 tmux+dsh 会话 | `mola sessions` 在 main 上列出 jlu-pc 会话；attach 后能继续对话（04 Phase 1 的验收） |
| B3（协作底座） | 腾讯云 NATS 部署 + leaf node；`mola-syncd`；goal/task/claim/presence 最小闭环；Orca 桥 | `mola goal create` → 两台机器各 claim 一个 task → `mola goal status` 显示两个 claim；断网 jlu-pc 30s 重连后事件重放无丢失 |
| B4（handoff） | lease + 路径改写 + session-pack 传输；Claude Code 与 Codex 先行 | Windows 的 session handoff 到 jlu-pc，`--resume` 可续、WIP 在（04 Phase 3 验收） |
| B5（LayerFS + 手机） | checkpoint 作为搬运单元；`mola serve --remote` + gate 推送 | handoff 不再拷贝整棵目录树；手机审批一次 push |
| B6（可选） | 第二台常驻节点兜底；Trigger.dev 插件做长任务编排 | 主节点 kill 后 degrade/恢复演练 |

## 8. Open questions（转给 synthesizer，不自行决定）

1. jlu-pc 常驻性未确认 → NATS 主节点放腾讯云是当前最稳的选择，但若腾讯云也出问题没有第二节点（B6）。
2. dsh/Kimi 的 session 存储位置与 resume 机制（04 待核实）→ handoff 对 dsh 只先支持 `--session-id` 续跑。
3. `herdr`/`LayerFS`/`OpenAgentCore` 无 CLI help 输入 → 适配器占位，B5 前需抓 help。
4. 手机端是否需要一个极简 mola app，还是完全依赖 ds-harness-remote + QQ bot 推送（倾向后者，先不建 app）。
