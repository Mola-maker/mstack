# 07 · 落地路线

> 原则：每一步都有可验证的完成标准。顺序按依赖排列。

## Phase 0 · 地基
| 步骤 | 验证 |
|---|---|
| 安装 SkillSpector，扫描现有 68 个 skill 与插件 | 出具扫描报告，高危项已处理 |
| 建 `mola-env`（chezmoi），盘点 `~/.claude`、`~/.codex` → 进 Git / 加密 / 不同步 三类 | 清单经确认；新 Linux 机 `chezmoi apply` 后 Claude Code 可正常启动 |

## Phase 1 · attach 续接
| 步骤 | 验证 |
|---|---|
| jlu-pc：tmux（或 herdr）+ Tailscale SSH | 用小米 15U 连上 jlu-pc 上运行中的 Claude Code 并继续对话 |
| `sessions` 汇总命令 | main 上列出 jlu-pc 会话，选中即 attach |

## Phase 2 · 网关与网络
| 步骤 | 验证 |
|---|---|
| 阿里云部署 new-api | 两台机器上的不同 harness 通过同一 endpoint 调用成功，用量可见 |
| LA ↔ 国内 queqiao | 跨境链路延迟 / 丢包对比数据 |
| 自建 DERP | `tailscale netcheck` 显示走自建中继 |

## Phase 3 · handoff 搬运
| 步骤 | 验证 |
|---|---|
| Claude Code handoff（路径改写 + lease） | Windows 上的 session 搬到 jlu-pc，`--resume` 可续，未提交代码在 |
| Codex handoff | 同上 |
| 底层换成 LayerFS checkpoint / branch | 搬运不再拷贝整棵目录树 |

## Phase 4 · 项目模板与知识检索
| 步骤 | 验证 |
|---|---|
| 项目模板（AGENTS.md / docs/adr / mise.toml / .env.example / bootstrap） | CAD2GIS 或 LayerFS 新机器 clone 后一条命令可跑测试 |
| OpenViking 索引 claude-knowledge + 各仓库 docs | 跨项目查询能命中正确条目；删库后可重建 |
