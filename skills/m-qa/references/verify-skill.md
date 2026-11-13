# 项目验证 skill：生成与维护

m-qa 第一次在某个项目里跑，且还没有 `.claude/skills/verify/SKILL.md` 时，按下面的形状写一份。之后每次先读它、用它、再按"维护"一节更新它。不要留 `{{占位符}}`。写完跑：

```
node "<this skill dir>/scripts/check-verify-skill.mjs" <项目>/.claude/skills/verify
```

`<this skill dir>` 是本 skill 的 SKILL.md 被加载时所在的目录（Claude Code 里显示为 skill base directory；在 mstack 仓库里是 `skills/m-qa`）。找不到脚本就按下面的骨架逐节手工核对，并在报告里写明。

退出码 0 才算结构合格。结构合格但仍没实际执行过，仍是草稿。

## 先看仓库，再问人

能从仓库看出来的不要问。只问一个你无法观察的事实：

- **表面**：用户碰的是网页、CLI/TUI、桌面、HTTP API，还是库？有多个就选主要的，其余记一笔。
- **怎么启动**：用仓库自己的命令（package 脚本、Makefile、README）。记下端口、环境变量、种子数据、登录。
- **怎么驱动**：优先用仓库里已有的 harness。没有再选：网页用 Playwright，CLI 用单独的 PTY 或 tmux 会话，HTTP 用 curl。
- **证据**：截图、终端记录、响应体、退出码、写到磁盘或数据库的结果。放在驱动里点名的目录，不要放进会被清理删掉的临时目录。
- **隔离**：两次运行能不能各用各的端口和数据目录？不能的话，在 Launch 里写明"不要同时开第二份"。

仓库当前起不来：先把起不来的原因写进报告的 `blocked`，不要对着坏掉的基线编步骤。

## SKILL.md 骨架

把下面的标题原样留下，正文换成这个仓库的真实命令。`name` 写成 `<repo>-verify`，其中 `<repo>` 是仓库目录名（不要写 `verify`，那会占掉 Claude Code 自带的同名入口；目录仍是 `.claude/skills/verify/`）。标题下一行写 `Required level: L<n>`（0 到 5，含义见 m-verify 的 `references/ladder.md`），这是本项目的"完成"至少要证明到的层级；新写的 skill 都应带这一行；旧 skill 没有也不算错，`check-verify-skill.mjs` 只给警告，并按 L1 处理。行写错（`L7`、`Lx`、`<n>` 没填）则报错。description 一句，点明应用、表面、何时该用，短于 130 个字符，并给 YAML 加引号。不要加 `disable-model-invocation`。

```markdown
---
name: <repo>-verify
description: "Drive <app> (<surface>) from a cold start. Use when checking a user-facing flow."
---

# Verify <app>

Required level: L<n>

按 `features/README.md` 选旅程。不要走测试专用接口冒充用户路径。

## Launch

启动命令、就绪判据（一行日志或一个可回答的 URL，不是"端口开了"）、空数据目录下需要的迁移或种子。短命 CLI 没有常驻进程：这里只构建一次，每次 Drive 用新的隔离会话。

## Doctor

只读检查：进程是不是这次启动的、版本或构建号、端口属主、登录是否有效。任何一步看起来不对，先跑 Doctor，再决定要不要 Drive。还要查"装了但没接上"：工具在磁盘上，却不在 PATH 或环境变量没设。例：Android SDK 在 `%LOCALAPPDATA%\Android\Sdk`，`adb` 不在 PATH 且 `ANDROID_HOME` 为空。Doctor 要分别报出"没装"和"装了没接上"，并写出修复命令（设变量或写出绝对路径），不要因为 `adb: command not found` 就判定环境缺失。

## Drive

这个仓库里真实的选择器或命令。优先用无障碍名字、data 属性、提示符、路由，而不是坐标和 Tab 次数。

## Evidence

每个证明要同时留下动作和动作之后的状态。副作用（文件、行、消息）和屏幕上看到的一起记。名字里带 dry-run 的模式，用文件、网络或 git 引用核对它到底跳过了什么，不要只信名字。

## Cleanup

只停这次启动时记下的 pid，不要按进程名杀。清理实例和临时数据，不删除 Evidence 里点名的证明。
```

## features/

`features/README.md` 是索引：基线前提（数据目录、种子、Doctor 要看到什么）、驱动约定、以及每个 feature 文件的链接。

每个 feature 一个文件。先写用户能碰到的 3 到 5 个，不要一次写完整个产品。文件以一级标题和一段用户可见行为开头，然后正好四个二级标题，顺序固定：

```markdown
# <功能名>

<一段：用户能看见什么>

## Sub-features

- `<id>` 一句话行为。

## How to get to it (user POV)

- 每个用户入口一条，包括键盘或 CLI，不只写最方便的那一个。

## Driving it with <harness 的名字>

- Preconditions: Doctor 通过，以及这条旅程额外需要的状态。
- **<动作>.** 用户做了什么。运行 `<真实命令>`。观察到 `<结果>`。

## Gotchas

- 会让这次验证作废的陷阱。种子数据缺了前提：在这里记失败原因，不要把旅程改弱来换通过。
```

## 交付前跑通

按刚写的说明做一遍：Launch、Doctor、Drive 一条 feature、留下 Evidence、Cleanup。然后确认证据还在点名的路径上。清理把证据删了，这一轮失败，先改 Cleanup 再重跑。中途失败也要清理，避免端口挂着。

用替身环境（容器代替真实机器）跑通时，列出替身做了、目标环境不会做的步骤。那些步骤在真实目标上跑过之前，不算验证过。

## 维护

应用变了或地图和源码对不上时做。编辑范围只有 `.claude/skills/verify/`（SKILL.md、features/、它自己的脚本）。不要改产品代码。

1. 结构检查（上面的命令）先过。
2. 每个 feature 文件对照源码看入口是否还在。可以并行读，但开车只由当前会话做，按 Launch 里的那一个实例。
3. 即使源码看起来没变，也要实际 Drive 至少一条被问到的旅程。
4. 地图错了就改地图或 harness，然后把改过的那条再 Drive 一次。

## 报告结论

`.mstack/qa/` 里的报告，摘要第一行只能是下面三个词之一：

| verdict | 何时用 |
| --- | --- |
| `clean` | Launch、Doctor、要求的 Drive、Evidence、Cleanup 都完成；证据还在；没有失败的功能检查；这次没有改文件。纯视觉上的挑剔可以写在正文里，不把 `clean` 打成别的。 |
| `changed` | 这次改了 `.claude/skills/verify/`，或（仅"测并修"）改了产品代码，并且改过的旅程已经按驱动重跑通过。 |
| `blocked` | 起不来、Doctor 失败、证据被清理删掉、功能检查失败且没有修好、或改完之后重跑仍失败。说清楚卡在哪一步。 |

功能检查还失败时，即使驱动文件也改过，结论仍是 `blocked`，不是 `changed`。
