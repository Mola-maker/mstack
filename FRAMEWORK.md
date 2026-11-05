# mstack — 框架规格（给构建 agent 的唯一依据）

mstack = Mola-maker 的个人 agent 工作流技能栈。把 superpowers、gstack、pstack、oh-my-claudecode（OMC）四套 skill 去重合并成 **15 个** skill，按 Mola 的使用习惯改写。同一份 `skills/` 目录同时给 Claude Code（plugin）、DSH（`~/.dsh/skills`）、Codex 用。

## 1. 为什么要做（用户画像 → 设计约束）

| 习惯 / 痛点（来自 1592 条历史 prompt） | 对 mstack 的约束 |
|---|---|
| prompt 很短（中位 28 字）："继续"、"开工"、贴日志 | 有一个总入口 `mstack`，能从 `.mstack/` 状态推断当前阶段并接着干；不要求用户说出 skill 名 |
| 最常用：brainstorming(20)、ultragoal/goal(32)、code-review(11)、/compact(49)、/resume(73) | 这几条链路做到最好：`m-think`、`m-goal`、`m-review`、`m-handoff` |
| 爱并行分派（"分派给 subagents"），跨 Claude / DSH / Codex / Kimi 多模型 | `m-dispatch` 跨 harness：Claude subagent、DSH headless、Codex；每个子任务自包含 |
| 真实测试后再 PR，保留 trace 和 commit 历史 | `m-verify` 要求证据；`m-ship` 先跑真测试再开 PR |
| 痛点：插件冲突（omc vs superpowers）、工具调用死循环、上下文膨胀 | 15 个 skill 互不重叠；每个 SKILL.md ≤150 行，细节放 `references/`；`m-guard` 管冲突与死循环（同一错误 3 次就停） |
| 无人值守运行结束时没写 closeout（ultragoal 3 次） | `m-goal` 结束时**必须**写 closeout（成功、失败、被打断都写） |
| 中文为主夹英文 | skill 正文英文（省 token、各模型都稳），description 里带中文触发词；对用户的输出跟随用户语言 |
| 方向：agent infra（LayerFS/Rust、DSH 插件/TS）、个人站（Astro 动画）、CAD2GIS、信息聚合 | 例子优先用这些场景；`m-qa` 面向网页（molamaker-site） |
| 已知陷阱：WSL 里 `pkill -f` 会杀掉自己的 shell；dev checkout 不能 `git pull`；magpie 管模型列表；清 %TEMP% 要排除 `%TEMP%\claude` | 写进 `m-guard` |

## 2. 15 个 skill 与来源映射

来源文件都在 `.sources/<stack>/<name>.md`（只读参考，不要复制大段原文，用自己的话重写、合并、删掉重复）。

| # | skill | 一句话 | 合并自（读这些） |
|---|---|---|---|
| 1 | `mstack` | 总入口：判断阶段 → 选 skill；"继续"时读 `.mstack/` 恢复；10 条核心原则 | superpowers/using-superpowers, pstack/poteto-mode, pstack/principle-*（全部）, omc/autopilot |
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
```

**核心原则**（`mstack` 里写全，其他 skill 只引用编号）：
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
  model overlay：`- id: agent-default-model / config: {provider: magpie, model: deepseek/deepseek-v4-pro}`；轻活用 `deepseek/deepseek-v4-flash`。Windows 路径 `E:\x` 在 WSL 里是 `/mnt/e/x`。`--json` 输出事件流。
- DSH 交互会话内：`subagent` / `subagent_fork` / `subagent_claude_code` / `subagent_codex` / `workflow`。
- Codex：`codex exec "<task>"`。
- 隔离：改代码的子任务各自一个 `git worktree`（`agent/<task>` 分支）或 LayerFS branch；两个子任务不许改同一个文件。

## 7. 仓库其余部分

```
.claude-plugin/plugin.json      Claude Code plugin 清单（name: mstack）
README.md                       中文：是什么、15 个 skill 一览、安装（Claude / DSH / Codex）、和原插件怎么共存
docs/source-map.md              每个来源 skill → 归入哪个 m-skill / 不收的理由（覆盖 .sources 里的全部文件）
docs/migration.md               装了 mstack 后建议停用哪些重叠插件/skill（只建议，不自动改用户配置）
NOTICE.md                       致谢四个上游项目及其许可证（superpowers MIT / gstack MIT / pstack 见其仓库 / OMC MIT）
```

## 8. 验收标准（构建完成的定义）

- 15 个 `skills/*/SKILL.md` 都在，frontmatter 三字段齐全，`name` 与目录名一致，每个 ≤150 行。
- 每个 SKILL.md 含 §3 规定的 6 节。
- 不出现 `superpowers:`、`oh-my-claudecode:`、`omc:` 形式的 skill 引用。
- `docs/source-map.md` 覆盖 `.sources/` 下每一个文件。
- 没有从来源复制超过 2 行的原文。
