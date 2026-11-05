# mstack acceptance review — 2026-11-04

独立验收。范围：FRAMEWORK.md、README.md、docs/*.md、16 个 skills/*/SKILL.md、全部 skills/*/references/、对照 .sources/（含 .sources/orca/*）。`node scripts/check.mjs` 通过（exit 0），但下列缺陷 check.mjs 覆盖不到。

## Findings（按严重度排序）

### 1. [high] m-guard 的目录冻结承诺"范围外 block"但没有实现机制，且 `/unfreeze` 命令不存在
- **位置**: skills/m-guard/SKILL.md:23（DSH 注记在 :38 自认"目录冻结用自觉"）
- **问题**: 来源 gstack/freeze（.sources/gstack/freeze.md）靠 PreToolUse hook + `check-freeze.sh` 脚本实现阻断，`/unfreeze` 是 gstack 插件提供的 slash 命令。mstack 两者都没收：SKILL.md 没给任何 hook/脚本/设置写法，却让 agent 承诺"范围外 block（不是 warn）"；解除方式写"`/unfreeze` 或换会话"，而 docs/migration.md:33 明确 gstack 未安装，mstack 自己也没有这个命令。
- **失败场景**: 用户说"冻结 src/"，agent 答应并宣称 block 生效；随后一次 src/ 之外的 Edit 直接成功——护栏从未存在，用户却以为有。会话末尾执行 `/unfreeze` 得到 unknown command。

### 2. [medium] closeout 职责重叠：m-handoff 与 m-goal 在同一触发点都认领写 closeout
- **位置**: skills/m-handoff/SKILL.md:13 vs skills/m-goal/SKILL.md:13,42 与 FRAMEWORK.md:147（"closeout 仍由 m-goal 写"）
- **问题**: m-handoff 把"at the end of any `m-goal` cycle (closeout)"列为自己的 Use 场景；m-goal 则规定 closeout 由自己在每条退出路径强制写，且 §9.1 明确 m-team 返回后 closeout 归 m-goal。两个 skill 认领同一件事。
- **失败场景**: goal 结束时 mstack 路由同时命中两者，或先后执行：m-goal 写了 `.mstack/goals/<slug>-closeout.md`，m-handoff 又把"closeout"覆盖写进 `.mstack/handoff.md`（旧档进 archive），两份记录随时间漂移、互相矛盾。

### 3. [medium] m-learn ↔ m-handoff 移交环路：事实型知识被 A 推给 B、B 推回 A
- **位置**: skills/m-learn/SKILL.md:17（"事实型、需要检索的知识 → 转 `m-handoff` 或直接写 memory"）vs skills/m-handoff/SKILL.md:15（"The handoff is the *current-state* record, not a knowledge base"，durable memory → `m-learn`）
- **问题**: m-learn 把"需要检索的事实"路由给 m-handoff；m-handoff 明确声明自己不是知识库、把持久知识路由回 m-learn。对"事实型知识"这一类条目构成 A→B→A 循环。
- **失败场景**: 复盘出一条"magpie 每 15s 重写 cordis.patch.yml"式事实：照 m-learn 转给 m-handoff，照 m-handoff 的 not-use 又转回 m-learn，最终谁也不写，教训丢失（违反原则 10）。

### 4. [medium] m-goal 的 closeout 落点与 FRAMEWORK §4 布局矛盾，且自身表述含糊
- **位置**: skills/m-goal/SKILL.md:28（"its closeout section/file `.mstack/goals/<slug>-closeout.md`"）、:32 vs FRAMEWORK.md:83（`goals/<slug>.md` = "m-goal 的目标、检查点、closeout"）；m-goal:17 又要求在 goal 文件内放 "closeout placeholder"
- **问题**: §4 规定 closeout 在 goal 文件内；m-goal 发明了布局里不存在的第二个文件 `<slug>-closeout.md`，且 "section/file" 二选一没有判定标准。
- **失败场景**: 第一次跑写进独立文件，第二次（换个 agent/模型）照 §4 写进 goal 文件；`mstack` 恢复时只读 `.mstack/goals/<slug>.md`（skills/mstack/SKILL.md:17），看不到独立文件里的 closeout，把已完成的目标当成未完成重做。

### 5. [medium] m-handoff 引用了 m-learn 里不存在的 "reflect path"
- **位置**: skills/m-handoff/SKILL.md:29（"recent transcripts (`m-learn`'s reflect path, …)"）
- **问题**: m-learn 全文没有任何 "reflect path" 或读 transcript 的步骤；相反 m-learn:23 规定"只复盘当前会话，不跨到别的项目目录去翻 transcript"。pstack/reflect 只是来源，没有被改写进 m-learn 正文。
- **失败场景**: handoff 缺失时 agent 照此指示去找 m-learn 的 reflect 流程，找不到对应步骤，只能瞎猜或放弃重建 brief。

### 6. [medium] m-guard 的 `--dump-config` 没有主命令、不可执行；cordis.patch.yml 也是 DSH 专有
- **位置**: skills/m-guard/SKILL.md:26（裸 `--dump-config`）、:25（`cordis.patch.yml`）
- **问题**: 来源 .sources/dsh/plugin-intake.md:14 的原文是 `dsh --profile <p> --dump-config`，是 DSH 专有 flag。m-guard 把主命令丢掉、写成裸 flag，且把这一步用作"装新插件/skill 前"的通用冲突体检——包括 Claude Code 插件场景，那里没有 `dsh`、也没有 `cordis.patch.yml`。
- **失败场景**: 用户要在 Claude Code 里装某插件，agent 执行 `--dump-config` → shell 报 command not found；或满仓库找一个不存在的 cordis.patch.yml，体检步骤卡死。

### 7. [medium] references/subtask-prompt-template.md 是孤儿文件，SKILL.md 从未让读者读它
- **位置**: skills/m-dispatch/references/subtask-prompt-template.md（存在）；skills/m-dispatch/SKILL.md 全文只引用了 `references/harness-commands.md`
- **问题**: FRAMEWORK.md:47（§3）要求"SKILL.md 里写明何时读哪个"reference。该模板（GOAL/SCOPE/CONTEXT/VERIFY/RETURN 合同）是 m-dispatch 步骤 1/3 的核心交付物规范，却没有任何入口指向它；check.mjs 不检查此项，验收仍通过。
- **失败场景**: 执行 m-dispatch 的 agent 只读 SKILL.md，自己发明子任务 prompt 格式，漏掉 VERIFY/RETURN 合同；子 agent 回报"done"而无证据，主会话无法按步骤 4/5 验收。

### 8. [low] m-verify 的刹车阈值（2 次/5 runs）与原则 9（3 次）不一致
- **位置**: skills/m-verify/SKILL.md:31 vs FRAMEWORK.md:97（原则 9）、skills/m-guard/SKILL.md:24、skills/m-goal/SKILL.md:46（均为"同一错误 3 次 → 停"）
- **问题**: 同一类"反复失败就停"的规则出现两个阈值。验证一个顽固 red 时，按 m-verify 第 2 次失败就停并转 m-debug，按全框架原则还可再试一次——agent 行为取决于恰好加载了哪份文件。
- **失败场景**: 修复后第二次验证失败即被转去 m-debug 走完整根因流程，实际只差一次重跑；或反过来，读过原则 9 的 agent 无视 m-verify 的 5-run 上限。

### 9. [low] m-qa 的报告落点与 §4 布局冲突
- **位置**: skills/m-qa/SKILL.md:31（"`.mstack/reviews/` or a repo `qa-reports/` dir"）vs FRAMEWORK.md:85（`.mstack/reviews/<date>-<slug>.md` 是 "m-review 汇总"）
- **问题**: §4 把 `.mstack/reviews/` 划给 m-review，且文件名约定 `<date>-<slug>.md`；m-qa 既不遵循该命名，又额外发明布局外的 `qa-reports/`。
- **失败场景**: 同一目录混进两类不同格式的报告，按 `<date>-<slug>` 检索 review 结果时捞到 QA 报告；或报告散落到 repo 目录被误提交。

### 10. [low] FRAMEWORK.md 内部计数漂移：§1/§2 仍写 "15 个 skill"
- **位置**: FRAMEWORK.md:3、:13、:19（§2 标题及映射表只列 15 行，无 m-team）vs FRAMEWORK.md:131（§8 验收要 16 个）、§9
- **问题**: §9 增补 m-team 后 §1/§2 未更新。§2 自称"15 个 skill 与来源映射"且是"给构建 agent 的唯一依据"。
- **失败场景**: 后续维护者照 §2 表核对 skill 全集，得出 15 个、认为 m-team 是多余目录而误删；或按"互不重叠的 15 个"排查重叠时漏查 m-team。

### 11. [low] Orca `worktree create` 丢了 `--no-parent`，与来源用法分歧
- **位置**: skills/m-dispatch/references/harness-commands.md（Orca 小节末）与 FRAMEWORK.md:168 vs .sources/orca/orca-cli.md:38,41 和 .sources/orca/orchestration.md:43（均为 `--no-parent`，并说明独立交接要用它，否则形成 stacked 父子 lineage）
- **问题**: 该命令的用途是"交出去不需要回报、留给人继续用"的独立活，来源明确要求 `--no-parent`；mstack 两处都省略了。
- **失败场景**: 交接的 worktree 被挂到当前 worktree 门下（stacked），后续 `worktree set`、清理、基于哪个分支派生的行为都与预期不符，人类接手时看到错误的分支基。

### 12. [low] m-deslop 的 DSH 注记是一句病句，无法照做
- **位置**: skills/m-deslop/SKILL.md:53（"DSH：无差异工具差异，用 bash 跑同套验证命令"）
- **问题**: "无差异工具差异"自相矛盾、语义不存，推测原意是"无工具差异"。属写作错误而非风格问题——读者无法确定 DSH 下到底有没有差异。
- **失败场景**: DSH 下的 agent 无法判断该行是"无差异"还是"有差异"，只能忽略 Harness notes。

### 13. [low] mstack 恢复时找 `.mstack/plans/<slug>.md`，与实际文件名 `<YYYY-MM-DD>-<slug>.md` 不符
- **位置**: skills/mstack/SKILL.md:17 vs FRAMEWORK.md:82、skills/m-plan/SKILL.md:28
- **问题**: 计划文件带日期前缀，mstack 步骤 1 的 glob 写的是 `<slug>.md`。逐字执行的 agent 会漏匹配。
- **失败场景**: "继续"时 mstack 找不到已存在的计划文件，判定无在途工作，从头重开 m-think/m-plan。

### 14. [low] .sources/orca/ 里混入一个 OMC 会话状态垃圾文件，source-map 的"全覆盖"声明不成立
- **位置**: .sources/orca/.omc/state/sessions/d8b88986-730e-5c2f-a90a-833166ec69e0/pre-tool-advisory-throttle.json vs docs/source-map.md:5（"`.sources/` 下 97 个来源文件全部被覆盖"）、FRAMEWORK.md:134（§8 要求覆盖每一个文件）
- **问题**: .sources 下实际有 98 个文件；多出的这一个不是来源文档，是上游机器的 OMC 会话状态残留，未被 source-map 覆盖、也不该作为"来源"存在。
- **失败场景**: 任何人照 source-map 复核 .sources 覆盖率时发现一个对不上的文件；更糟的是把别人的会话状态文件当作 Orca 资料引用。

## 各类检查小结

1. **交叉引用**: 所有 `m-xxx` 名字均存在（16 个 skill 目录齐全）；references 文件全部存在，但 1 个孤儿（finding 7）、1 个指向不存在流程（finding 5）、1 个路径模式不符（finding 13）。
2. **边界**: 发现一处职责重叠（finding 2）和一处移交环路（finding 3）。
3. **矛盾**: finding 4（closeout 落点 vs §4）、8（刹车阈值 vs 原则 9）、9（报告目录 vs §4）、10（15 vs 16）。
4. **不可照做步骤**: finding 1（/unfreeze、无机制的 block）、6（裸 --dump-config）、11（Orca 缺 --no-parent）、12（病句）。DSH headless 命令（`dsh --profile mola-cli --patch …`、magpie `group/smart-split`、`--json`）与 FRAMEWORK §6 及 .sources 一致，未见虚构 flag。
5. **文档漂移**: README（16 个 skill、marketplace 安装命令、验证命令、仓库结构）与 migration.md、CHANGELOG.md 所述均与仓库现状一致，未发现矛盾；漂移集中在 FRAMEWORK.md 自身（finding 10）和 .sources 残留（finding 14）。

备注：`node scripts/check.mjs` 通过；本评审未运行 git、未修改除本文件外的任何文件。

## Resolution

findings 1–13 已修（14 略：只涉及被忽略目录）。每条一行，格式 `file:line — 改了什么`。

1. skills/m-guard/SKILL.md:23 — 目录冻结不再承诺"范围外 block"：改成 agent 自己约束 Edit/Write，除非用户装了 PreToolUse hook 才硬拦截；删掉 `/unfreeze`，解除方式改为"告诉 agent 或开新会话"（同文件 :31 Output 加"靠自觉、非硬拦截"，:42–43 Harness notes 同步）。
2. skills/m-handoff/SKILL.md:13 — m-handoff 的 Use 场景去掉 "at the end of any `m-goal` cycle (closeout)"；:15 明确 closeout 归 m-goal、handoff 只链接；:22 存档时只写 goal 文件 `## Closeout` 的链接（"the handoff never writes the closeout itself"）。
3. skills/m-learn/SKILL.md:17 — 删掉"事实型知识 → 转 `m-handoff`"；改成直接写 memory（无 memory MCP 时落 lesson 或项目内文件），并说明 handoff 只存当前状态（断掉 m-learn → m-handoff → m-learn 环路）。
4. skills/m-goal/SKILL.md:17 — goal 文件里放空的 `## Closeout` 段占位（不再写含糊的 "closeout placeholder"）；:22、:28、:32 明确 closeout 是同一个 `.mstack/goals/<slug>.md` 里的 `## Closeout` 段，不再有独立的 `<slug>-closeout.md`；:9、:4 同步措辞。
5. skills/m-handoff/SKILL.md:29 — 删掉 "(`m-learn`'s reflect path, …)"，恢复步骤只说 `git log` / `git status` + harness 的 transcript 目录。
6. skills/m-guard/SKILL.md:26 — 裸 `--dump-config` 改成完整的 `dsh --profile <p> --dump-config`（标明 DSH 专有），Claude Code 场景改用 `claude plugin details <plugin>`（真实子命令，列该插件的 skills/agents/hooks/MCP 清单）或 `claude plugin list`；:25 的 `cordis.patch.yml` 标注"DSH 才有"。
7. skills/m-dispatch/SKILL.md:22 — 步骤 1（写子任务 prompt 处）指向 `references/subtask-prompt-template.md`（GOAL / SCOPE / CONTEXT / VERIFY / RETURN）；:26 步骤 3 再提一次，并说 RETURN 段就是回报合同。
8. skills/m-verify/SKILL.md:31 — 删掉"2 次 / 5 runs"阈值，改用原则 9 的 3 次规则：同一错误连错 3 次就停、换假设并转 `m-debug`。
9. skills/m-qa/SKILL.md:31 — 报告落点改成 `.mstack/qa/<YYYY-MM-DD>-<slug>.md`（不再用 `.mstack/reviews/`，也不发明 `qa-reports/`）；FRAMEWORK.md:87 — §4 状态目录布局补上 `qa/<YYYY-MM-DD>-<slug>.md` 一行。
10. FRAMEWORK.md:3、:13、:19、:125 — §1/§2 的 "15 个 skill" 全改成 16 个；:40 — §2 映射表加第 16 行 `m-team`（合并自指向 §9）。
11. skills/m-dispatch/references/harness-commands.md:53 — orca `worktree create` 加上 `--no-parent`；:56 — 补一句说明（独立交接用，别做成 stacked）；FRAMEWORK.md:170 — §9.2 同一条命令同步加 `--no-parent`。
12. skills/m-deslop/SKILL.md:53 — 病句"无差异工具差异"改成"工具无差异，用 bash 跑同套验证命令"。
13. skills/m-start/SKILL.md:17 — 恢复时的 glob 从 `.mstack/plans/<slug>.md` 改成 `.mstack/plans/*-<slug>.md`，并注明计划文件带 `<YYYY-MM-DD>-` 前缀（对应 FRAMEWORK.md:83 / skills/m-plan/SKILL.md:25）。

附带：FRAMEWORK.md:175 — §9.3 里残留的 `skills/mstack/SKILL.md` 路径改成 `skills/m-start/SKILL.md`（§10 改名后的陈旧引用）。

验证：`node scripts/check.mjs` → `OK: 16 skills pass all checks`（exit 0）。
