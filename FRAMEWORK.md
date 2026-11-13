# mstack — 框架规格（给构建 agent 的唯一依据）

mstack = Mola-maker 的个人 agent 工作流技能栈。把 superpowers、gstack、pstack、oh-my-claudecode（OMC）四套 skill 去重合并成 **16 个** skill，另加 1 个自己写的 `m-cua`（共 17 个），按 Mola 的使用习惯改写。同一份 `skills/` 目录同时给 Claude Code（plugin）、DSH（`~/.dsh/skills`）、Codex 用。

## 1. 为什么要做（用户画像 → 设计约束）

| 习惯 / 痛点（来自 1592 条历史 prompt） | 对 mstack 的约束 |
|---|---|
| prompt 很短（中位 28 字）："继续"、"开工"、贴日志 | 有一个总入口 `m-start`，能从 `.mstack/` 状态推断当前阶段并接着干；不要求用户说出 skill 名 |
| 最常用：brainstorming(20)、ultragoal/goal(32)、code-review(11)、/compact(49)、/resume(73) | 这几条链路做到最好：`m-think`、`m-goal`、`m-review`、`m-handoff` |
| 爱并行分派（"分派给 subagents"），跨 Claude / DSH / Codex / Kimi 多模型 | `m-dispatch` 跨 harness：Claude subagent、DSH headless、Codex；每个子任务自包含 |
| 真实测试后再 PR，保留 trace 和 commit 历史 | `m-verify` 要求证据；`m-ship` 先跑真测试再开 PR |
| 痛点：插件冲突（omc vs superpowers）、工具调用死循环、上下文膨胀 | 17 个 skill 互不重叠；每个 SKILL.md ≤150 行，细节放 `references/`；`m-guard` 管冲突与死循环（同一错误 3 次就停） |
| 无人值守运行结束时没写 closeout（ultragoal 3 次） | `m-goal` 结束时**必须**写 closeout（成功、失败、被打断都写） |
| 中文为主夹英文 | skill 正文英文（省 token、各模型都稳），description 里带中文触发词；对用户的输出跟随用户语言 |
| 方向：agent infra（LayerFS/Rust、DSH 插件/TS）、个人站（Astro 动画）、CAD2GIS、信息聚合 | 例子优先用这些场景；`m-qa` 面向网页（molamaker-site） |
| 已知陷阱：WSL 里 `pkill -f` 会杀掉自己的 shell；dev checkout 不能 `git pull`；magpie 管模型列表；清 %TEMP% 要排除 `%TEMP%\claude` | 写进 `m-guard` |

## 2. 17 个 skill 与来源映射

来源文件都在 `.sources/<stack>/<name>.md`（只读参考，不要复制大段原文，用自己的话重写、合并、删掉重复）。

| # | skill | 一句话 | 合并自（读这些） |
|---|---|---|---|
| 1 | `m-start` | 总入口：判断阶段 → 选 skill；"继续"时读 `.mstack/` 恢复；10 条核心原则 | superpowers/using-superpowers, pstack/poteto-mode, pstack/principle-*（全部）, omc/autopilot |
| 2 | `m-think` | 动手前想清楚：攻击前提、问最少的问题（每次 ≤3 个，带推荐默认值）、出设计稿 | superpowers/brainstorming, gstack/office-hours, gstack/plan-ceo-review, pstack/interrogate, pstack/sharpen, omc/deep-interview |
| 3 | `m-plan` | 把设计拆成可验证的步骤，每步写清怎么验；独立 critic 复核 | superpowers/writing-plans, superpowers/executing-plans, gstack/plan-eng-review, gstack/autoplan, gstack/spec, pstack/architect, omc/ralplan, omc/plan |
| 4 | `m-goal` | 长跑目标循环：goal 文件、检查点、停止条件、强制 closeout | omc/ultragoal, omc/ralph, omc/autopilot, pstack/principle-outcome-oriented-execution, pstack/principle-never-block-on-the-human |
| 5 | `m-dispatch` | 并行分派到 Claude subagent / DSH headless / Codex；隔离、合并、独立验证 | superpowers/dispatching-parallel-agents, superpowers/subagent-driven-development, superpowers/using-git-worktrees, omc/team, pstack/swarm, dsh/parallel-dispatch |
| 6 | `m-verify` | 没有证据不说"完成"；TDD 用法；测行为不测实现 | superpowers/verification-before-completion, superpowers/test-driven-development, omc/verify, gstack/verify, pstack/tdd, pstack/show-me-your-work, pstack/principle-prove-it-works |
| 7 | `m-debug` | 复现 → 竞争假设 → 找根因 → 回归测试；3 次失败就停下换思路 | superpowers/systematic-debugging, gstack/investigate, omc/trace, omc/debug, pstack/figure-it-out, pstack/why, pstack/principle-fix-root-causes |
| 8 | `m-review` | 多角度并行 review（写的人不审）；接收 review 时先验证再改 | superpowers/requesting-code-review, superpowers/receiving-code-review, gstack/review, gstack/cso, pstack/thermo-nuclear-review, pstack/blast-radius, omc/review |
| 9 | `m-ship` | 同步上游 → 真测试 → review → PR 文档 → 开 PR → 盯 CI 和评论 | dsh/ship-pr, gstack/ship, gstack/land-and-deploy, gstack/document-release, superpowers/finishing-a-development-branch, pstack/make-pr-easy-to-review, pstack/babysit, pstack/fix-ci, pstack/get-pr-comments |
| 10 | `m-qa` | 网页真机验收：起服务、Playwright 走流程、截图对比、性能、设计问题 | gstack/qa, gstack/qa-only, gstack/design-review, gstack/health |
| 11 | `m-research` | 多渠道调研：≥3 渠道并行、去重交叉验证、列来源 | dsh/deep-research, omc/research, 用户全局 CLAUDE.md 的 Web Search Policy（见 §5） |
| 12 | `m-handoff` | 存档 / 恢复上下文：`.mstack/handoff.md`；compact 前、换模型前、会话结束时写 | gstack/context-save, gstack/context-restore, omc/remember, pstack/recall, pstack/what-did-i-get-done, dsh/token-thrift, pstack/principle-guard-the-context-window |
| 13 | `m-learn` | 复盘与沉淀：post-mortem → `~/.claude/lessons/`，可复用流程 → 候选 SKILL.md，事实 → memory | gstack/retro, gstack/learn, pstack/reflect, pstack/correct, omc/skillify, omc/self-improve, superpowers/writing-skills, pstack/principle-encode-lessons-in-structure |
| 14 | `m-deslop` | 删 AI 味：多余代码、注释、抽象、废话 | pstack/deslop, pstack/unslop, omc/ai-slop-cleaner, omc/minimal-code-discipline, omc/minimal-prose-discipline, pstack/principle-subtract-before-you-add |
| 15 | `m-guard` | 安全护栏 + 插件冲突体检 + 死循环刹车 + Mola 的已知陷阱 | gstack/careful, gstack/freeze, gstack/guard, dsh/plugin-intake, superpowers/diagnosing-superpowers |
| 16 | `m-team` | 会进化的 agent team：开放式大预算目标按轮次重组团队，supervisor 每轮诊断卡点并重设角色与知识流向 | papers/evolving-agent-teams, orca/*（详见 §9） |
| 17 | `m-cua` | 操作真实界面做 L3/L4 验收（桌面 / Android / 浏览器）：探测驱动 → 观察-操作-再观察 → 写成可重放脚本 → 记回执 | 无上游来源，自己写的；桌面驱动用 vercel-labs/agent-desktop，Android 用 adb |

明确**不收**的（太窄或与 Mola 无关）：gstack 的 iOS 系列、design-shotgun、setup-gbrain、ubicloud、supabase；pstack 的 ketchup、bro、arena、statechart、typescript-best-practices、formal-verification 系列。

## 3. 每个 skill 的文件格式（硬性要求）

```
skills/<name>/SKILL.md          必需，≤150 行
skills/<name>/references/*.md   可选，放模板、长清单、例子；SKILL.md 里写明何时读哪个
```

SKILL.md 的 frontmatter（三个字段都要有）：

```yaml
---
name: m-review
description: <英文一句话说做什么 + "Use when …" + 中文触发词，如 "review一下/审一下/看看这个PR">
whenToUse: <英文一句话，DSH 用这个字段决定何时加载>
---
```

正文固定这几节，按顺序：

1. `# <Title>` + 一段 2–3 句的目的
2. `## When to use / not use` — 包括"该转给哪个 m-skill"
3. `## Procedure` — 编号步骤，每步可执行、可检查
4. `## Output` — 产出什么文件 / 给用户什么格式的汇报
5. `## Stop conditions` — 什么时候停下来问用户、什么时候放弃
6. `## Harness notes` — Claude Code / DSH / Codex 下工具名的差别（只写有差别的）

写作规则：
- 祈使句，具体到能照做；不写口号、不写"确保高质量"之类空话。
- 不复制来源原文超过 2 行；合并后的规则如果互相矛盾，按 §4 原则取舍并在 references/decisions.md 里记一行理由（只在确有冲突时写）。
- 不发明 Mola 没有的工具。可用的：Claude Code 的 Agent/Skill/Bash/Read/Edit/Grep/Glob、OMC 的 state/notepad MCP（可选，没有就用文件）；DSH 的 subagent/subagent_fork/subagent_claude_code/subagent_codex/workflow/todo_write/deep_search；Codex CLI `codex exec`；`gh`；Playwright。
- 跨 skill 引用写成 `m-xxx`，不要引用 superpowers:/omc: 名字（mstack 要能单独装）。

## 4. 共享约定

**状态目录**（项目根下，建议 gitignore 掉 `handoff.md` 以外的内容由用户决定）：

```
.mstack/
  specs/<YYYY-MM-DD>-<slug>.md     m-think 产出
  plans/<YYYY-MM-DD>-<slug>.md     m-plan 产出（步骤 + 每步验证方式 + 状态勾选）
  goals/<slug>.md                  m-goal 的目标、检查点、closeout
  handoff.md                       m-handoff 的最新存档（覆盖写，旧的进 handoff-archive/）
  reviews/<date>-<slug>.md         m-review 汇总
  verify/baseline.txt              m-verify 基线：开工前已失败的测试签名（新失败才阻断）
  goals/<slug>.state.json          m-goal 循环状态：status、起始提交、连续失败计数、预算
  qa/<YYYY-MM-DD>-<slug>.md        m-qa 报告
  freeze                           m-guard 冻结范围（可选钩子读取）
  qa/<YYYY-MM-DD>-<slug>.md        m-qa 验收报告（带截图与评分）
```

**核心原则**（`m-start` 里写全，其他 skill 只引用编号）：
1. 先攻击前提：问题本身对不对、有没有更简单的路。
2. 先减后加：能删就不加；不做没要求的功能。
3. 可验证的小步：每一步都有检查方式，按顺序做。
4. 证据先于结论：没跑过的不说能跑，没看到输出不说通过。
5. 修根因，不修症状。
6. 写的人不审：review / verify 交给另一个 agent 或另一个模型。
7. 护住上下文：读摘要不读全文，大输出落盘，主会话只做拆分、合并、判断。
8. 不卡在人身上：能用默认值推进就推进，把决定记下来；只有不可逆或对外的动作才停下来问。
9. 同一个错误连续 3 次 → 停，换假设或上报，不要重试第 4 次。
10. 教训进结构：重复的坑写成 lesson、检查脚本或 skill，不靠记性。

**汇报格式**（所有 skill 收尾一致）：一句话结论 → 做了什么（文件:行）→ 怎么验证的（命令 + 结果）→ 没做的 / 风险。中文。

## 5. Mola 的全局调研策略（m-research 的依据）

渠道：Exa（语义搜索，首选）、WebSearch（新闻/官方页，深度用 extended）、Tavily / AnySearch（交叉验证，中文内容）、GitHub（`gh search repos|code|issues` + `gh api`）、Context7（库/SDK 文档优先）。DSH 内用 `deep_search` 工具（一次多渠道、RRF 排序、标出多渠道命中）。深度调研：≥3 渠道并行 → 去重交叉验证 → 列出来源；单渠道孤证要二次查证或标注。

## 6. 跨 harness 分派（m-dispatch 的依据，已实测可用）

- Claude Code：`Agent` 工具（subagent_type 选 executor/explore/verifier 等；`run_in_background`）。
- DSH headless（WSL，已实测能写文件）：
  ```sh
  wsl -e bash -lc 'source ~/src/mola-dsh-stack/scripts/env.sh; cd <wsl路径>; \
    dsh --profile mola-cli --patch <model-overlay.yml> "<task>" > <log> 2>&1'
  ```
  model overlay：`- id: agent-default-model / config: {provider: magpie, model: group/smart-split}`。**一律走 magpie 路由**（`group/*` 或 `auto/*`），不要用 `deepseek/*`（直连 DeepSeek，余额会耗尽，402 时所有 worker 同时死）。`group/smart-split` 不接受 reasoningEffort。Windows 路径 `E:\x` 在 WSL 里是 `/mnt/e/x`。`--json` 输出事件流。
- DSH 交互会话内：`subagent` / `subagent_fork` / `subagent_claude_code` / `subagent_codex` / `workflow`。
- Codex：`codex exec "<task>"`。
- 隔离：改代码的子任务各自一个 `git worktree`（`agent/<task>` 分支）或 LayerFS branch；两个子任务不许改同一个文件。

## 7. 仓库其余部分

```
.claude-plugin/plugin.json      Claude Code plugin 清单（name: mstack）
README.md                       中文：是什么、17 个 skill 一览、安装（Claude / DSH / Codex）、和原插件怎么共存
docs/source-map.md              每个来源 skill → 归入哪个 m-skill / 不收的理由（覆盖 .sources 里的全部文件）
docs/migration.md               装了 mstack 后建议停用哪些重叠插件/skill（只建议，不自动改用户配置）
NOTICE.md                       致谢四个上游项目及其许可证（superpowers MIT / gstack MIT / pstack 见其仓库 / OMC MIT）
```

## 8. 验收标准（构建完成的定义）

- 17 个 `skills/*/SKILL.md` 都在（含 §9 的 `m-team` 和 0.7.0 的 `m-cua`），frontmatter 三字段齐全，`name` 与目录名一致，每个 ≤150 行。
- 每个 SKILL.md 含 §3 规定的 6 节。
- 不出现 `superpowers:`、`oh-my-claudecode:`、`omc:` 形式的 skill 引用。
- `docs/source-map.md` 覆盖 `.sources/` 下每一个文件。
- 没有从来源复制超过 2 行的原文。

## 9. 增补：会进化的 agent team（`m-team`）+ Orca 后端（2026-11-04）

依据：`.sources/papers/evolving-agent-teams.md`（arXiv 2610.36848，Evolving Agent Teams）和 `.sources/orca/*`（stablyai/orca 的 orchestration / orca-cli 指南）。

### 9.1 新 skill `m-team`（第 16 个）

一句话：开放式、长预算的任务交给一个**会按轮次重组**的 agent team。supervisor 每轮结束读结果、诊断卡点、重新设计角色 / 协作方式 / 知识流向，再开下一轮。

与已有 skill 的边界（不许重叠）：
- `m-dispatch` = 一轮内的执行机制（拆、隔离、发、合并、验）。`m-team` 每轮都调用它，不重复写分派细节。
- `m-goal` = 目标文件、检查点、closeout。开放式优化目标（性能、得分、通过率要一直往上推）由 `m-goal` 转交 `m-team`，closeout 仍由 `m-goal` 写。
- 小预算或目标明确的任务：单 agent 或一轮 `m-dispatch` 就够（论文：预算小时 team 与 solo 几乎打平，预算大了 team 才拉开）。`m-team` 的 When-not-use 要写清这一点。

必须包含：
1. **Team 配置 = (角色, 协作方式, 知识放哪)**，每一轮写成 `.mstack/team/<slug>/v<N>.md`：本轮角色（每个角色有职责、能改什么、禁止改什么、交付什么证据）、协作形状（solo / 流水线 / 并行分支）、每个角色写到哪个文件或分支、本轮预算、本轮的门槛。
2. **持久知识 K**（所有轮次共享）：`.mstack/team/<slug>/LEARNINGS.md`（追加式实测观察，每条带证据）、`SYNTHESIS.md`（Knowledge Integrator 整理的可执行结论，**每个新角色开工前必读**）、`history.md`（supervisor 每轮的反思与设计决定）。新一轮继承全部失败尝试和成功策略。
3. **Supervisor 反思清单**：先看指标与门槛，再逐条查失败模式：滑向容易的路、前几轮的关键结论丢了、卡在调试、对着过期的 profile 微调、平台期。归类为知识缺口 / 搜索穷尽 / 纪律问题，然后对应重组。
4. **角色是按需发明的**，references 里给一个起步角色目录（不是固定清单）：Focused Debugger（隔离分支、不许碰主产物）、Disciplinarian（守住选定架构、一次一个改动、先测量后改）、Knowledge Integrator、Challenger（挑战"已到上限"的说法）、Auditor、Profile-Driven Optimizer、Dead-End Revisitor（重开被放弃的难方向）、Research（查资料）、Architect。每个配"什么症状 → 加这个角色"。
5. **用文件和产物协作，不用散文消息**：角色之间传递的是文件、diff、测量数据、失败用例，交叉核对要逐字节对产物，不要"我们达成一致"式的总结消息（论文里固定团队就败在这）。
6. **硬门槛**：任何一个门槛失败，这个候选就记 0 分；保留一组 held-out 检查（只检查不计分）。发现评估本身漏掉一类 bug 时，加一条新检查，以后每个候选都必须通过（评估加固），并记进 LEARNINGS。
7. **触发与停止**：一轮结束，或按固定间隔触发 supervisor（Claude Code：`ScheduleWakeup` / `CronCreate`；DSH：loop 插件 / `max_goal_rounds`）。停止条件：预算（token/$/墙钟）、轮次上限、连续 2 轮指标无提升且 supervisor 给不出新诊断 → 交回 `m-goal` 写 closeout。
8. **执行后端**沿用 `m-dispatch`，另加 Orca（§9.2）。

文件：`skills/m-team/SKILL.md` ≤150 行；`references/supervisor-checklist.md`、`references/role-catalog.md`、`references/team-config-template.md`（v<N>.md 的模板）。

### 9.2 Orca 后端（stablyai/orca，可选）

Orca 是桌面端 + CLI 的多 agent 编排器：每个 worker（Claude Code / Codex / OpenCode / Pi）各自一个 worktree，手机端可盯。**当前没装**，所以写成"`orca` 在 PATH 上才用"。用法（只写 `.sources/orca/` 里有的命令，别编）：
- 开 worker：`orca orchestration worker-start --spec "<自包含任务>" --worktree current|new-top-level --agent codex|claude`，开完所有 worker 就**结束本轮**，Orca 会唤醒你；不要轮询、不要写 watch 脚本。
- 跟 worker 说话：`orca orchestration send --to dispatch:<id> --subject … --body …`；回答 worker 提问：`orca orchestration reply --id <message_id> --body …`。
- `worker_done` 结算任务；`escalation` + `stopReason` 表示 worker 没交付就停了。
- 交出去不需要回报的活：`orca worktree create --name … --no-parent --agent … --prompt … --json`（独立交接用 `--no-parent`，别做成 stacked 父子 lineage）。
放进 `m-dispatch/references/harness-commands.md` 的一个新小节，并在 `m-dispatch` 的执行器选择表里加一行：需要别家 agent（如从 Claude 派 Codex）、要手机盯、要每个 worker 独立 worktree 且留给人继续用 → Orca。

### 9.3 要改的已有文件

- `skills/m-start/SKILL.md`：路由表加 `m-team`（"组队/team/一直优化/卡在局部最优"）。
- `skills/m-dispatch/SKILL.md` + `references/harness-commands.md`：Orca 行与小节；模型一律 magpie 路由（`group/smart-split`），删掉 `deepseek/*` 的写法。
- `skills/m-goal/SKILL.md`：开放式优化目标转交 `m-team` 的一句话。
- `README.md`：15 → 16，表里加 `m-team`；安装方式补 GitHub marketplace：`claude plugin marketplace add Mola-maker/mstack`。
- `docs/source-map.md`：加 `papers/evolving-agent-teams` 和 `orca/*` 五个文件的行。
- 不改 `scripts/check.mjs`、`FRAMEWORK.md`、`.claude-plugin/*`（这些由主会话维护）。

## 10. 改名：总入口 `mstack` → `m-start`（0.3.0）

Claude Code 会把**与插件同名的 skill**（`mstack:mstack`）的 description 去掉，只列名字，路由时模型看不到它何时该用（2026-11-04 实测：改名为 `m-start` 后 description 立即出现）。所以总入口改名为 `m-start`；文中其余"`mstack` 总入口"均指它。skill 名一律不要与插件名相同。

## 11. 第二轮改进：工程实践整合（0.4.0，2026-11-06）

依据：`research/omc.md`、`research/pstack.md`、`research/papers.md`、`research/repos.md`、`research/evals.md`（5 个 haiku subagent 调研，每条都带来源）。总方向：**把"只靠文字的约束"改成"可检查的规则、有固定字段的产出、可执行的脚本或钩子"**（原则 10）。不收：OMC 的多轮全流程（5 轮 interview、ralplan 循环）、pstack 的 arena / TLA+ 工具链。只吸收做法。

每个 SKILL.md 仍然 ≤150 行；细节放 `references/`；可执行的东西放 `skills/<name>/scripts/`（Node，零依赖，跨平台）。

### 11.1 按 skill 的改动

**m-verify**（OMC 1/10/12，pstack 2/6，papers 10-12，repos cursorrules）
- 基线门：第一次改代码前，把已失败的测试签名存到 `.mstack/verify/baseline.txt`；之后只有**新出现**的失败才阻断，基线里的失败只作为警告。
- 新检查必须先红：新增或修改的检查，要先在破坏版本上跑出预期失败，并引用失败内容。（同时修 m-debug 那句"see m-verify"的悬空引用。）
- 防作弊门：diff 改到测试、fixture、conftest、grader 或 CI 配置，而用户没要求时，判为不通过。最终验收在干净的 checkout 里跑。
- 机械扫描：`skills/m-verify/scripts/diff-blockers.mjs` 扫描 `git diff <base>` 新增行里的 `.only(`、`.skip(`、`TODO`、`FIXME`、`NotImplemented`、`not implemented`、`debugger`；退出码非 0 就不算完成。
- 产出：按验收标准逐条给 VERIFIED / PARTIAL / MISSING，每条附证明命令；加一行回归检查（改动文件的调用方的测试，给通过和失败数）；加一行范围检查（`git diff --stat` 里的文件是否都在任务范围内）。
- 数字：凡是性能或准确率数字，必须附 run 次数、离散度和噪声来源。
- 跨模型复核：明确为"不同模型家族"。

**m-debug**（OMC 13，papers 2/4/19）
- 每个假设一行表：支持证据 / 反对证据 / 可区分的预测 / 最便宜的区分探针；只靠时间巧合、命名或类比的证据要降权。
- bug 修复默认按固定顺序走：定位 → 复现 → 补丁 → 验证。有测试时先用覆盖率定位。固定路径失败后才自由探索。
- 一次尝试失败后写一段反思（哪里失败、为什么、下一步查什么），交给下一次重试。

**m-review**（OMC 5/11，pstack 3/8/9，papers 13-17，repos ECC agents）
- 加两个轴，分开出结论：**intent**（diff 对照 plan 或 spec 的验收标准，要引用原句）和 **standards**（找出仓库里的 CLAUDE.md、AGENTS.md、CONTRIBUTING 并逐条对照）。
- 消费者普查：列出改动的导出符号、协议、数据格式在 diff 之外的调用方，附一条能跑的证明。
- 新角度：downstream consumers、devex（环境变量、端口、新增必跑脚本），以及 feature-gate（只在改动涉及时启用）。
- 范围规则：只报 diff 里新增或修改的代码；作者有意改动且范围明确的，归入 cleared。
- 每条 finding 加一个 `repro: <command> → <实际输出>` 字段；没有 repro 的归入"未证实"，不计入结论。
- 比较多个候选时：A/B 和 B/A 各评一次，结论一致才采纳；隐藏作者身份；高风险 finding 加一个反驳阶段，专门尝试推翻它。
- 评审强度按规模定：少于 5 个文件且无风险用 sonnet；超过 20 个文件，或涉及 auth、crypto、破坏性改动，用 opus 并加 security 角度。
- Claude Code 下评审用只读工具的 agent（`code-reviewer`、`verifier`），由工具权限保证"写的人不审"。

**m-dispatch**（pstack 10，papers 6/9/16，repos orca）
- 分派前先写明选择规则：first pass / rank all / best-of。
- RETURN 里缺证据，记为 gap 并重派一次；第二次仍缺，不算通过。
- 多个候选补丁时：先按完全相同的 diff 聚类取多数，再交给另一个模型家族的验证者，并把所有候选并排给它看。
- 默认用自己的 subagent。只有需要其他 agent，或需要独立 worktree 留给人接手时才用 Orca。派出后结束本轮，不轮询。

**m-goal**（OMC 2/3/9，pstack 7，papers 7/26）
- 循环状态写进 `.mstack/goals/<slug>.state.json`：每种错误签名的失败次数、轮数、已用 token、上次有进展的时间。每个 checkpoint 读一次：同一签名失败 3 次，或预算用到 100%，就停；用到 90% 时警告。
- 最终门固定顺序：m-deslop（只处理改动过的文件）→ m-verify → m-review。review 被否决时追加一个新的子目标，不能标记完成。closeout 里加一个 `gate` 块，记录这三项的结果。
- 验收标准只能修订、不能改写：被推翻的标准原文保留在 `## Amendments` 下，附理由和实测证据。
- checkpoint 固定 5 列（ts / decision / why / evidence / result），只追加。closeout 加一个 "Attention" 段，由另一个模型填写（可以写"无"）。
- 预算优先花在"多次尝试加选优"上，不要花在一次更大的单次尝试上；goal 文件里写明每个任务的尝试上限。

**m-start**（OMC 6）
- 读状态时检查陈旧：状态不是终态、且文件超过 2 小时没修改的 goal 或 team 文件，报告为 stale，并附上它的 resume-hint；没有 `## Closeout` 的 goal 视为异常中断。只提示，不自动处理。

**m-handoff**（OMC 4，repos superpowers hooks，papers 18/19）
- 插件随附 `hooks/hooks.json`：
  - **PreCompact**：运行 `node "${CLAUDE_PLUGIN_ROOT}/hooks/precompact.mjs"`，写一个 `.mstack/handoff.md` 骨架（分支、`git status --short`、当前 goal 路径、时间戳）；已有内容不覆盖，只追加一个 "auto snapshot" 段。
  - **SessionStart**，matcher 为 `compact`：如果存在 `.mstack/handoff.md`，输出一行提示让模型读它。
  - 两个脚本都必须在 1 秒内退出、不联网、任何异常都以 0 退出（不能阻断会话）。
- 状态分三层：稳定的任务框架（goal、约束）、压缩后的进度、最近几步的原文。

**m-plan**（OMC 8，pstack 4/5，papers 2）
- 涉及新的模块边界或公开类型时，先写 ≥2 个结构不同的形状（每个只给接口草图，≤15 行），由 critic 选定，理由写进 Review Focus。
- 有状态或并发的任务，加必填小节"状态与不变量"：列出状态、转移，以及 3-5 条不变量，每条注明由哪个测试检查。
- critic 的提示词放进 `references/critic.md`：假设按 VERIFIED / REASONABLE / FRAGILE 评级；做一个 3 场景的 pre-mortem，每个场景对应到一个任务或一行 Review Focus。

**m-think**（OMC 7，pstack 11）
- 能用 30 分钟以内的运行回答的问题，先做原型，不占提问名额。
- spec 头部写一个 readiness 自评（goal、约束、验收标准各 0-1）。这只是参考，不是门槛，也不能因此增加问题数。

**m-team**（papers 26，pstack 12）
- 每轮都要有一个同预算的 solo 基线；如果团队相对 solo 的增益在噪声范围内，就停止组队。
- 评分只看匿名标签。

**m-learn**（papers 21-25，repos superpowers/ECC）
- 写 skill 走 RED-GREEN：先跑一次没有这个 skill 的基线，记下 agent 的借口，再写 skill 去堵它，然后复跑验证。清单放 `references/skill-creation.md`。
- 同一教训出现 2 次以上，且通过验证，才写成 skill；只在一个项目出现的，留在该项目的 `.mstack/`。
- skill 生命周期：create / verify / retrieve / refine / retire，记录成功次数，低成功率的 skill 退役。

**m-guard**（repos gstack careful/freeze, ECC）
- `references/hooks.md`：可选的 Claude Code PreToolUse 钩子片段，用 `permissionDecision: "ask"` 语义：
  - Bash 拦截 `rm -rf /`、`~`、force-push 到默认分支（允许 `--force-with-lease`）；
  - Edit/Write 拦截 `.mstack/freeze` 里列出路径之外的修改。
  - 默认不安装，由用户选择是否装。
- `references/skill-audit.md`：装好之后的 skill 体检清单（重名、frontmatter、体积、冲突）。

**m-qa**（pstack 1）
- 首次运行时，为项目生成一个验证 skill，放在项目的 `.claude/skills/verify/SKILL.md`，固定章节为 Launch / Doctor / Drive / Evidence / Cleanup，外加 features/ 功能地图。之后的运行先用它，并维护它。报告结论只能是 clean / changed / blocked。

### 11.2 仓库级（主会话负责）
- `evals/`：用 `claude plugin eval` 跑的路由用例（case.yaml schema 1.1，见 research/evals.md），先覆盖 m-start、m-review、m-verify、m-debug、m-ship，包括应该触发和不该触发两类。本地运行，不进默认 CI，因为要花钱。
- `check.mjs` 新增检查：SKILL.md ≤12000 字节；`skills/<name>/` 下只允许 SKILL.md、references/、scripts/；description ≤1024 字符；evals 文件能解析。
- 仓库根加一个约 20 行的 `AGENTS.md`：验证命令和仓库约定。

## 12. Round 3: prompt craft, agents, model layer, DSH-native teams (0.5.0, 2026-11-07)

Owner feedback: the prompts are rough, the agents are weak, nothing is assigned by model strength, and the team capability barely shows in DSH. Research: `research/round3/` (superpowers-craft, omc-agents, pstack-craft, arena-routing, dsh-team, starred-gaps).

### 12.1 Prompt craft (applies to every SKILL.md you touch; from superpowers-craft.md)
- **One rule + loophole list.** (0.6.0: the rule is written in normal sentence case; the all-caps "Iron Law" wording is retired and `scripts/check.mjs` rejects it. A rule that must hold mechanically belongs in a hook or a script.) Each discipline skill opens its Procedure with one absolute rule in a line by itself, followed by the specific ways agents try to get around it, each one closed off explicitly.
- **Rationalization table.** `| You will be tempted to think… | Reality |`, 4–8 rows, drawn from real failures in this repo's history (reviews/, logs, lessons) and research — never invented filler.
- **Red flags.** A short list of observable signs that you are breaking the skill right now ("you wrote 'should work'", "you are about to edit a test to make it pass").
- **Countable stop conditions + Ruling record.** Stops are numbers ("3 consecutive", "2 fixes on the same premise", "5 review rounds"); every judgement call not covered becomes one line `Ruling: decision | reason | cost if wrong` in the skill's state file.
- **Gate function.** Before any success claim: `| claim | evidence required | evidence that is NOT enough |`.
- **Form by failure type.** Discipline failures get prohibitions; shape failures get a positive recipe. No nuance clauses that reopen the rule.
- Announce on use: the first line the agent says when a skill starts is `Using m-xxx: <one-line purpose>`.

### 12.2 Agents (from omc-agents.md): ship `agents/*.md` in the plugin
Seven agents. Frontmatter is `name`, `description`, `model`, `disallowedTools`. The body follows OMC's anatomy: Role, Why it matters, Success criteria, Constraints, Protocol, Output contract, Failure modes, Final checklist.

| agent | model | tools | spawned by |
|---|---|---|---|
| m-explorer | haiku | no Write/Edit | m-think, m-plan, m-debug, m-research fan-out |
| m-implementer | sonnet | all; works only in its assigned worktree | m-dispatch |
| m-debugger | sonnet | all; stops after 3 failed hypotheses | m-debug |
| m-verifier | sonnet | no Write/Edit | m-verify, m-ship; returns PASS / FAIL / INCOMPLETE with an evidence table |
| m-reviewer | opus | no Write/Edit | m-review; returns APPROVE / REQUEST CHANGES |
| m-critic | opus | no Write/Edit | m-plan, m-think wild-mode convergence |
| m-researcher | sonnet | no Write/Edit except its report file | m-research, one channel per agent |

Skills name these agents in their Harness notes (Claude Code: `subagent_type: "mstack:m-reviewer"`).

### 12.3 Model layer (from arena-routing.md): `config/model-routing.json`
- `tasks` maps a task kind to ranked magpie routes, with evidence. `families` maps a model family to its prompt-adapter rules.
- mstack: `m-dispatch/references/model-routing.md` explains how to pick a route per subtask and how to adapt the brief per family. m-team and m-review pick the judge from a different family than the author.
- mola: `mola run` chooses the route from `tasks[kind].picks` (kind inferred, or `--kind`). Before calling the agent it rewrites the prompt with the family adapter (XML for claude, markdown sections for others). `mola models rank [kind]` prints the table. Quota failures walk down the picks list (the ladder). The data comes from one file shared by both.

### 12.4 DSH-native teams (from dsh-team.md)
- In DSH, m-team and m-dispatch drive native tools:
  - roles: `spawn_teammate`
  - task board: `team_task_create`, `team_task_list`, `team_task_update` (`write_scopes` is the file-ownership table)
  - waiting: `wait_agent`
  - rounds: `create_goal` (`max_goal_rounds`) and `update_goal`
  - wake-ups: `schedule_create`
  - scripted fan-out: `workflow` with `agent(prompt, {schema, label, phase, provider})`, using a JSON schema as the RETURN contract.
- Isolation trap: teammates and workflow agents share the lead's cwd. Changes that need isolation go to `subagent` (it takes a cwd), or the lead creates the worktree first and names it in the prompt.
- Ship an optional DSH preset under `dsh/` (`mstack-team`) that enables the experimental agent-team profile. It is opt-in and its version is pinned. Do not disable `subagent` globally.

### 12.5 From pstack-craft and starred-gaps (this round)
- m-dispatch: before re-dispatching, confirm the previous worker has stopped (`git status` in its worktree). Never message an idle worker to ask for progress.
- m-debug: if two fixes on the same premise fail, stop and write the premise down, then test it.
- m-ship: a CI flake gets exactly one fresh run; failing the same way twice means it is not a flake. A failure outside the diff means first checking the base with merge-base.
- m-goal: a stop predicate also needs a minimum number of rounds, so a lucky run cannot end the loop early.
- Panels span families, and the judge comes from a family not used by any candidate.
- m-guard: scanning before a skill or plugin install is mandatory (SkillSpector when available), not optional.
- Queued for mola B3/B4 (design notes only this round): automatic cross-session memory with a review gate; per-worker working/blocked/idle status in `mola dash`; idempotency keys and receipts for multi-machine messages.

## 13. mstack 1.0：从"规则库"到"产品"（2026-11-08）

Owner verdict after three rounds: still hard to use. Measured: no direct mstack invocation in the last 400 prompts; 16 skills = 112 KB the user must know by name. Owner picked the pains: **don't know which to call**, **can't see what it is doing**, **not automatic enough**. So the product is: one entry point, live visibility, unattended runs. Skills become internal stages, not the user interface.

### 13.1 One entry point (M1)
- **Claude Code**: `/go <intent>` (plugin `commands/go.md`). `/go` classifies the intent and runs the pipeline end to end:
  - stages: think (only if vague) → scout → plan → implement → verify → review → ship (only if asked or if the intent says "提PR/ship");
  - each stage spawns the mstack agents (m-explorer, m-researcher, m-implementer, m-verifier, m-reviewer, m-critic);
  - it stops only for irreversible or outward actions.
  It uses Claude Code's own todo list for live progress and writes `.mstack/runs/<id>/progress.json` through `scripts/go-progress.mjs` after every stage (stage, status, agents, cost, next step). At the end, or when blocked on the user, it sends a notification (PushNotification when the harness has it, otherwise `mola notify`).
- **CLI**: `mola go "<intent>" [--auto] [--until <stage>]` runs the same pipeline headless. Each stage is a `mola run` with its own task kind, so the model layer picks the model per stage (plan→opus, implement→sonnet, explore→flash, review→a different family from the implementer). It emits the same progress.json and events, and supports `mola go --resume <id>`.
- The 16 skills stay available, but the user should never need their names; `m-start` routes a whole task stated in one sentence to `/go`.

### 13.2 Live visibility (M1 + M2)
- **Status line** (M1): `mola statusline` prints one line for Claude Code's statusLine hook. It reads the current run's progress.json: `go ▸ verify (4/6) · 3 agents · $0.42 · 6m`. Installing it is an explicit `mola statusline install` that shows the settings.json diff and asks first; never silent. It wraps the existing HUD command instead of replacing it.
- **Per-worker status** (M1): dash shows each worker as working / blocked / idle / done / failed, with its stage, model, elapsed time and cost, derived from progress.json.
- **`mola web`** (M2): a zero-dependency `node:http` server on 127.0.0.1 (optionally the Tailscale IP, with a token) serving one page. It shows live runs over SSE (stages, workers, models, costs, logs tail) and has an approvals panel with approve/deny buttons that unblock `mola go`. It is phone-friendly.

### 13.3 Unattended (M3, next round)
Triggers (GitHub issue/PR/CI through the superagents, schedules, file watch); approval cards pushed to the phone, with the run resuming on approve; automatic memory distillation after each run, with a review gate.

### 13.4 Branch guard: no agent touches a protected branch without a review receipt (M1, owner request 2026-11-08)

Evidence (logs/git-scan*.txt, tasks/scan-gh.sh):
- All 31 commits on mstack `master` since 2026-11-05 landed without a PR. The orchestrator (Claude) committed DSH worker output straight to master.
- In the LayerFS worktrees, DSH workers committed 20+ times before any reviewer subagent had returned.
- `policy-approval` only gates commands that mola itself runs; it never sees the git an agent runs inside DSH.
- **2026-11-08 incident, while this guard was being built:** worker h3 ran in the shared working tree. A failed `cd` in a test command chain made `git reset --hard` and `git push --all` run in the real repo. Every worker's uncommitted edits to tracked files were wiped, and `main` and `mstack-1.0` were pushed to origin. This is the strongest argument for rule 1: workers never share the orchestrator's working tree.

Design: plugin `policy-guard`, defence in depth, reusing the superagent pattern (PATH shim plus a dedicated gitconfig):
1. **Branch rule.** Agents work only on `agent/<run-id>` branches, each in its own worktree. Commit, merge, rebase, reset --hard and push on a protected ref (`main`, `master`, `release/*`, `layerfs_v2_0_0`, plus config `guard.protected`) are refused. `--no-verify`, `-c core.hooksPath=`, `push --all/--mirror` and force pushes are refused everywhere.
2. **Review receipt.** `.mstack/receipts/<tree-sha>.json` holds the reviewer id, reviewer model family, author family, verdict, FINDING counts and verify commands. It is bound to the exact tree hash, so any later change voids it. It counts only if the reviewer family differs from the author family and no blocking FINDING is open.
3. **Enforcement layers.**
   - (a) A `git` shim on the worker PATH plus GIT_CONFIG_GLOBAL with core.hooksPath pointing at guard hooks (pre-commit, pre-push, reference-transaction). mola applies these to every DSH/Codex worker it starts.
   - (b) A Claude Code PreToolUse hook in the mstack plugin, for the orchestrator itself.
   - (c) GitHub branch protection on the default branch: outward-facing, applied only after the owner says yes.
4. **`mola land <branch>`** is the only path to a protected branch. It requires a receipt for the branch tip's tree plus green verify, then opens a PR (default) or fast-forward merges locally with `--local`. Push and PR creation still go through approval.

### 13.5 Scout: search and reuse before writing (M1, owner request 2026-11-08)

Pain: agents write from scratch instead of finding the best existing code.

Plugin `cmd-scout` adds `mola scout "<need>"`. It is also the first working stage of `mola go` and `/go`; it runs before plan and is skipped only for fixes that already point at file:line.
- **Channels, in parallel:**
  - this repo and sibling repos (ripgrep for existing helpers);
  - the owner's GitHub stars (starred.tsv, refreshed via gh);
  - `gh search repos` and `gh search code`;
  - package registries (npm, crates.io);
  - Context7 docs and Exa/Tavily web search, when the agent has them.
- **Harvest.** Shallow sparse clone of the top 3 candidates into `.mstack/scout/<id>/<repo>`. Read the files that implement the need and extract the pattern. Record license, stars, last push and size.
- **Output** `reuse.md`: a candidates table, then a decision per need (`reuse` a dependency / `adapt` code with attribution and license OK / `write` with the reason none fit). The plan must cite it. The reviewer raises `FINDING … reinvented` when the diff re-implements something reuse.md marked reusable.

### 13.6 TUI and web, both plugins (M1)

- `cmd-web` (`mola web`): the phone page.
- `cmd-tui` (`mola tui`): a full-screen terminal UI over the same progress contract, with zero dependencies (ANSI plus raw stdin; it reuses plugin-sdk ui.ts).
  - Panes: runs list | stage pipeline | workers (status, model, cost, elapsed) | live log tail of the selected run.
  - Keys: ↑↓/jk select, enter details, a approve, d deny, s stop, g new `mola go` prompt, r refresh, q quit.
  - It falls back to a plain frame when stdout is not a TTY.
