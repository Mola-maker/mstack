# 06 · GitHub star 筛选目录

> 来源：`gh api user/starred` 全量 247 个（2026-11-03）。判断基于简介，**部署前需逐个核实 README、架构支持（ARM）与资源占用**。约 200 个为教程 / awesome 列表 / ML 框架 / 学校相关，未列入。

## 1. LLM 网关
| 项目 | 位置 | 用途 |
|---|---|---|
| yetone/magpie | main | 本机模型切换（已用） |
| QuantumNous/new-api | 阿里云 / 腾讯云 | 统一网关 |
| Mola-maker/magpie-mail-watch | main | 报错 / 额度告警 |
| langfuse/langfuse | jlu-pc | trace / eval |
| rtk-ai/rtk | 全部开发机 | 省 token |

## 2. 手机遥控（grok bot / muse / dsh-remote-control）
| 项目 | 位置 | 用途 |
|---|---|---|
| Mola-maker/ds-harness-remote | main + jlu-pc | P2P E2E 远程访问 dsh / Codex / Claude Code |
| ccch1mneyyy/dsh-Go | 小米 15U | 手机跑 dsh + 遥控电脑 |
| stablyai/orca | main + 手机 | 用自有订阅跑 Grok Bot / Claude Code；远程 runtime |
| LodyAI/Lody | — | Orca 替代 |
| nano-muse/nanoMuse + Mola-maker/nanodot | muse / Android | 个人 agent |
| baiamansama/android-agent-mcp | Mix 2 | 旧机变自动化设备（adb over tailnet） |
| onehumanbeing/esp32-iphone-agent | 可选 | ESP32 操作 iPhone |

## 3. 网络
queqiao、udp2raw、wg-quic、personal-edge-proxy、Hatoba、mitmproxy —— 见 [02-network](02-network.md)。

## 4. Agent 运行 / 任务（mission）
| 项目 | 位置 | 用途 |
|---|---|---|
| Ephemeral-AI-Lab/layerfs、magpie-layerfs、ephemeral-sandbox | jlu-pc / Huawei | 主线：工作区与沙箱 |
| MiniMax-AI/OpenAgentCore | jlu-pc | 自托管 Agents API，main 派活、worker 执行 |
| KKKKhazix/agent-autoloop | main | 后台接活，拿不准发卡片 —— 最贴合 mission |
| herdrdev/herdr | worker 节点 | coding agent 运行时 |
| tinyhumansai/openhuman | 2c2g 云机 | 轻量多 agent |

## 5. 记忆 / 上下文
| 项目 | 位置 | 用途 |
|---|---|---|
| volcengine/OpenViking | 腾讯云 / jlu-pc | 共享检索层（非事实源） |
| Asymptote-Labs/agent-beacon | 各机 | 跨 harness 记忆 |
| thedotmack/claude-mem | main | 本机 Claude 记忆 |

## 6. Bot 与信息源（腾讯云常驻）
AstrBot + NapCatQQ + 自有插件、AIHOT、JLUhot、agent-gateway、Panniantong/Agent-Reach。

## 7. Agent 工具（各开发机）
| 项目 | 说明 |
|---|---|
| NVIDIA/SkillSpector | **最先装**：安装插件 / skill 前扫描注入与外泄 |
| HKUDS/CLI-Anything | 软件 agent 化 |
| iOfficeAI/OfficeCLI | Office 文件 |
| Agents365-ai/drawio-skill | 架构图 |
| alibaba/page-agent | 页内 GUI agent |

## 排除
| 项目 | 原因 |
|---|---|
| free-claude-code、free-one-api、sub2api（拼车） | 违反服务条款，危及正规订阅 |
| claude-switcher | 环境指纹伪装多账号，同上 |
| gmail-account-creator、L1B3RT4S、学习通 / 抢课脚本 | 不碰 |
| DeepInfer、pd-bridge | 硬件不匹配 |
| alma-relay | 未使用 Alma |
