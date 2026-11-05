# 05 · 经验、核心设计、环境配置

> 原则：**谁跟着变，就和谁放在一起。** Git 是唯一事实源。见 [ADR-0001](adr/0001-git-as-source-of-truth.md)。

## 三类内容，三个家

| 内容 | 家 | 理由 |
|---|---|---|
| 可复用经验（跨项目的坑与解法） | `claude-knowledge` 仓库（已有） | 与具体项目无关 |
| 项目核心设计 | 各项目仓库 `docs/` + `AGENTS.md` | 随代码一起演化，clone 即得 |
| 项目环境配置 | 各项目仓库（声明式） | 与代码版本绑定 |
| 机器级配置（dotfiles、harness 配置） | `mola-env`（chezmoi） | 跨机器、需按 OS 模板化 |
| 密钥 | chezmoi + age 加密 / 密码管理器 / 各机登录 | 不进任何明文存储 |
| 大文件（PDF、CAD、数据集、录屏） | Google Drive | 不需要 diff |
| session 原始记录 | 对象存储 / LayerFS 归档 | 量大噪音多，只提炼进经验库 |

## 1. 可复用经验 → `claude-knowledge`

- 现状：`~/.claude/knowledge` → `github.com/Mola-maker/claude-knowledge`，8 条。
- 条目模板：

```markdown
---
title: <一句话>
verified: <OS / 工具版本 / 日期>
scope: <适用范围>
---
**现象** …
**根因** …
**解法** …
```

- 写入时机：调试成功后、失败复盘后；写前查重。
- 读取：现阶段 grep；规模到几百条后接 OpenViking 索引。

## 2. 核心设计 → 项目仓库内

```
<repo>/
  AGENTS.md          # agent 入口：设计文档位置、bootstrap、测试命令
  docs/design/       # 整体架构
  docs/adr/NNNN-*.md # 一个决策一个文件，只追加：背景 / 决定 / 备选 / 后果
```

现状盘点（2026-11-04）：

| 项目 | AGENTS.md | 设计文档 | 环境声明 |
|---|---|---|---|
| AIHOT | ✅ (+CLAUDE.md) | — | `.env.example` + Docker ✅ — **模板参考** |
| LayerFS | ✅ 各模块 | 仅 `sandbox-cache-design.md` | 部分 |
| layerfs-connect | ✅ 但有多份拷贝（`layerfs/`、`v2-port/`、`worktrees/p12~p15`） | 同上 | 易漂移 |
| molamaker-site | CLAUDE.md | — | — |
| molasearch | — | — | `.env.example` |
| CAD2GIS | 浅层未见 | 浅层未见 | — |

## 3. 项目环境配置 → 声明式

| 关注点 | 文件 |
|---|---|
| 工具链版本 | `mise.toml`（Node / Python / Rust 统一，Win + Linux 通用）；或 `rust-toolchain.toml`、`.nvmrc` |
| Python 依赖 | `pyproject.toml` + `uv.lock` |
| 服务依赖 | `docker-compose.yml` / `.devcontainer` |
| 环境变量 | `.env.example`（只写变量名） |
| 一键初始化 | `bootstrap` 脚本或 `make dev` |

## 4. 机器级配置 → `mola-env`（待建）

```
mola-env/            (私有, chezmoi)
  claude/   CLAUDE.md、settings 模板、hooks、自写 skills、插件清单(名称+版本)
  codex/    config.toml、AGENTS.md
  dsh/ kimi/ magpie/
  paths.toml          # 各机器路径映射（供 session handoff 使用）
  secrets             # age 加密 / 从密码管理器读取
```

现状信号：`~/.claude` 非 git 仓库，68 个 skill；存在 6 份 `CLAUDE.md` 备份与 5 份 `settings.json` 备份 —— 在手动做版本管理。

## 5. 新机器还原流程

```
chezmoi init --apply <mola-env>   → 机器配置 + 密钥
git clone claude-knowledge         → 经验库
git clone <项目>                    → 设计文档 + AGENTS.md
mise install && ./bootstrap        → 项目环境
(按需) session handoff / attach     → 接上之前的工作
```

## 6. OpenViking 与 Google Drive 的定位

- **OpenViking**：最上层检索层，同时索引 `claude-knowledge` 与各仓库 `docs/`、`AGENTS.md`。内容可随时从源头重建；不做唯一存储（需常驻服务 + embedding API，挂了全网失忆；配置无法从数据库"部署"到文件）。
- **Google Drive**：只放大文件。不放配置 / skills（Linux 无官方客户端、冲突生成静默副本、无 diff、无法按 OS 模板化、整目录同步会带走凭证）。
