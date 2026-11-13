---
name: m-learn
description: "复盘并沉淀 lesson、skill 或 memory。Use when 复盘/reflect/学到什么/把这个记下来/写个 skill, or the same mistake shows up twice."
whenToUse: "Turn a session's repeatable workflow or a recurring mistake into a durable lesson, a candidate SKILL.md, or a memory entry, instead of re-discovering it next time."
---

# m-learn — 复盘与沉淀

把当下这次会话里"再来一次还会用到的东西"从会话里提出来，落成三种持久形态之一：一条 lesson（`~/.claude/lessons/` 或项目内），一个验证过的 skill，或一条事实类的 memory。核心判断标准是"可沉淀、非一次性"。原则 10（教训进结构）是本 skill 的依据。skill 不是第一落点：先记 lesson，同一教训再次出现并验证通过之后才晋升。

## When to use / not use

**用**：同一个小错误出现第二次；一次踩坑花了真实调试/设计/运维成本才绕过来；一个多步流程明显会复现；用户说"把这个记下来 / 补个 skill / 复盘一下"。

**不用，转给别的 m-skill**：

- 单次事件、与项目无关的闲聊、已由某个现有 skill 正确覆盖的内容 → 不值得沉淀。
- 事实型、需要以后还能查到的知识 → 直接写 memory（无 memory MCP 时落成 lesson 或项目内文件），不走 `m-handoff`——handoff 只存当前状态，存完就过期。
- 要动手修代码 → 不在本 skill 范围，改完由 `m-verify` 验证。

## Procedure

1. **圈定材料**：只复盘当前会话，不跨到别的项目目录去翻 transcript；一次复盘只针对一个项目和一个会话。用已有 lesson 的 key 判断这是第几次，不靠记忆。
2. **提炼（三条门都过才算可沉淀）**：能不能 5 分钟搜到现成答案？→ 不能；是不是和这个代码库/项目/工作流强相关？→ 是；是不是花了真实功夫才发现的？→ 是。三者任一为否就跳过。
3. **分类**：
   - **教训 / 陷阱，第一次** → lesson（一行 key + 一句 insight + confidence 1-10 + 涉及文件）。不写 skill。
   - **同一 key 第 2 次及以上** → 更新 lesson 的出现次数。写成 skill 还要按 `references/skill-creation.md` 跑完 RED-GREEN。用户明确要求"写个 skill"时可以不卡次数，但不能跳过验证。
   - **只在一个项目里出现** → 即使次数够、验证过，也只写该项目 `.mstack/learnings/<slug>.md`，不进共享 skill 目录。用户明确要求共享时除外。
   - **能用结构拦住** → 不写文字。按下面的顺序找第一个行得通的一层，并证明它对一条真实历史错误会失败（原则 10）：① lint 规则或编译错误；② 类型约束；③ 运行时检查或断言；④ 脚本、钩子或 doctor 检查；⑤ skill 文字。落到 ⑤ 时写一句为什么前四层都不行。
4. **走生命周期**。字段、状态转移和退役阈值都在 `references/skill-creation.md`：create → verify → retrieve → refine → retire。没过 verify 的不检索。每次检索改记录里的成功次数/调用次数，不要只留在对话里。低成功率改为 retire，文件留着。
5. **写文件**：lesson 追加到 `~/.claude/lessons/`（项目内 `CLAUDE.md` 只在用户要求时写）。项目内记录写到 `.mstack/learnings/<slug>.md`。共享 SKILL.md 只在用户批准后写入对方指定的目录。
6. **收尾汇报**（中文，格式见 §4）：一句结论 → 记了什么(文件:行) → 为什么够格（次数、验证证据）→ 还有哪些没沉淀或存疑。

## Output

- 追加的 lesson，或 `.mstack/learnings/<slug>.md`（含 state 与 uses），或获准后的 SKILL.md，或一条 memory。
- 汇报里列：每条的形态、key/名称、落点、state；判为"不值得沉淀"的也列一行并给理由。
- 写成 skill 的，附基线借口原话和复跑结果的位置。缺任何一样，state 就还是 create。

## Stop conditions

- 材料不足、会话琐碎、或已被现有 skill 正确覆盖 → 直接说"无新沉淀"，不硬造。
- 流程有未决分支、定不清成功标准 → 停下标注 open question 给用户，不硬写。
- 这个 key 只出现过 1 次，且用户没点名要 skill → 只写 lesson。
- 没跑无 skill 的基线，或复跑仍在用记下的借口 → 停在 create 或 refine，不宣称可用。
- 改动会进入共享 skill、影响所有后续 agent → 先展示完整草稿等用户批准再落盘。

## Harness notes

- Claude Code：lesson 写 `~/.claude/lessons/`；共享 skill 在用户点头后写 `.claude/skills/<name>/`。
- DSH：跨会话事实用 `~/.dsh/skills/` 下的 skill 文件承载（同样要先批准），或写入项目 `.mstack/`；无专用 memory MCP 时用文件即可。
- Codex：优先级最低；获准的共享流程写成 `~/.codex/skills` 下的 SKILL.md，其余同 Claude Code 约定。
