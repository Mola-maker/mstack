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

### 2.1 OMC 5.8.6 新增的 skill（2026-11-13 对照）

OMC 从 5.7 到 5.8.6 增加到 84 个 skill，其中不少和 mstack 的职责重叠，而上面那份重叠清单是按旧版写的。下表是按两边 `description` 逐个对照的结果：只读了描述和 SKILL.md 的章节，没有在会话里实测哪一句话会同时拉起两边。

| mstack | OMC 5.8.6 里做同一件事的 skill（重叠，建议只用 mstack 的） |
|---|---|
| `m-start` | map、session-flow |
| `m-think` | sharpen、in-your-own-words、loft、ask-navigator、intent |
| `m-plan` | architect、sdd、launch |
| `m-goal` | execute、hillclimb、autoresearch |
| `m-dispatch` / `m-team` | arena、graph |
| `m-debug` | figure-it-out |
| `m-research` | external-context |
| `m-verify` | benchmark-checklist、show-me-your-work、tdd |
| `m-review` | interrogate、blast-radius |
| `m-ship` | pr、babysit、fix-ci、get-pr-comments、fix-merge-conflicts、stacked-delivery、release |
| `m-qa` | create-verification-skill、maintain-verification-skill、visual-verdict |
| `m-handoff` | recall、ketchup、what-did-i-get-done |
| `m-learn` | correct、reflect、refit、personal-mode、wiki |
| `m-deslop` | minimal-code-discipline、minimal-prose-discipline、agent-doc-discipline |

**只是部分重叠的：** sdd 和 launch 是整条流水线（横跨 `m-think`、`m-plan`、`m-goal`、`m-team`）；graph 是带崩溃恢复的确定性 DAG 运行时；wiki 是跨会话知识库；personal-mode 从对话记录生成用户画像；visual-verdict 只做截图和参考图对比；tdd 是实现时的纪律；show-me-your-work 是决策记录；session-flow 更接近 `m-handoff`；intent 面向非工程师的需求收集；release 管发版和打 tag，`m-ship` 只到 PR。这些在 mstack 覆盖不到的那一部分仍可以用 OMC 的。

**会写到同一个位置的一对：** OMC 的 `create-verification-skill` 和 mstack 的 `m-qa` 都生成"项目自己的 verify skill"。两边都写 `.claude/skills/verify/SKILL.md`，也都会先读已有的文件，所以同时用的结果多半是两套结构混在一份驱动里。同一个项目里只让一边生成和维护。用 mstack 时由 `m-qa` 负责（`.claude/skills/verify/`）。

**mstack 没有、可以继续用 OMC 的：** models（给 OMC 自己的 agent 按角色配 provider、档位和推理强度；mstack 的角色路由只管 mstack 自己派出去的活，见 `config/model-routing.json`）、how / why / teach（讲解代码）、diagram、statechart、create-formal-verification-skill（TLA+ / Lean / Kani）、architecture-survey、typescript-best-practices、technical-writing、harbor、bro、hud、configure-notifications。

**全局 CLAUDE.md 里的"已被取代"清单需要补上面表里右列的名字**，否则模型只知道旧的那 17 个被取代。这份文件由 magpie 管理，按本节末尾的命令同步。

**从 OMC 新版吸收的做法（已落到 mstack）：**

- 纠错按强制力从高到低落地：lint / 编译错误 → 类型 → 运行时检查 → 脚本或钩子 → 文字（来自 `correct`）。已写进 `m-learn` 的分类步骤。
- 环境先于提示词：把上下文、规则、工具、标准当成仓库里的共享环境来建（来自 `drydock` 的四根支柱）。mstack 对应的是 doctor 检查、验收回执和状态栏，方向一致，没有照搬它的目录结构。
- 按角色配模型，并检查评审小组的模型来源是否足够不同（来自 `models`）。对应 mstack 的分层派工设计。

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
