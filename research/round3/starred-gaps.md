# 星标仓库 vs mstack / mola：差距分析（round3）

日期：2026-11-06 · 输入：`starred.tsv`（262 行）· 读取：每个入选仓库 README 前 150 行（`gh api repos/<o>/<r>/readme`）。
方法限制：只读了 README，没有运行任何一个项目；star 数以 tsv 记录为准；分类是按名称和 README 首段做的人工判断，边界处有重叠。

## 1. 聚类（过滤后约 70 个相关仓库，超出预期的 40–80 区间内）

| 簇 | 数量（约） | 代表仓库 | 与 mstack/mola 的关系 |
|---|---|---|---|
| A 多 agent 编排 / 运行时 / 工作区隔离 | ~20 | stablyai/orca, herdrdev/herdr, reason-network, paperclip, ephemeral-sandbox, DS-Bot, Lody, claw-code, LangGraph | 最直接相关。mstack 的 m-dispatch 和 m-team 有这块需求，mola 的 B3/B4 也在设计中 |
| B skill / harness 包（工作流、领域技能、提示词） | ~15 | gstack, ECC, Supervisor-Skills, taste-skill, drawio-skill, awesome-claude-code, hello-agents | mstack 本身就是从 gstack/OMC 等合并来的。ECC 和 gstack 的体量比 mstack 大得多，mstack 的做法是有意做减法 |
| C 记忆 / 上下文持久化 | ~7 | claude-mem, agent-beacon, OpenViking, Hy-Memory, dsh-context | 缺口最明显：mstack 只有手工 handoff 和 lessons，没有自动捕获 |
| D 模型路由 / 网关 / 安全扫描 | ~8 | free-claude-code, OmniRoute, new-api, sub2api, SkillSpector | 路由已由 magpie 负责（owner 自有）。SkillSpector 对应 DESIGN §9 里"可选"的扫描 |
| E 计算机使用 / 浏览器 / 外部感知 | ~12 | agent-desktop, fara, CloakBrowser, Browser4, page-agent, Agent-Reach, mirage, CLI-Anything | mstack 的 m-qa 只支持 Playwright 网页，没有桌面端控制 |
| F 自治循环 / 远程与 IM 控制 | ~10 | agent-autoloop, hermes-agent, alma-relay, ds-harness-remote, nanoMuse | 缺口：没有"事件触发 → 一次性运行 → 卡片审批 → 续跑"这条链 |
| G 评估 / 观测 / 可复现运行记录 | ~4 | langfuse, apache/maka | mstack 有 evals/ 目录，但运行记录只是状态文件，没有评分 |
| 排除 | — | awesome-* 列表、教程、非 agent 的项目（FreeCAD、OpenROAD、学习通脚本等）、owner 自己的仓库（mola-*、magpie-layerfs、LayerFS） | 不纳入差距分析 |

已在用、不再单列：oh-my-claudecode（mstack 保留其 agents 和 MCP）、rtk-ai/rtk（已接入）、yetone/magpie（owner 自有）。

## 2. 入选的 20 个仓库

评语字段：**adopt**（直接采用）/ **plugin**（做成 mola 插件）/ **borrow**（借鉴模式）/ **ignore**（不做）。
mola 的现状依据：`cli/design/DESIGN.md` §4–§9、`cli/design/ux-notes.md` 的 dash 段、`packages/plugins/` 现有插件列表。

| # | 仓库（star，日期） | 簇 | 能力与做法 | mstack/mola 缺什么 | 采用思路 |
|---|---|---|---|---|---|
| 1 | reason-machines/reason-network（1.6k，11-06） | A | 每台机器一个守护进程，E2E 加密 P2P；agent 之间用 `send_message` / `message_status` / `ask_user`；`idempotency_key` 防重发；有回执状态（queued / accepted / handed / replied） | B4 的 NATS 通道没有回执状态机和幂等键；队友请求 owner 审批时没有转发到手机的机制 | **borrow**：B4 消息模型照抄回执状态和 `idempotency_key` |
| 2 | HKUSTDial/Supervisor-Skills（11.9k，11-06） | B | 导师经验炼成"Guide + 可执行 skill"双轨；`paper-writer` 要求证据门控（每个论断要有依据） | mstack 的 skill 偏工程，没有"论断必须带来源"的写作门 | **borrow**：m-research / m-plan 的输出模板加证据门；领域内容 **ignore** |
| 3 | stablyai/orca（118k，10-15） | A | 桌面编排器：协调 agent 拆任务，每个 worker 独立 worktree；有 CLI `orchestration`、远程服务器、手机端 | mstack FRAMEWORK §9.2 已规划 Orca 后端，但 mola 的 dispatch 是一次性 DSH 调用，没有常驻 worker 视图 | **plugin**：按 §9.2 做 Orca 后端，把 m-dispatch 的 worktree 规则对齐 Orca CLI |
| 4 | herdrdev/herdr（48.8k，11-04） | A | Rust 终端复用器，后台 server 保持 pane 存活，断开不停；每个 pane 标记 working / blocked / idle；agent 能通过 CLI 派发和等待 | `mola dash` 只显示 agent 健康、superagent、最近 run（ux-notes §dash），没有逐个 worker 的 working / blocked 状态，也不能断线重连 | **borrow**：由 `mola.agent.message` / `mola.agent.idle` 事件推导状态，写进 dash |
| 5 | KKKKhazix/agent-autoloop（3.8k，11-04） | F | 零依赖内核：定时器或 Issue 等事件 → `rules.json` 规则 → CLI agent 跑一轮就退出；遇到删数据、花钱等事项发飞书卡片；回答后接着原对话干 | mola 有审批闸门（exit 77），但没有"事件触发 → 一次性运行 → 等审批 → 续跑"；m-goal 没有定时唤醒 | **plugin**：做 event 源插件 + `cmd-autoloop`，复用 `policy-approval`，续跑用 agent 的 resume |
| 6 | vercel-labs/agent-desktop（18.3k，11-04） | E | 通过无障碍树操作 macOS / Windows / Linux 桌面应用；输出 JSON envelope；ref 只在对应 snapshot 内有效；默认不抢焦点；`--stdin` 传敏感文本 | mstack m-qa 只支持 Playwright 网页；mola 没有桌面端工具插件。JSON envelope 与 mola 的输出约定一致，接入成本低 | **plugin**：`tool-desktop` 包一层；type / click 归为对外动作，需经审批 |
| 7 | thedotmack/claude-mem（114k，10-29） | C | 后台第二个 agent 观察工具调用，AI 压缩成 observation，下次会话开始时注入一份短索引，细节按需拉取（渐进式披露）；数据在 `~/.claude-mem` | mstack 只有手工 `handoff.md` 和 lessons，每次会话从零开始；lessons 目录全部是人工逐条撰写（见 `~/.claude/lessons/index.md`） | **borrow** 先行：m-start 注入索引的模式；做插件前先确认手工 handoff 不够用。注意 DESIGN §9 的 secret 过滤 |
| 8 | affaan-m/ECC（299k，04-20） | B | 71 agent、314 skill、hooks、continuous learning（"instincts"）、AgentShield 扫描；流程 plan→test→implement→review→verify→remember→improve | mstack 的 16 个 skill 是有意做减法的结果，整体照搬违背 FRAMEWORK §1 | **ignore** 整体；**borrow** instincts 的思路：m-learn 产出的经验带置信度和证据条数 |
| 9 | NousResearch/hermes-agent（261k，07-04） | B/F | 闭环学习：周期性提醒 agent 整理记忆，复杂任务后自动生成 skill，skill 使用中自我改进；内置 cron；多 IM 网关；子 agent 并行 | m-learn 需要人工触发；没有定时提醒，也没有自动起草候选 skill | **borrow**：任务结束时 m-learn 起草候选 SKILL.md 放到 `.mstack/candidates/`，由人批准，不自动安装 |
| 10 | paperclipai/paperclip（112k，05-27） | A | 公司化编排：组织架构、目标对齐、预算阈值告警并在超限时暂停；heartbeat 唤醒 agent；skill studio 带 eval | mola 没有每次运行的预算上限和阈值告警（DESIGN 里有 `mola.cost.reported` 事件，但没有消费方） | **borrow**：预算上限和阈值告警做成 policy 插件；组织架构 UI **ignore** |
| 11 | Ephemeral-AI-Lab/ephemeral-sandbox（124，10-29） | A | 一个共享沙箱，每个 agent 有私有可写 workspace 会话；发布时检查并发冲突，要么整体发布要么不发布 | owner 的 LayerFS 已有 checkpoint 和分支；缺的是多 agent 合并时的"全部成功或全部不发"规则，m-dispatch 目前手工合并 | **borrow**：m-dispatch 的合并规则。先和 LayerFS 比对，避免重复造轮子 |
| 12 | NVIDIA/SkillSpector（24.7k，10-27） | D | 技能静态扫描：71 个模式、17 类；可选 LLM 语义阶段；输出 SARIF；基线抑制已知误报；有 MCP / Pi / OpenCode 扩展 | DESIGN §9 只写了"可选的 SkillSpector 扫描"；m-guard 的插件体检是手工的 | **adopt**：把它做成 `mola plugin install` 和 m-guard 技能入库的必过闸门，带基线文件 |
| 13 | langfuse/langfuse（37k，10-24） | G | 开源 trace、evals、prompt 管理；skill 带版本和标签（beta）；AI gateway；可自托管（Docker / Helm） | mstack 有 evals/ 但没有带评分的 trace 存储；mola 运行记录有 events.jsonl 但无评分字段 | **borrow**：运行记录加评分字段（verify 通过与否、成本）；需要时做成可选导出器，不作为依赖 |
| 14 | apache/maka（5.9k，09-08） | G | append-only 的 RuntimeEvent 日志就是运行时本身；UI、下一轮 prompt、回放都读这份日志；每次发布的 eval 结果附带官方 verifier 结果 | mola 已按 BATCHES B2 写 `.mstack/runs/<runId>/events.jsonl`，但 decision.json、状态记录和事件日志是几份数据，没有定义谁是唯一真相源 | **borrow**：让 NDJSON 运行日志成为唯一真相源，dash、runs、续跑都从它派生 |
| 15 | Alishahryar1/free-claude-code（67k，10-10） | D | 把 12 种 harness 通过本地代理接到 61 个 provider；自动重试、限速、并发控制、模型/provider 自动降级、多 key 轮换；RTK + Headroom 压缩 | mola 只通过 magpie 白名单路由，没有 402/429 时的自动降级。CLAUDE.md 里记过 deepseek 402 导致 worker 全部死亡 | **borrow**：降级链放在 magpie 的路由定义里（owner 自有），mola 只在 decision.json 里记录实际用的 route |
| 16 | cheaper-inference/OmniRoute（85k，07-26） | D | 一个端点接 375 个 provider；配额感知调度；实时配额遥测；`/v1/models/query` 模型发现 | 同上：没有配额遥测；`mola model routes` 不显示剩余额度 | **borrow**：配额遥测的数据结构，接到 `mola model routes`。**ignore** 作为依赖（与 magpie 重叠） |
| 17 | Fei2411/DS-Bot（6k，10-11） | A | DSH 上的长期 bot 插件：有名字和角色；bot 之间发消息；群聊；一句话组队 | mola 对 DSH 只有 headless 派发，没有长期 bot 身份 | **ignore** 进 mola 核心；**borrow** 群聊和身份模式到 B4。属于 dsh 生态，留给 dsh-kit |
| 18 | HKUDS/CLI-Anything（58k，08-29） | E/A | 为任意软件生成 agent 可用的 CLI（HARNESS.md 做渐进式披露）；CLI-Hub 注册表，`cli-hub install <name>` 安装 | mola 的 tool-* 插件全部手写，没有注册表和发现机制 | **plugin**：tool-* 插件可以通过 cli-hub 安装，走权限 diff；**borrow** HARNESS.md 的渐进式披露写法。CAD2GIS 有重叠，需避免双份工具 |
| 19 | garrytan/gstack（141k，04-20） | B | 角色化 skill（CEO、eng manager、设计、QA、发布）；`/office-hours → /autoplan → /ship`；team 模式用仓库内 hook 自动同步；多 host 安装 | mstack 来源之一，已合并；但没有 team 模式的仓库级同步，也没有多 host 的安装脚本（mstack 的安装仍是手工软链） | **borrow**：团队内同步机制（仓库 hook 检查 mstack 版本）；角色人设 **ignore**（与做减法冲突） |
| 20 | Asymptote-Labs/agent-beacon（3.4k，09-11） | C | 跨 20+ harness 收集会话历史；经审核的知识通过 MCP 或 Agent Skills 共享；精确回放 prompt、工具、审批、token；本地 JSONL | mola 计划的 `sessions list/handoff`（B3/B5）只覆盖 mola 自己的会话，没有跨 harness 历史 | **borrow**：JSONL 会话 schema 和"审核后才能共享"的闸门；与 claude-mem 二选一前需对比 |

## 3. 前 8 个差距（按影响排序）

1. **自动跨会话记忆 + 审核闸门**（claude-mem、agent-beacon）。现在每次会话从零开始，owner 的 lessons 靠人写。做法：mola 事件钩子把 `mola.tool.after`、`mola.turn.completed` 写成 observation 的 JSONL；m-start 注入索引；m-learn 把审核过的条目升格为 lesson。
2. **事件触发的无人值守运行 + 卡片审批后续跑**（agent-autoloop、hermes 的 cron）。补上"手机上批准"这条链。`policy-approval` 已经能拦截，缺的是触发源和续跑。
3. **Provider 降级与配额遥测**（free-claude-code、OmniRoute）。402/429 是 owner 已经踩过的坑，每次都让整批 worker 死掉。降级链放在 magpie，mola 在 decision.json 里记录实际路由，dash 显示剩余配额。
4. **逐 worker 的状态分类与断线续看**（herdr、orca）。m-dispatch 派出去之后是盲的。从 agent 事件推导 working / blocked / idle，写进 `mola dash`；Orca 后端按 FRAMEWORK §9.2 实现。
5. **技能与插件安装前的强制扫描**（SkillSpector）。DESIGN §9 把它定为可选，但 ECC、hermes 这类第三方技能一旦装进来就是供应链风险。改为 `mola plugin install` 与 m-guard 技能入库的必过闸门，带基线文件。
6. **NDJSON 运行日志作为唯一真相源 + 评分字段**（maka、langfuse）。让运行可回放，并能给 skill 的 verify 结果打分。当前 decision.json、状态记录与 events.jsonl 并存，没有定义唯一真相源。
7. **多 agent 发布的"全部成功或全部不发"规则**（ephemeral-sandbox）。m-dispatch 合并时的冲突检查，先与 LayerFS 能力对比，避免重复实现。
8. **B4 消息的幂等键与回执状态机**（reason-network）。在写 B4 之前定下来，成本最低。队友 agent 的请求经 owner 审批后再投递。

次一档（没进前 8）：agent-desktop 的桌面端工具（#6），做成 `tool-desktop` 插件，优先级排在前 8 之后。

## 4. 不建议做的事

- 整体引入 ECC、gstack 或 OmniRoute 作为依赖。mstack 的核心原则是减法，这些项目的体量与之冲突，且与 magpie 重叠。
- 为 DS-Bot 式的长期 bot 身份在 mola 核心里加模型，应留在 dsh 生态。
- 在没有实测的情况下采用 claude-mem 或 agent-beacon 中的任何一个。两者都要先在 owner 的一台机器上跑一周，再决定。

## 5. 核验说明

- 每个入选仓库的 README 来源：`gh api repos/<owner>/<repo>/readme -H "Accept: application/vnd.github.raw"`，取前 150 行。herdr 的 README 本身只有 85 行，已全部读取。
- mola 现状依据：`E:\mstack\cli\design\DESIGN.md` §4、§6、§9；`E:\mstack\cli\design\ux-notes.md`（dash 段）；`E:\mstack\cli\packages\plugins\` 目录列表。
- mstack 现状依据：`E:\mstack\README.md`、`E:\mstack\FRAMEWORK.md` §2（16 skill 来源映射）、§9.2（Orca 后端）、§11（第二轮改进）。
- 未做：没有运行任何入选项目，没有验证其性能或安全声明；star 数是 tsv 记录的值，不是实时值。
- 未修改其他文件，只新建了本文件。
