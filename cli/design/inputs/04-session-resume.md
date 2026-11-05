# 04 · 跨机续接 session

> 目标：任意时间、任意机器，立刻接上别的机器的 session（Claude Code / Codex / dsh …）和工作现场（代码、未提交改动、依赖、环境）。

## 现状约束（2026-11-03 实测于 main）

1. **Claude Code session 按绝对路径归档**：`E:\layerfs` → `~/.claude/projects/E--layerfs/*.jsonl`；Linux 上会是 `-home-<user>-layerfs`。直接同步文件，换机后 `claude --resume` 找不到。
2. **体积大**：`~/.codex/sessions` 2.6 GB，`~/.claude/projects` 710 MB，不能全量同步。
3. **节点常离线**：见 [01-topology](01-topology.md)，"连回原机器"在原机睡眠时失效。
4. **凭证不可同步**：`~/.codex/auth.json` 等必须每台机器各自登录。

## 方案：两层

### 第一层 · attach（覆盖约 80% 场景）

```
任意设备 ──tailscale ssh──> jlu-pc ──> tmux/herdr 会话 ──> claude / codex / dsh
手机 ──ds-harness-remote / Orca remote runtime──┘
```

- 长任务固定在常驻主机（jlu-pc，后续可加一台云机）上，每个任务一个 tmux 会话（或 herdr 管理）。
- 其它设备只是终端，零同步、零冲突。
- 工具：`sessions` 命令汇总所有在线机器的会话，选一个即 attach。

### 第二层 · handoff（需要把现场搬到本机时）

触发场景：断网 / 高延迟 / 要用本机 GPU / 常驻主机不可用。

```
源机器                                   目标机器
1. 冻结工作区                           4. 恢复工作区（checkout / mount）
   LayerFS checkpoint（或 git WIP 提交）
2. 打包 session 记录 (.jsonl)  ──传输──> 5. 按本地路径改写 cwd，放入对应 projects 目录
3. 释放锁（lease）                       6. 获取锁 → claude/codex --resume <id>
```

- **路径改写**：transcript 中的 `cwd` 字段按目标机器映射；映射表放在 `mola-env`。
- **单写者**：每个 session 一把 lease，同一时刻只有一台机器追加写，避免 jsonl 分叉。
- **不搬**：凭证、缓存、`node_modules` / `target`（由 bootstrap 重建）。

### 与 LayerFS 的关系

"工作区 checkpoint + session 记录"作为同一个可搬运单元，在另一台机器上开分支继续 —— 正是 LayerFS「ephemeral workspace, durable shared history」的场景，可作为 LayerFS / magpie-layerfs 的演示用例。

## 各 harness 存储位置（待逐一核实）

| Harness | Session 位置 | 按路径归档？ |
|---|---|---|
| Claude Code | `~/.claude/projects/<编码路径>/*.jsonl` | 是 |
| Codex | `~/.codex/sessions/`（按日期） | 否，记录中含 cwd |
| dsh / Kimi Code | 待调研 | — |

## 相关项目

herdr、Orca、Lody、ds-harness-remote、dsh-Go、OpenAgentCore、LayerFS、ephemeral-sandbox。
