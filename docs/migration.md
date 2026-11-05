# 迁移建议：装了 mstack 之后

mstack 把四套来源的 skill 去重合并成了 15 个。为避免同一触发词命中多个插件、规则互相打架（历史上 omc 与 superpowers 就冲突过），建议按下面调整。

**这份文件只有建议。mstack 不会、也不应该自动修改你的任何配置；所有停用动作由你自己执行。**

## 1. superpowers —— 建议整体停用

superpowers 的全部 skill 都已被吸收（对应关系见 [source-map.md](source-map.md)）：

- brainstorming / writing-plans / executing-plans → m-think / m-plan
- test-driven-development / verification-before-completion → m-verify
- systematic-debugging → m-debug
- requesting / receiving-code-review → m-review
- dispatching-parallel-agents / subagent-driven-development / using-git-worktrees → m-dispatch
- finishing-a-development-branch → m-ship
- using-superpowers → mstack（总入口）
- writing-skills → m-learn
- diagnosing-superpowers → m-guard

建议：在 Claude Code 里用 `/plugin` 禁用 superpowers 插件。确认 mstack 用顺手、没有想念的东西之后，再考虑卸载。

## 2. oh-my-claudecode（OMC）—— 停用重叠 skill，保留 MCP 工具

OMC 里和 mstack 重叠的 skill 建议停用：autopilot、deep-interview、plan、ralplan、ultragoal、ralph、team、verify、debug、trace、review、remember、research、self-improve、skillify、ai-slop-cleaner、minimal-code-discipline、minimal-prose-discipline（全部 18 个 skill 均有对应，见 source-map）。

**但 OMC 的 MCP 工具保留启用**：`state` / `notepad` 等 MCP server 被 m-goal、m-handoff 等 skill 当作可选后端引用（没有时自动退回文件方案），与 skill 停用互不影响。

建议做法：禁用 OMC 插件中的 skill 部分（按你的客户端支持的方式：逐条禁用 skill，或整体禁用插件后单独把 MCP server 配置留下）。如果客户端不支持只留 MCP，可以接受短期内 skill 共存——触发词冲突时 mstack 的 `m-` 前缀足够区分。

## 3. gstack / pstack —— 当前未安装，无需处理

这两个栈没有装在你的环境里，不需要任何操作。它们的来源文件只作为改写素材存在于本仓库 `.sources/`。如果以后装回来，参照 superpowers 的方式整体停用即可——功能已被 m-qa、m-ship、m-learn、m-deslop 等覆盖。

## 4. DSH 自带的几个 skill

`deep-research`、`parallel-dispatch`、`ship-pr` 等 DSH 侧 skill 已并入 m-research / m-dispatch / m-ship。它们不是插件，不需要停用；mstack 软链进 `~/.dsh/skills` 后，同名触发词优先用 m- 版本即可。

## 验证迁移生效

1. 新开会话说"继续"，应命中 mstack 总入口而不是旧插件。
2. 说"review一下"，应命中 m-review。
3. 如果发现同一句话同时拉起两个插件的 skill，回到上面找到对应来源插件再停一层。
