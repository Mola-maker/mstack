---
name: m-deslop
description: 删掉 AI 味和冗余——多余注释、死代码、无谓抽象、套话堆砌，先保护行为再减。Use when the user says "deslop / 去AI味 / 删冗余 / 这段太啰嗦 / 精简一下", or a diff feels bloated.
whenToUse: Remove AI-generated slop and redundancy from code or prose while preserving behavior: dead code, needless abstraction, defensive cruft, filler phrasing, and AI vocabulary.
---

# m-deslop — 删 AI 味与冗余

把"能跑但臃肿"的代码和"能读但有 AI 腔"的文字压到最短、最直白的形态，同时不改变行为。贯穿的原则是"先减后加"（原则 2）：先删，删到不能再删，才考虑改。这一 skill 同时管两个面：代码清爽（code slop）和文字清爽（prose slop）。

## When to use / not use

**用**：diff 相对 base 出现多余注释、`any` 绕过类型、无谓 try/catch、深嵌套；文中出现肤浅 -ing 短语、模糊出处、AI 词表、规则三连、感叹套话。

**不用，转给别的 m-skill**：
- 主要是加新功能、改产品行为 → 转 `m-plan` / `m-think`，这不是清理。
- 想要大范围重设计而非增量清理 → 转 `m-think` 先出方案。
- 行为本身有 bug 且不确定 → 先 `m-debug` 找根因，别在没搞清意图前删。
- 是文档/报告内容的精简而非代码 → 仍是本 skill 的 prose 面，但要区分目标读者（给人看 vs 给 agent 看）。

## Procedure

**代码面（先护行为）：**
1. 先读现有测试或跑一次基线，锁定当前行为；能补最小回归测试就先补（测行为，见 m-verify）。
2. 写一份清理清单，只列要删的味，不借机重构无关部分；从最安全的删（死代码）到较险的合并（去重复）。
3. 分类再动：**死代码**（未用导出、永不执行分支、调试残留）→ **重复**（copy-paste 分支、重复 helper）→ **无谓抽象**（透传 wrapper、一次性 helper 层、投机泛化）→ **命名/错误处理**。
4. 一次一个味、一次一个 pass；每个 pass 后重跑验证。不用新依赖，优先复用已有 helper；标准库 → 平台能力 → 已装依赖 → 才手写。
5. 收尾：跑 lint / typecheck / 相关测试，绿了才报完成；每个删改都能说出"行为没变，删掉了什么"。

**文字面（保意义）：**
6. 保词不改（字节级）：代码、命令、路径、报错、数字、单位、否定词（not/never/only）、feat/fix 等关键词原样保留，只压缩包裹它们的套话。
7. 删喉音：just/basically/actually、sure/of course、"In order to"→"To"、"It is important to note that"→删；AI 词表（delve, showcase, crucial, pivotal, tapestry, leverage…）换平实词。
8. 删姿态：em dash 全删（用句号/逗号）、规则三连改成自然数量、标题用 sentence case、去装饰 emoji、"I hope this helps!" 等机器人话删掉。
9. 一句话一件事，结论放首行；主动语态结尾行动。写不出"具体指令/事实/数字"的话就删。

**硬护栏（保护核心，不可最小化）：** trust boundary 处校验、防数据丢失的错误处理、安全控制、无障碍基础、用户明确要求的功能——这些再精简也不动。

## Output

- 清理后的 diff（小、逐味、可回退）。
- 一份证据 dense 的收尾汇报（中文，§4 格式）：改了哪些文件:行、删了什么味、行为怎么被锁住/验证、剩余风险。

## Stop conditions

- 行为无法用测试或明确验证方案保护 → 停下来先补验证，不盲删。
- 用户要的是宽泛重设计而非增量清理 → 停下转 m-think。
- 一次 edit 混进无关重构 → 拆开，或停下确认范围。
- 有意图不清的束删（可能是为了绕过类型/隐藏 bug）→ 停下问清楚。

## Harness notes

- Claude Code：用 Read/Edit/Grep/Bash 跑测试与 lint；可用 `git diff <base>` 圈定清理范围。
- DSH：无差异工具差异，用 bash 跑同套验证命令；`todo_write` 按 smell 拆任务。
- Codex：`codex exec` 更适合一次性短清理；交互式细调回到 Claude Code/DSH。
