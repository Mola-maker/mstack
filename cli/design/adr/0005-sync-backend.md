# ADR-0005 · 默认同步/事件后端：自托管 NATS + JetStream

- 状态：Proposed（待 synthesizer 并入 DESIGN.md）
- 日期：2026-11-05
- 决策者：envs-collab area 设计（详见 `cli/design/sections/envs-collab.md` §4）
- 关联：ADR-000x（TS↔Rust 边界）、ADR-0002（attach-first session resume，mola-infra 草案）

## 背景

`mola` 要支持跨机器 agent 协作（BRIEF #6）：Windows 主力机 + WSL、jlu-pc 4090、ROG、Huawei 笔记本、阿里云/腾讯云/BWH 三台云机、手机，全部在 Tailscale mesh 上（inputs/01、02）。需要一个可插拔的 sync/event 后端承载：goal/task 状态、claim/lease、artifact、presence、日志、审批门。硬性外部约束：

- 中国大陆网络（云机在国内，LA 机只做出海出口）；不能依赖国内访问不稳的海外 SaaS。
- 成本 ≈ 0：必须能塞进现有 2c2g/4c4g 云机。
- 客户端必须同时有 TS 与 Rust（BRIEF #1）：TS host、Rust 守护进程（mola-syncd）。
- 离线容忍：节点长期睡眠/离线（01-topology 实测 ROG 16h、Huawei 17d），事件不能因断线丢失。
- 自托管为默认（密钥不出机器，BRIEF #7）。

## 决定

1. **默认后端 = 自托管 NATS（JetStream 文件存储）**，主节点跑在腾讯云 4c4g（三台云机中唯一「常驻服务」机），每台开发机跑一个 leaf node。
   - leaf node 在断链时本地 pub/sub、KV、JetStream 照常工作，重连后 store-and-forward——直接满足「离线容忍」，不需自建队列协议（[Synadia: NATS DDIL](https://www.synadia.com/blog/nats-ddil-leaf-nodes.md)、[adaptive edge deployment](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/adaptive_edge_deployment.md)）。
   - 客户端双语言一等：Rust `async-nats`（[nats-io/nats.rs](https://github.com/nats-io/nats.rs)）、TS 官方 v3 monorepo `@nats-io/nats-core/jetstream/kv/obj`（[nats-io/nats.js](https://github.com/nats-io/nats.js/)）。
   - 一个二进制同时提供事件流（JetStream）、状态存储（KV）、对象存储（Object Store）、请求/应答——协作模型需要的四样原语都是原生的，无需额外组件。
   - 运维负担最低：无数据库依赖、文件存储、单进程；资源占用对 4c4g 可忽略。
2. **共享状态文档层 = Yjs（TS）/ yrs（Rust）CRDT**，承载需要多端并发编辑的结构（共享任务看板、handoff 路径映射表、知识片段），传输复用 NATS（自定义 provider）。yrs 活跃维护但存在一个未决 soundness advisory（[rustsec #3118](https://github.com/rustsec/advisory-db/issues/3118)），只用于非信任边界内的状态合并，不做安全载体。
3. **传输层 = Tailscale**：NATS 流量全部走 tailnet（含阿里云自建 DERP 兜底），不额外加一层 TLS/加密（WireGuard 已 E2E）。纯 Tailscale P2P 不作为事件后端——无持久化、无离线缓冲、无 KV。
4. **其它后端走同一个 `SyncBackend` 插件接口**（envs-collab §4.1：publish/subscribe/kv/objects/presence/health）。Redis Streams 是第一个备选实现（已有 Redis 的部署可复用）；Supabase Realtime、Cloudflare Durable Objects、Liveblocks、Temporal/Inngest/Trigger.dev 不实现，接口留位。
5. **降级语义**：主节点不可达时 mola 进入「本机模式」，task/lease 退化为本地文件锁，状态面明示 `backend: degraded`；不做自动 failover。
6. **lease 语义**：NATS KV 无 per-key TTL，租约 = KV 值内心跳（`renewsAt`）+ 单调 `epoch` fencing token，claim 用 KV revision CAS；artifact 写入携带旧 epoch 一律拒绝。

## 备选与落选理由

| 备选 | 落选原因 |
|---|---|
| Redis Streams | 可行（自托管、TS/Rust 客户端都有），但无离线缓冲语义、持久化与内存运维要自己管；作为备选插件保留 |
| Supabase Realtime | 云在国内不稳；自托管整套 stack 太重（2c2g 放不下）；无一等 Rust 客户端，违反语言约束 |
| Cloudflare Durable Objects / Agents SDK | 不可自托管；中国网络是 Enterprise + JD Cloud + ICP 的独立订阅，且 Durable Objects 不在其可用产品清单（[overview](https://developers.cloudflare.com/china-network/)、[available products](https://developers.cloudflare.com/china-network/reference/available-products/)）；无原生 Rust 客户端 |
| Liveblocks | 自托管是 Enterprise 付费附加项（[data storage](https://liveblocks.io/docs/platform/data-storage)）；SaaS 国内不稳；仅 TS |
| Temporal / Inngest / Trigger.dev | 定位是 durable execution 不是实时总线；Temporal 自托管重；Trigger.dev v4 自托管已简化为 docker compose 但含 ClickHouse/Postgres/Redis（[docs](https://trigger.dev/docs/self-hosting/docker)）。留作将来长任务编排的可选插件，不进 B 系 |
| 纯 Tailscale P2P | 零运维、已有自建 DERP，但节点离线即断、无重放/KV/对象存储；保留为 NATS 的承载网络 |

## 后果

**正面**
- 离线容忍、TS/Rust 双客户端、单一常驻服务三项约束同时满足；新增一台机器 = 装一个 leaf node + 一张 credential。
- 协作模型（goal/task/lease/artifact/presence）不需要为后端特性打折；换后端只影响 `mola-syncd`。

**负面 / 风险**
- 引入一个必须常驻的组件：腾讯云宕机 → 全网降级为本机文件锁模式（决定 5 接受此风险；B6 评估第二节点）。
- NATS KV 无原生 TTL，lease 靠心跳 + fencing，客户端实现错误会放大（需要 m-verify 级别的测试覆盖抢占与过期场景）。
- JetStream 文件存储占用云机磁盘；artifact 要设按 goal 的清理策略（`mola goal archive`）。
- yrs 的 soundness advisory 未决；若升级为安全敏感用途必须先复核。
- 单源声明：Trigger.dev 自托管体验依据官方文档（第一方）；yrs advisory 仅一个 issue 源。

## 验证方式（并入对应 batch 的验收）

- B3：`mola goal create` 后两台机器各 claim 一个 task，`mola goal status` 显示两个 claim；
  拔断 jlu-pc 网络 30 s 再恢复，期间在 jlu-pc 产生的本地事件重放后无丢失、无重复；
  kill 腾讯云 NATS 进程，main 上 `mola goal status` 显示 `backend: degraded` 且本地 claim 仍可用。
