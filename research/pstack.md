# pstack 对照研究：mstack 可借鉴的实践

日期：2026-11-06。只读调研，未改 E:\mstack 下任何其他文件。

## 来源与覆盖范围

- 主来源：`michael-denyer/pstack-claude` 的 `plugins/pstack/skills/*`（仓库 2026-11-06 13:28Z 推送）。逐篇读过：create-verification-skill、maintain-verification-skill、create-formal-verification-skill、statechart、show-me-your-work、arena、architect、blast-radius、thermo-nuclear-review、swarm、interrogate、sharpen、tdd、benchmark-checklist、principle-prove-it-works、principle-test-behavior-not-implementation、principle-exhaust-the-design-space、principle-explain-the-number、principle-model-the-domain、poteto-mode 主文件及 playbooks eval、hillclimb、prototype。
- 只获取未细读：maintain-formal-verification-skill、playbooks feature / bug-fix / pause-safely / runtime-forensics。
- `backnotprop/pstack`（17:03Z）与 `ericlitman/open-pstack`（18:37Z）只核对了文件树：技能名与主仓库一致，open-pstack 另含 `.claude/skills/verify-open-pstack/SKILL.md`（项目内生成的验证 skill 实例）。未逐文件读。
- `E:\mstack\.sources\pstack\` 是旧版，不含 create-verification-skill、statechart、arena，因此以线上版为准。
- FRAMEWORK §2 明确不收 arena、statechart、formal-verification 系列。本表是对这一排除的复审，只提"能吸收的做法"，不建议整体引入。

## 对照表

| practice | how pstack does it (path) | gap in mstack (which m-skill) | proposed change (concrete) | priority |
|---|---|---|---|---|
| 1. 项目专属验证 skill：生成并维护 | `plugins/pstack/skills/create-verification-skill/SKILL.md` 生成 `.claude/skills/verify/`，固定章节 Launch / Doctor / Drive / Evidence / Cleanup，并建 `features/` 功能地图；§4 要求端到端跑一遍，清理后校验证据仍在。`maintain-verification-skill/SKILL.md` 定期审计，结果只许 clean / changed / blocked，且编辑范围限于验证 skill 自己的目录。 | m-qa 每次现写 Playwright 流程，报告写完即弃：没有可复用驱动，没有 doctor 检查，没有清理契约，没有功能地图（m-qa/SKILL.md 与 references/qa-checklist.md 均无）。m-verify 只说"跑仓库自己的检查命令"。 | m-qa 增加"首次生成项目验证 skill"步骤，产物在项目 `.claude/skills/verify/`（含 Doctor 与 Cleanup，清理后校验证据仍在）。m-verify 的 Harness notes 指向它，存在则优先用。m-qa 报告结论改为 clean / changed / blocked 三选一。 | High |
| 2. 验证器必须先见过失败 | `plugins/pstack/skills/tdd/SKILL.md` 步骤 3-4：先写失败测试并跑出失败内容。`create-formal-verification-skill/SKILL.md`："Able to fail"，在故意破坏的代码变体上看到性质失败。`create-verification-skill` §4："从未执行过的生成 skill 只是草稿"。 | m-debug/SKILL.md 的 Harness notes 写 "write the failing test first (see m-verify)"，但 m-verify/SKILL.md 全文没有这一步，引用悬空。m-verify 已有"引用失败断言 diff"的规则，但不要求新检查先红。 | m-verify 增加一条：新增或修改的检查，先在破坏版本上跑出预期失败，并引用失败内容；新生成的验证 skill 必须执行一次才能交付。修正 m-debug 的引用，使其指向 m-verify 中真实存在的段落。 | High（修引用成本低） |
| 3. 爆炸半径：消费者普查 + 证明"唯一安全事实" | `plugins/pstack/skills/blast-radius/SKILL.md`：先找"变更安全依赖的那一个事实"，按五级证据强度（口头 / file:line / 推演 / 运行脚本 / 复现）逐级证明；要求可运行脚本调用真实库；brief 中关于现有代码的断言先当假设，用消费者普查检验。 | m-review/SKILL.md 的五个角度（correctness / concurrency / API / tests / security）只看 diff。没有 diff 之外的调用方普查，没有"证明依赖事实"的步骤。step 3 只要求复现 finding，不要求找 diff 外的消费者。 | m-review 在 step 1 与 step 2 之间加"消费者普查"：列出改动的导出符号、协议、数据格式在 diff 外的调用方（grep 加跨包），并要求一条能跑的证明脚本。review-template.md 增加第 6 个角度 downstream consumers。 | High（LayerFS、CAD2GIS 多包依赖直接受益） |
| 4. 竞争性设计：design twice | `plugins/pstack/skills/architect/SKILL.md` Phase B：至少两个结构上不同的候选（整体形状，而非局部补丁），经 arena 流程（独立 worktree、交叉评审、选 base、嫁接），再用 `references/design-red-flags.md` 筛。`arena/SKILL.md` 的 cross-judge 要求来自另一模型家族。 | m-plan/SKILL.md 只产出单一计划，交独立 critic 检查。m-think/SKILL.md 只做前提攻击并写一份 spec，没有"必须两种形状"的规则。 | 不引入完整 arena。在 m-plan step 2 之前加一条：涉及新模块边界或公开类型时，先写 ≥2 个结构不同的形状（每个只给接口草图，≤15 行），由 critic 选定，选择理由写入计划的 Review Focus 段。 | Medium |
| 5. 状态建模先于编码 | `plugins/pstack/skills/statechart/SKILL.md`：把每条规则写成 INVARIANT，用 TLC 跑，输出最短路径与状态图。`create-formal-verification-skill`："Findings stay findings"，不为通过而削弱模型；每个检查绑定到具体代码与提交。`principle-model-the-domain/SKILL.md`：先选数据结构再写分支。 | FRAMEWORK §4 的 10 条核心原则里没有状态建模。m-plan 与 m-verify 对有状态、并发逻辑（LayerFS 锁与 watch、重试、状态机）没有"先列状态与转移再写码"的步骤。 | 不引入 TLA+ 整套（先减后加）。m-plan 对有状态或并发任务增加必填小节"状态与不变量"：列状态、转移、3-5 条不变量，每条注明由哪个测试检查。只有不变量与竞态相关时，才建议可选的 TLC 模型。 | Medium（LayerFS 相关，其他场景低） |
| 6. 测量数字要解释（explain the number） | `plugins/pstack/skills/principle-explain-the-number/SKILL.md`：测前写下会改变决策的结果与噪声底线；列出可能的错测（缓存、跳过、默认配置）并逐一排除；附 run 次数与离散度。`benchmark-checklist/SKILL.md` 作执行清单。`playbooks/hillclimb.md`：一次只改一个东西、一次测量、保留或回滚，harness 冻结后不改。 | m-verify 与 m-goal 没有数字报告规则。m-team/SKILL.md 讲 metric 与 gate，但没有噪声底线与 run 次数要求。m-goal 的 checkpoint 允许只写一行 evidence。 | m-verify 的 Output 增加"数字"条目：任何性能或准确率数字必须附 run 次数、spread、限制因素。m-team 每轮 metric 报告同样适用。m-verify 增加"一次只改一个变量"的引用。 | Medium |
| 7. 追加式决策轨迹与审计 | `plugins/pstack/skills/show-me-your-work/SKILL.md`：TSV，每个决策一行（ts / phase / decision / why / evidence / result），只追加，错误用新行 supersede；收尾时对照 transcript 审计；由另一模型家族输出 "Attention" 段。 | m-goal/SKILL.md 只要求在 goal 文件里追加 checkpoint 行，没有固定字段，没有"只追加"约束，没有审计与 Attention 段。m-dispatch 没有决策日志。 | 不新增工具。m-goal 的 checkpoint 固定为 5 列（ts / decision / why / evidence / result），规定追加式。closeout 增加 "Attention" 段，由跨模型 subagent 填写，允许写"无"。 | Medium-Low |
| 8. review 范围规则与 devex / feature-gate 角度 | `plugins/pstack/skills/thermo-nuclear-review/SKILL.md`：只报告新增或修改代码（"ONLY report issues related to code that is being ADDED or MODIFIED"）；devex 破坏（环境变量、端口、新增必跑脚本）与 feature gate 泄漏各为独立角度；作者有意破坏且范围明确时不报；有过度报告约束。 | m-review/references/review-template.md 的五个角度没有 devex 与 feature-gate（已 grep "devex"、"feature flag" 无命中）。m-review/SKILL.md 没有"只报 diff 内问题"与"有意破坏不报"的规则，容易把旧代码的问题混进报告。 | review-template.md 增加 devex 与 feature-gate 两个角度（仅在改动涉及时启用）。m-review 增加两条范围规则：只报 diff 内；有意破坏且范围明确的，归入 cleared 并注明。 | Medium |
| 9. 每条 finding 带可运行证据（对抗式证明） | `plugins/pstack/skills/interrogate/SKILL.md`：对抗者每条 finding 给出命令、实际输出、应有输出；只有运行证明的才存活；报告每个对抗者的丢弃数与原因；同根因合并。 | m-review/SKILL.md step 3 要求"重新核对代码、复现路径"，但不要求把命令和输出写进报告，也不记录丢弃数。 | m-review 的 finding 格式增加 `repro: <command> -> <实际输出>` 字段。没有 repro 的归入"未证实"，不计入结论。 | Medium |
| 10. swarm：先声明选择规则；缺证据记为缺口 | `plugins/pstack/skills/swarm/SKILL.md`：Phase A 启动前声明 first pass / rank all / best-of；Phase C 删除未按 brief 记录 SHA 与方法的结果并重派一次，第二次仍缺则记为 gap，"gap 不算 pass"。 | m-dispatch/SKILL.md step 4 写"分歧由你决定"，没有事先声明的选择规则。RETURN 合约没有规定缺证据时怎么办。 | m-dispatch step 1 要求每次分派写明选择规则。RETURN 合约缺证据即标 gap 并重派一次，第二次仍缺不计 pass。 | Medium |
| 11. 能跑出来的问题不问人（prototype before asking） | `plugins/pstack/skills/poteto-mode/SKILL.md` 非负项：在"哪种方案"的岔路上问用户前，若答案可通过运行得到，先用 `playbooks/prototype.md` 做一次性原型，让结果决定。`principle-exhaust-the-design-space`：2-3 个竞争原型并排比较。 | m-think/SKILL.md 的规则是"最多 3 个问题，每个带默认值"，没有"可运行的问题先跑再问"的分流。 | m-think step 4 增加分流：能用不超过 30 分钟的运行回答的问题，先做原型，不占用提问额度。 | Low |
| 12. 盲评与评审者家族 | `plugins/pstack/skills/poteto-mode/playbooks/eval.md`：候选看不到"评测"类字样；judge 只看匿名标签，与作者不同家族；从 transcript 核对候选是否真的打开了该读的文件。 | m-verify 的 cross-model 条目要求"另一模型"，但没定义"不同家族"，也没有盲化与 transcript 核对。m-team 有 held-out 集，但评分没有盲化规则。 | m-verify 的 cross-model 条目改为"不同家族"，引用 m-review 中的同一定义。m-team 的 scoring 增加"评审只见匿名标签"。 | Low |

## Top recommendations

1. 先做两处小修：m-debug 指向 m-verify 的悬空引用（行 2）；m-verify 增加"新检查先红"（行 2）。两者都是几行文字的改动。
2. 给 m-review 加三件事：diff 之外的消费者普查与证明脚本（行 3）、devex 与 feature-gate 角度加范围规则（行 8）、每条 finding 的 repro 字段（行 9）。这是对 mstack 最直接的缺口。
3. 最大增量是 m-qa 生成并维护项目验证 skill（行 1）。应单独立项，不要把它塞进现有的 report-only 流程。
4. 在 m-plan 与 m-verify 里加可选小节（双形状设计、状态与不变量、数字报告规则），吸收 arena、statechart 的做法，但不引入其工具链。是否推翻 FRAMEWORK §2 的排除，由 owner 决定。

## 未做与风险

- 未运行任何 pstack 脚本或测试；所有结论来自读取 SKILL.md 与 playbook 原文。
- 未读 maintain-formal-verification-skill 与四个未细读的 playbook，相关结论可能遗漏细节。
- backnotprop 与 open-pstack 只核对文件树，未核对内容是否有更新做法。
- 行 5 与行 12 的收益依赖 Mola 的项目类型（LayerFS 并发、多 agent 评测）。若主要做 UI 与文档站点，优先级应降低。
