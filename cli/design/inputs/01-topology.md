# 01 · 设备拓扑

![手绘拓扑](assets/topology-sketch.jpg)

## 设备与角色

| 设备 | 系统 | Tailscale 名（推测/待确认） | 角色 |
|---|---|---|---|
| 机械师 (main) | Windows 11 | `wandanghe` | 主力开发机；magpie 模型路由；Orca 桌面端 |
| 华硕 ROG | Windows | `kamin`？ | 第二开发机 / worker |
| Huawei 笔记本 | Ubuntu | `whymola`？ | Linux worker（herdr / LayerFS） |
| Xiaomi Pad | Android (ARM) | `xiaomi-pad-7-pro` | 移动终端（只做客户端） |
| jlu-pc | Ubuntu + RTX 4090 | `jlu-pc` | **常驻 session 主机**；langfuse；LayerFS 沙箱；本地小模型 |
| iPhone 18 Pro Max | iOS | `iphone197` | 遥控终端 |
| Xiaomi 15 Ultra | Android | `xiaomi-15-ultra` | 遥控终端；dsh-Go |
| Mix 2 | Android | — | 旧机改造为 agent 可操作的自动化设备 |
| muse | — | `muse` | nanoMuse 个人 agent 节点 |

## 云服务器

| 服务器 | 规格 | 角色 |
|---|---|---|
| 阿里云 | 2c2g | 国内入口：new-api 网关、自建 DERP、个人站点 |
| 腾讯云 | 4c4g | 常驻服务：AstrBot + NapCat、AIHOT / JLUhot、OpenViking |
| BandwagonHost | 2c2g，LA IP | 出海节点：3X-UI、queqiao 服务端、Tailscale exit node |

## LLM 订阅

Claude / Kimi / X (Grok) / DeepSeek / Antigravity —— 统一经 [03-llm-gateway](03-llm-gateway.md) 路由。

## 草图中的未决节点

- **Listening port**：推测指端口 / 存活监控，尚无对应项目（候选：Uptime Kuma）。
- **mission**：后台任务派发与跟进，见 [06-starred-catalog](06-starred-catalog.md) 第 4 节。

## 在线性观察（2026-11-03）

除 main、jlu-pc、muse 外，多数节点长期离线（ROG 16h、Huawei 17d、小米 15U 24d、Pad 97d）。
**结论：不能依赖"原机器在线"来续接 session**，需要一个常驻主机 → 见 [ADR-0002](adr/0002-attach-first-session-resume.md)。
