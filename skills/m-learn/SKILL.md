---
name: m-learn
description: "复盘一次会话或一段工作，把重复踩的坑和可复用流程沉淀成 lesson、skill 或 memory。Use when the user says \"复盘 / reflect / 学到什么 / 把这个记下来 / 写个 skill\", or the same mistake shows up twice."
whenToUse: "Turn a session's repeatable workflow or a recurring mistake into a durable lesson, a candidate SKILL.md, or a memory entry, instead of re-discovering it next time."
---

# m-learn — 复盘与沉淀

把当下这次会话里"再来一次还会用到的东西"从会话里提出来，落成三种持久形态之一：一条 lesson（`~/.claude/lessons/` 或项目内），一个可复用流程的候选 SKILL.md，或一条事实类的 memory。核心判断标准是"可沉淀、非一次性"。原则 10（教训进结构）是本 skill 的依据。

## When to use / not use

**用**：同一个小错误出现第二次；一次踩坑花了真实调试/设计/运维成本才绕过来；一个多步流程明显会复现；用户说"把这个记下来 / 补个 skill / 复盘一下"。

**不用，转给别的 m-skill**：
- 单次事件、与项目无关的闲聊、已由某个现有 skill 正确覆盖的内容 → 不值得沉淀。
- 事实型、需要检索的知识 → 转 `m-handoff` 或直接写 memory。
- 要动手修代码 → 不在本 skill 范围，改完由 `m-verify` 验证。

## Procedure

1. **圈定材料**：只复盘当前会话，不跨到别的项目目录去翻 transcript；一次复盘只针对一个项目和一个会话。
2. **提炼（三条门都过才算可沉淀）**：能不能 5 分钟搜到现成答案？→ 不能；是不是和这个代码库/项目/工作流强相关？→ 是；是不是花了真实功夫才发现的？→ 是。三者任一为否就跳过。
3. **分类路由**，每条落到一种形态：
   - **失败教训 / 陷阱** → lesson（一行 key + 一句 insight + confidence 1-10 + 涉及文件）。
   - **可复用多步流程**（有输入、有序步骤、成功标准、坑）→ 候选 SKILL.md，配 frontmatter；定不清分支就先标注 open question，别硬写成流程。
   - **可被结构强制**（lint / 脚本 / 类型 / 运行时检查能拦住）→ 不写文字，直接落地成检查并证明它对一条真实历史错误会失败（见原则 10）。
4. **写文件**：lesson 追加到 `~/.claude/lessons/`（项目内 `CLAUDE.md` 只在用户要求时写）；流程草稿写到 `.mstack/` 暂存或直接 `.claude/skills/<name>/`，带 frontmatter，正文写明何时读哪个 reference。
5. **收尾汇报**（中文，格式见 §4）：一句结论 → 记了什么(文件:行) → 为什么够格成 lesson/skill → 还有哪些没沉淀或存疑。

## Output

- 追加的 lesson 记录，或一个候选 SKILL.md 草稿，或一条 memory。
- 汇报里列：每条沉淀的形态、key/名称、落点文件；被判定"不值得沉淀"的也列一行并给理由。

## Stop conditions

- 材料不足、会话琐碎、或已被现有 skill 正确覆盖 → 直接说"无新沉淀"，不硬造。
- 流程有未决分支、定不清成功标准 → 停下标注 open question 给用户，不硬写。
- 改动会进入共享 skill、影响所有后续 agent → 先展示完整草稿等用户批准再落盘。

## Harness notes

- Claude Code：lesson 写 `~/.claude/lessons/`；skill 草稿写 `.claude/skills/<name>/`。
- DSH：跨会话事实用 `~/.dsh/skills/` 下的 skill 文件承载，或写入项目 `.mstack/`；无专用 memory MCP 时用文件即可。
- Codex：优先级最低；把候选流程写成 `~/.codex/skills` 下的 SKILL.md，其余同 Claude Code 约定。
