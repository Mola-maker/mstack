# 迁移建议：装了 mstack 之后

mstack 把四套来源的 skill 去重合并成了 16 个，另有 1 个自己写的 `m-cua`（操作真实界面做验收）。为避免同一触发词命中多个插件、规则互相打架（历史上 omc 与 superpowers 就冲突过），建议按下面调整。

**这份文件只有建议，mstack 本身不会改你的任何配置。** 作者机器上已按 §1（停用 superpowers）和 §2 的推荐做法执行（2026-11-04）。

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

## 2. oh-my-claudecode（OMC）—— 保留插件，关掉会抢路由的部分

OMC 里和 mstack 重叠的 skill：autopilot、deep-interview、plan、ralplan、ultragoal、ralph、team、verify、debug、trace、review、remember、research、self-improve、skillify、ai-slop-cleaner、minimal-code-discipline、minimal-prose-discipline、tdd（对应关系见 source-map）。

**不能逐个隐藏。** 用户级 `~/.claude/settings.json` 的 `skillOverrides` 对**插件** skill 不生效（Claude Code 只从 policy / flag 设置读插件 skill 的覆盖），实测设了也照样出现在列表里。所以可选的只有两条路：

- **（推荐）保留 OMC**：它的 19 个 agents（executor、verifier、critic……）、MCP 工具（state / notepad）和 hooks 仍有用。只关掉会抢路由的两个 hook，并在全局 CLAUDE.md 写明工作流先走 mstack：
  ```json
  "env": { "OMC_SKIP_HOOKS": "keyword-detector,persistent-mode" }
  ```
  `keyword-detector` 会在你说 "ralph/autopilot/ulw" 时强行拉起 OMC skill；`persistent-mode` 是 "The boulder never stops" 的续跑循环，和 `m-goal` 的停止条件冲突。
- **整体停用 OMC**：`claude plugin disable oh-my-claudecode@omc`。最干净，但 agents、MCP 工具和 hooks 一起没了；mstack 的 skill 会退回 Claude Code 自带的 general-purpose agent 和文件状态。

如果全局 CLAUDE.md 由 magpie 管理（文件里有 `<!-- magpie:begin -->`），改完后要同步回 magpie 的 library，否则下次同步会覆盖：
`magpie library instructions set <只含 begin/end 之间内容的文件>`。

## 3. gstack / pstack —— 当前未安装，无需处理

这两个栈没有装在你的环境里，不需要任何操作。它们的来源文件只作为改写素材存在于本仓库 `.sources/`。如果以后装回来，参照 superpowers 的方式整体停用即可——功能已被 m-qa、m-ship、m-learn、m-deslop 等覆盖。

## 4. DSH 自带的几个 skill

`deep-research`、`parallel-dispatch`、`ship-pr` 等 DSH 侧 skill 已并入 m-research / m-dispatch / m-ship。它们不是插件，不需要停用；mstack 软链进 `~/.dsh/skills` 后，同名触发词优先用 m- 版本即可。

## 验证迁移生效

1. 新开会话说"继续"，应命中 mstack 总入口而不是旧插件。
2. 说"review一下"，应命中 m-review。
3. 如果发现同一句话同时拉起两个插件的 skill，回到上面找到对应来源插件再停一层。
