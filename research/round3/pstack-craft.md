# pstack 第三轮：提示与编排工艺（pstack-craft）

日期：2026-11-06。只读调研，未改 E:\mstack 下任何文件，未运行任何 pstack 代码。来源全部是 GitHub 上的原文（`gh api`）。

## 0. 先修正上一轮：pstack.md 的大部分建议已经过时

逐条核对了当前 E:\mstack\skills（不是旧版）：

| pstack.md 条目 | 当前 mstack 状态（已核对） |
|---|---|
| 1 项目验证 skill | 已有：m-qa 生成并维护 `.claude/skills/verify/`，附 `check-verify-skill.mjs` |
| 2 新检查先红 | 已有：m-verify step 5「Prove new checks red first」 |
| 3 消费者普查 | 已有：m-review step 3「Census consumers」 |
| 7 追加式决策表 | 已有：m-goal step 4，固定 5 列 `ts / decision / why / evidence / result`，只追加 |
| 8 devex / feature-gate 角度 | 已有：review-template.md 第 4、5 个角度，并有范围规则 |
| 9 每条 finding 带 repro | 已有：m-review step 5 与 review-template 的 `REPRO` 字段 |
| 10 派发前声明选择规则、缺证据记 gap | 已有：m-dispatch step 1（first pass / rank all / best-of）与 step 5（gap，重派一次） |
| 12 不同家族、匿名标签 | 已有：m-verify 的 cross-model 条目写明「different model family」；m-team step 6 用匿名标签 |

未核对：4（双形状设计）、5（状态建模）、6（数字报告规则）、11（能跑出来的问题先跑）。本轮不再重复上一轮的结论。

## 1. 范围

已细读：poteto-mode 主文件（SKILL.md）；playbooks feature、bug-fix、pause-safely、runtime-forensics、eval、hillclimb、prototype、authoring-a-skill、orchestrate、babysit；swarm、arena、babysit、interrogate、thermos 的 SKILL.md；principle-attack-the-premise、principle-never-block-on-the-human、principle-explain-the-number、principle-laziness-protocol；references/grok.md、kimi-tools.md、codex-tools.md；models.json；kimi.plugin.json、hooks/kimi-instructions.md、grok 的 pstack-routing；t3-pstack 的 README、CONTEXT.md、models.json、forks.json、substitutions.json、arena 与 swarm 的 T3 版本。

未细读：playbooks autopilot-full / autopilot-stack / shipping / multi-phase-plan / session-pickup / perf-issue / investigation / refactoring / visual-parity / worktree-cleanup / trace-forensics；statechart 整套；t3-pstack 其余 skill；仓库里的 superpowers-craft.md 未与本文对照。

## 2. 提示与编排技术（按对 mstack 的价值排序）

| # | 技术 | 原文路径（plugins/pstack/skills/ 下） | 做法（释义） | mstack 现状 | 建议落点 |
|---|---|---|---|---|---|
| T1 | 前提攻击的触发条件 | principle-attack-the-premise/SKILL.md | 两个以上共享同一前提的修复都没过同一道门，就写下前提并直接检验，禁止写第三个修复 | m-think 有 premise 字样，m-debug 无触发条件 | m-debug 加一条：同一前提的修复连续失败两次即停下检验前提 |
| T2 | 派发前确认旧 agent 已停 | poteto-mode/SKILL.md「Fresh subagents by default」 | `completed` 只表示完成已通知，不代表进程退出；后台子进程会继续写。先停、再确认停，再接手同一工作树 | 无对应规则（已 grep「confirm stop」无命中） | m-dispatch 加一步：重派同一 worktree 前，用 git status 验证旧 worker 已停 |
| T3 | 不向 idle worker 发消息查进度 | playbooks/orchestrate.md「Topology」 | 发消息会重启空闲 agent。查进度只看 push 与 PR 活动；续作只用于同一件事 | 无 | m-dispatch 或 m-team 的 Claude Code 段加一条 |
| T4 | CI 失败分类与一次重试上限 | playbooks/babysit.md step 7 | 重触发前先分类：flake 或基础设施给一次新构建，不重试 job；同样的失败出现第二次就不是 flake；diff 没碰的代码失败，先用 `git merge-base --is-ancestor` 查是否为过期 base | m-ship/references/ci-and-comments.md 无 flake、merge-base 字样 | m-ship 的 CI 段补这三条 |
| T5 | 循环停止谓词配尝试下限 | playbooks/hillclimb.md step 1、7 | 目标值与最少尝试次数同时满足才停，防止早期侥幸结束；不为达标而放宽谓词 | m-goal 有 checkpoint 与失败计数，无尝试下限 | m-goal 的停止规则加「目标 AND 最少轮次」 |
| T6 | 一次改一个、一次测量、保留或回滚，表格列固定 | playbooks/hillclimb.md step 3、5 | decision.tsv 每轮一行：id、假设、改动、前后值、delta、测试、verdict、note。只追加 | m-goal 已有相近表格，列数相同 | 可选：仅在做性能或指标类循环时启用，不必新增文件 |
| T7 | 先证明测量工具灵敏，再冻结 | playbooks/hillclimb.md step 2 | 对比的工作负载必须能区分；工具输出错误数与工作量计数。不能区分就修 workload，而不是硬跑 | m-verify/references/verify-gates.md 提到 frozen，需核对是否含灵敏度检查 | 核对后决定是否补一条 |
| T8 | 只留运行证明的 finding，并按对抗者列丢弃数 | interrogate/SKILL.md「Verify」「Output」 | 每个对抗者列出被丢弃的 finding 数与原因；同根因合并；「不报风格、命名、未来变更风险」 | m-review 已有 REPRO 与 Unconfirmed/Cleared，但无按 reviewer 的丢弃计数 | m-review 输出加「每个 reviewer 的丢弃数」一行 |
| T9 | 评审门在无独立评审者时保持关闭 | poteto-mode/SKILL.md「Subagents」末段 | 自审、测试、CI 都不算独立裁决。记 `BLOCKED: independent review`，不相关的工作继续 | 已有：m-ship 含 BLOCKED: independent | 无需新增 |
| T10 | 回复中只许引用本次读过的原则，且每条决定点名具体改动 | poteto-mode/SKILL.md「Non-negotiables」首段 | 防止编造原则引用。格式：原则名 + 它改了哪个选择 | mstack 引用原则编号，但无「只引读过的」约束 | m-think、m-plan 的回复模板加一条 |
| T11 | 证据标签与断言同句 | poteto-mode/SKILL.md「Writing the reply」 | 每个断言同句标注 measured / inferred / guess；不给未运行的链接；「不要让人去做你能自己跑的检查」 | m-verify 覆盖证据，但标签不统一 | m-deslop 或 m-verify 的输出规范引用此三标签 |
| T12 | 冷启动可恢复性检查 | playbooks/pause-safely.md step 4、5 | 写交接笔记时，用只读项目目录的人能否答出 N 个指定问题，作为验收。发布前脚本校验链接与文件，再原子更新指针 | m-handoff 有交接文件，无问答式验收 | m-handoff 加「只凭笔记回答 N 个问题」的验收步骤 |
| T13 | 中断时的 `wip:` 提交 | playbooks/pause-safely.md step 3 | 中断时未提交改动做成一个明确的 `wip:` 提交，树坏了写进提交正文一行 | m-verify/verify-gates.md 有 wip 字样 | 可选，已近似覆盖 |
| T14 | 诊断与修复分离 | playbooks/runtime-forensics.md「Reply」 | 只有诊断请求，就只交诊断，不顺手修。收尾交回 Bug fix | m-debug 已有分流 | 无需新增 |
| T15 | 测前写下会改变决策的结果与噪声底线 | principle-explain-the-number/SKILL.md | 测前写下决策阈值与噪声底线，列可能的错测（缓存、跳过、默认配置）并逐一排除 | m-verify 无数字报告规则 | m-verify 的数字条目：附次数、spread、限制因素（与上轮 #6 一致，但这里只补排除清单） |

## 3. 跨模型扇出与模型族路由

**3.1 Claude Code 上的「多样性」只是 Claude 内部的层级。** 主仓库 models.json 的 `panel` 是 `opus / fable / sonnet / haiku`，arena、architect、interrogate 的「不同家族」指 Claude 不同层级。judge 的「非父模型家族」在主仓库里仍是 Claude 之内的换层。这点不要误读为跨厂商。

**3.2 t3-pstack 把 panel 改成跨厂商，并把它写成不变式。** 其 models.json 的 panel 为 `claudeAgent/claude-opus-5-5 effort=xhigh`、`codex/gpt-6.1-sol reasoningEffort=xhigh`、`grok/grok-4.7 reasoningEffort=xhigh`。CONTEXT.md 定义：panel 必须跨至少两个族，族取模型 ID 最后一段 `/` 之前的第一段。judge 选择的规则（arena SKILL，T3 版）：只从其他族取；其中先选「已跑候选数较少」的模型，同数则按池序。这是可直接借的细节，主仓库没有。

**3.3 按 tier 路由，而非按家族硬编码。** 主仓库 models.json 把 `bug-fix`、`perf-issue`、`hillclimb` 放在 `default`（opus）；t3 把它们放在 `strongest`（fable）。这是一个真实的取舍点：t3 把高风险循环升到最强层，主仓库不升。mstack 的 m-review 已按 diff 规模与是否涉及 auth、crypto、destructive 分层（review-template.md 的 tier 表），可保留。

**3.4 Effort 与 model 分开调。** poteto-mode/SKILL「Subagents」：按任务难度上下调一档（最难 raise、常规 lower 两档以上）；验证环节固定在 swarm workers 的模型与 effort 上。固定模型只改 effort，是为了让 panel 保持多样。

**3.5 slug 被拒与容量错误要分开处理。** codex-tools.md 第 33 行：线程上限报错是容量错误，不是 slug 被拒，不能换模型兜底，应停止再派。slug 被拒才用同族最近的合法 slug，且绝不再传已被拒的 slug。

**3.6 effort 从运行时读，不猜。** codex-tools.md 第 41–43 行：`codex-session-effort.mjs` 从当前 turn 的运行日志读 effort；读不到就要求调用方给出显式级别，不得用模型默认值或上一轮值代替。

**3.7 每个宿主的模型表是独立文件。** grok.md、kimi-tools.md、codex-tools.md 各含「Claude 动作 → 宿主动作」表和「模型名」段。grok.md 明确写：spawn_subagent 没有 effort 参数，无法套用 sheet 时「报告限制，不要声称有模型多样性」。kimi-tools.md 同样写 Kimi 没有逐次 effort 参数，panel 缺多样性时要报告。这条诚实规则可直接搬到 mstack 的 DSH 与 Codex 路径。

**3.8 Pi、Muse 的 slug 映射。** models.json 的 `pi` 段按提供方分三组（anthropic、openai、openai-codex）写同一角色的不同 slug，`fallback` 指定缺省提供方。`muse` 段是 default `muse-wonder-1.0`、strongest `muse-wonder-full-1.0`、worker `muse-spark-1.3`、panel 三者。两者都说明：角色名稳定，slug 按宿主替换。

**3.9 t3 的 option 键因提供方而异。** t3 的 sheet 里 Claude 写 `effort=xhigh`，Codex 与 Grok 写 `reasoningEffort=xhigh`，并要求从 `orchestrator_capabilities` 取键名。mstack 若接多家，应同样把键名从宿主能力表取，而不是写死。

**3.10 Grok 的专属注意点。** 主仓库 models.json 没有 grok 槽位，Grok 只通过 `grok/pstack-routing/SKILL.md` 和 grok.md 接入。routing skill 自己声明是「模型遵循的提示，不保证注入」。t3 的 substitutions.json 里残留了一条 `grok-4.7-xhigh-fast` 作为 swarm workers 默认值的旧表述，被替换为 claude；说明 Cursor 时期的默认值是 Grok。

## 4. 多宿主打包（t3-pstack 的工程做法）

- **substitutions.json**：上游每句话一条规则（pattern 或 regex、replacement、rationale、files）。生成时改写，而不是手改副本。
- **forks.json**：保留自己形式的文件，每个写明 reason 与 `upstream: "not-proposed"`，kind 分为 policy 等。上游改动这些文件要由人决定。
- **frozen-hooks.json**：Codex 按 hook 条目的哈希信任 hook，改动会让 hook 在所有 Codex home 失效，直到重装。hook 文本与路由文本则可自由改。
- **sync.mjs** 在上游同步时失败于：未声明的 fork、禁用词、已不再匹配上游的规则。CI 跑 `generate --check`，过期副本直接红。
- **模型表单一来源**：models.json 是唯一来源，generate 把它盖进各 SKILL.md 的 Models 段。主仓库同样做法。

对 mstack 的意义：mstack 当前同时面向 Claude Code、Codex、DSH，靠的是各 skill 里的 `Other runtimes` 小段与 `harness-commands.md`，没有统一的 substitution 或 fork 注册表。若要加宿主，可以先做两件事：一个只读检查脚本，列出 skills 里出现的 Claude 专有工具名（Agent、TaskCreate、AskUserQuestion）而宿主段未覆盖的位置；以及把各宿主模型表集中到一个 models.json 再生成。

## 5. mstack 采纳建议（按优先级）

1. **m-dispatch：T2 + T3。** 重派前用 git status 确认旧 worker 已停；不向 idle worker 发消息查进度；kickoff 写明证据与可写路径。
2. **m-ship：T4。** CI 段补 flake 分类、一次重试上限、merge-base 过期 base 检查。
3. **m-debug：T1。** 同一前提的修复连续失败两次即停，先写下并检验前提。这与 CLAUDE.md 的「同一错误三次即停」互补：前者针对假设，后者针对现象。
4. **m-goal：T5。** 停止谓词加最少轮次，防止早停。
5. **m-handoff：T12。** 交接验收改为「只凭笔记答出 N 个问题」。
6. **m-think、m-plan：T10。** 回复里原则引用只许引读过的，且每条点名改了什么。

可选：T6、T7（先核对 verify-gates.md）、T8、T11。

## 6. 不建议照搬

- arena、architect、interrogate 的完整 panel 矩阵：FRAMEWORK §2 已排除，且主仓库的 panel 只是 Claude 内部层级，收益有限。
- eval 的完整盲化协议（禁用词表、候选不知道其他候选、transcript 取证）：只在做 skill A/B 评测时才用得上，现阶段不引入。
- t3 的 policy fork 与 frozen-hooks 机制：只对多宿主分发有价值，单机 mstack 过重。
- orchestrate 的三层拓扑（你、sub-coordinator、worker）：mstack 的 m-team 已有轮次结构，不需要再叠一层。

## 7. 验证与风险

- 方法：只读。所有结论来自 `gh api` 取回的原文，以及对 E:\mstack\skills 的 grep 与 sed 读取。没有运行任何脚本，也没有测试任何技术。
- 所有「mstack 现状」判断基于关键词命中与局部阅读，可能漏掉同义表述。T4 与 T7 尤其需要打开文件确认后再动手。
- 引文均为释义，原文引用不超过两行。
- 时间戳：t3-pstack 的仓库 pushed_at 为 2026-11-07T07:12Z，晚于今天（2026-11-06）。这说明时钟或缓存有偏差，不影响本文结论，但引用它的版本号时要再核对。
- 模型 slug（gpt-6.1-sol、grok-4.7、muse-*）取自仓库文件，会随发布变化，不应直接写进 mstack。
