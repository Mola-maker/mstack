# 03 · LLM 网关与可观测性

## 目标

所有设备、bot、agent 只认**一个** endpoint；订阅与 key 集中管理；用量与失败可见。

## 架构

```
各 harness (Claude Code / Codex / dsh / Kimi Code / bot)
        │
        ├─ 本机：magpie（菜单栏模型切换，main）
        └─ 远程：new-api（阿里云，OpenAI/Claude/Gemini 兼容）
                       │
                       ├─ 官方订阅 / API key
                       └─ 本地模型（jlu-pc 4090，小模型）
        │
   langfuse（jlu-pc）← trace / eval
   magpie-mail-watch（main）← provider 报错 / 额度窗口告警
   rtk（各开发机）← 命令输出压缩，省 token
```

## 选型

| 项目 | 位置 | 决定 |
|---|---|---|
| [yetone/magpie](https://github.com/yetone/magpie) | main | 已在用，保留 |
| [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | 阿里云 | 采用，见 [ADR-0003](adr/0003-new-api-as-gateway.md) |
| OmniRoute | — | 与 new-api 重叠，不采用 |
| [langfuse](https://github.com/langfuse/langfuse) | jlu-pc | 依赖 Postgres + ClickHouse，不放 2c2g |
| [magpie-mail-watch](https://github.com/Mola-maker/magpie-mail-watch) | main | 自有项目 |
| [rtk](https://github.com/rtk-ai/rtk) | 全部开发机 | 单二进制 |
| DeepInfer / pd-bridge | — | 单张 4090 跑不动 DeepSeek 全量，暂不部署 |

## 红线

不使用共享 / 拼车订阅或逆向接口（sub2api 拼车、free-claude-code、free-one-api 等）：违反服务条款，可能导致正规订阅被封。
