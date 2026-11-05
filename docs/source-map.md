# Source map — .sources/ 每个文件的去向

每个来源文件归入哪个 m-skill，依据 FRAMEWORK.md §2。`.sources/` 下全部 91 个文件均被采纳；FRAMEWORK.md §2 明确不收的来源（gstack 的 iOS 系列、design-shotgun、setup-gbrain、ubicloud、supabase；pstack 的 ketchup、bro、arena、statechart、typescript-best-practices、formal-verification 系列）本就不在 `.sources/` 中，故无 "not adopted" 行。

| 来源文件 | 归入 | 备注 |
|---|---|---|
| dsh/deep-research | m-research | 多渠道并行 + 交叉验证的主流程 |
| dsh/parallel-dispatch | m-dispatch | DSH 侧分派工具与隔离约定 |
| dsh/plugin-intake | m-guard | 第三方插件安装前体检 |
| dsh/ship-pr | m-ship | 分支到 PR 的主流程 |
| dsh/token-thrift | m-handoff | 上下文节省与摘要落盘 |
| gstack/autoplan | m-plan | 自动拆计划 |
| gstack/careful | m-guard | 破坏性操作前警告 |
| gstack/context-restore | m-handoff | 恢复存档 |
| gstack/context-save | m-handoff | 保存存档 |
| gstack/cso | m-review | 安全视角审查 |
| gstack/design-review | m-qa | 设计走查 |
| gstack/document-release | m-ship | 发布文档 |
| gstack/freeze | m-guard | 目录冻结 |
| gstack/guard | m-guard | 护栏规则 |
| gstack/health | m-qa | 站点健康检查 |
| gstack/investigate | m-debug | 调查式排查 |
| gstack/land-and-deploy | m-ship | 合入与部署 |
| gstack/learn | m-learn | 经验沉淀 |
| gstack/office-hours | m-think | 需求讨论 |
| gstack/plan-ceo-review | m-think | 方向性复核 |
| gstack/plan-eng-review | m-plan | 工程视角复核计划 |
| gstack/qa | m-qa | 真机验收主流程 |
| gstack/qa-only | m-qa | 只报不修模式 |
| gstack/retro | m-learn | 复盘 |
| gstack/review | m-review | 代码审查主流程 |
| gstack/ship | m-ship | 交付流程 |
| gstack/spec | m-plan | 规格化拆解 |
| gstack/verify | m-verify | 证据验证 |
| omc/ai-slop-cleaner | m-deslop | 清 AI 味 |
| omc/autopilot | mstack + m-goal | 自主推进模式，拆进总入口与长跑循环 |
| omc/debug | m-debug | 调试流程 |
| omc/deep-interview | m-think | 深入提问 |
| omc/minimal-code-discipline | m-deslop | 最小代码纪律 |
| omc/minimal-prose-discipline | m-deslop | 最小文字纪律 |
| omc/plan | m-plan | 计划流程 |
| omc/ralph | m-goal | 长跑循环 |
| omc/ralplan | m-plan | 循环式计划 |
| omc/remember | m-handoff | 记忆存档 |
| omc/research | m-research | 调研纪律（先本地、注明来源） |
| omc/review | m-review | 审查流程 |
| omc/self-improve | m-learn | 自我改进 |
| omc/skillify | m-learn | 流程沉淀为 skill |
| omc/team | m-dispatch | 多 agent 协作 |
| omc/trace | m-debug | 调用链追踪 |
| omc/ultragoal | m-goal | 长跑目标主流程 |
| omc/verify | m-verify | 完成前验证 |
| pstack/architect | m-plan | 架构拆解 |
| pstack/babysit | m-ship | 盯 PR |
| pstack/blast-radius | m-review | 影响面评估 |
| pstack/correct | m-learn | 纠正记录 |
| pstack/deslop | m-deslop | 去冗余 |
| pstack/figure-it-out | m-debug | 自主排查 |
| pstack/fix-ci | m-ship | 修 CI |
| pstack/get-pr-comments | m-ship | 拉取并处理 PR 评论 |
| pstack/interrogate | m-think | 追问澄清 |
| pstack/make-pr-easy-to-review | m-ship | 让 PR 好审 |
| pstack/poteto-mode | mstack | 总入口工作模式 |
| pstack/principle-attack-the-premise | mstack | 核心原则 1 |
| pstack/principle-encode-lessons-in-structure | m-learn | 核心原则 10 |
| pstack/principle-fix-root-causes | m-debug | 核心原则 5 |
| pstack/principle-guard-the-context-window | m-handoff | 核心原则 7 |
| pstack/principle-never-block-on-the-human | m-goal | 核心原则 8 |
| pstack/principle-outcome-oriented-execution | m-goal | 结果导向执行 |
| pstack/principle-prove-it-works | m-verify | 核心原则 4 |
| pstack/principle-sequence-verifiable-units | mstack | 核心原则 3 |
| pstack/principle-subtract-before-you-add | m-deslop | 核心原则 2 |
| pstack/recall | m-handoff | 回忆上下文 |
| pstack/reflect | m-learn | 反思 |
| pstack/sharpen | m-think | 打磨想法 |
| pstack/show-me-your-work | m-verify | 出示证据 |
| pstack/swarm | m-dispatch | 群体并行 |
| pstack/tdd | m-verify | TDD 用法 |
| pstack/thermo-nuclear-review | m-review | 高强度审查 |
| pstack/unslop | m-deslop | 去冗余 |
| pstack/what-did-i-get-done | m-handoff | 进度回顾 |
| pstack/why | m-debug | 追问根因 |
| superpowers/brainstorming | m-think | 头脑风暴主流程 |
| superpowers/diagnosing-superpowers | m-guard | 插件冲突诊断 |
| superpowers/dispatching-parallel-agents | m-dispatch | 并行分派 |
| superpowers/executing-plans | m-plan | 执行计划 |
| superpowers/finishing-a-development-branch | m-ship | 收尾分支 |
| superpowers/receiving-code-review | m-review | 接收审查意见 |
| superpowers/requesting-code-review | m-review | 请求审查 |
| superpowers/subagent-driven-development | m-dispatch | 子 agent 驱动开发 |
| superpowers/systematic-debugging | m-debug | 系统化调试主流程 |
| superpowers/test-driven-development | m-verify | TDD |
| superpowers/using-git-worktrees | m-dispatch | worktree 隔离 |
| superpowers/using-superpowers | mstack | 总入口元规则 |
| superpowers/verification-before-completion | m-verify | 完成前验证主流程 |
| superpowers/writing-plans | m-plan | 写计划主流程 |
| superpowers/writing-skills | m-learn | 写 skill 的规范 |

另：m-research 还合并了 FRAMEWORK.md §5（Mola 全局 Web Search Policy：Exa / WebSearch / Tavily / GitHub / Context7 / DSH `deep_search`），该策略无对应 `.sources/` 文件。
