# DSH 原生团队能力 vs mstack m-team / m-dispatch

日期 2026-11-06 · 证据来源：`E:\deepseek\deepseek-harness`（只读，未执行 git）· 主要引用 `docs/tool-catalog.md`（生成文件，工具 schema 的权威来源）、`docs/config-catalog.md`、`packages/experimental/agent-team/README.md`。

## 结论（一句话）

DSH 的 agent-team 是真实可用的原生能力（9 个工具，带 CAS 任务板和 Lead 权限），但默认关闭，只有 `@deepseek-ai/dsh-experimental-agent-team-profile` 的 patch 打开，所以"几乎看不到"。它与 creation mode 不是同一类东西：team 负责协调 agent，creation mode 负责给 DSH 加插件；拿它们比较，前者是 m-team 的对应物，后者是另一件事。

## 1. DSH agent-team 实际提供什么

**启用方式**：`docs/tool-catalog.md:2530` 写明 "The shipped dsh-base bundle keeps the package disabled; the documented Agent Teams profile patch enables it while disabling the legacy continuable-child control names."。patch 文件 `packages/experimental/agent-team-profile/cordis.patch.yml` 做三件事：禁用 `tool-subagent-control`、`tool-subagent`、`tool-subagent-fork`；插入 `agent-team`（maxMembers 8, maxTasks 256, maxMessageBytes 65536）、`tool-agent-team`（freshProvider `spawn`, forkProvider `fork`）、`ui-agent-team`。

**工具（9 个，`docs/tool-catalog.md` 的 `dsh-experimental-tool-agent-team` 节）**：

| 能力 | 工具名 | 关键参数 / 语义 |
|---|---|---|
| 角色 | `spawn_teammate` | `name`(小写 kebab, 不可改名)、`description`、`prompt`、`context`=`fresh`\|`fork`。**仅 Lead 可调用**，无 `cwd` 参数 |
| 消息 | `send_message` | `target`（`lead` 或 teammate 名）、`message`。返回以 `docs/upgrade-guide/.../team-direct-inbox` 为准：`{ "sent": true }` |
| 中断 | `interrupt_agent` | `target`，仅 Lead；保留待处理 inbox |
| 状态 | `list_agents` | 无参数，返回 lead + 所有 teammate 的 running/inactive/provisioning/failed |
| 等待 | `wait_agent` | `timeout_ms` 10000–3600000，默认 30000；无其它运行成员时立即返回 `noProgress`，不轮询 |
| 共享任务板 | `team_task_create` / `_get` / `_list` / `_update` | `subject`、`description`、`blocked_by[]`、`write_scopes[]`（建议性前缀，非锁）；`_update` 的 `action` ∈ claim/release/edit/set_dependencies/complete/reopen/reassign/delete，必须带 `expected_revision`（CAS） |

**结构约束**（`packages/experimental/agent-team/README.md`）：
- 扁平：只有 Lead 能建成员，无嵌套 Team、无改名、无删除、无重名。
- 成员共享 Lead 的 cwd，无 worktree、无文件锁（README "Known Limitations"）。
- 任务 owner 不会因 inactivity / failure 自动释放。
- 不重试、不去重新发送；仅消息已被接受才算送达。
- 成员 Agent 本身是 `spawn` / `fork` provider 的 continuable child，因此 goal driver 的"等后代 settle"会把它们算进去（见第 3 节）。

**深度与上限**：
- 子 agent 默认深度上限 `maxDepth = 1`（`docs/config-catalog.md:3567`、`:4346`，"current Host subagent depth setting (default 1)"），即默认不能再套子 agent。
- team 的 `maxMembers` 文档默认值写 16（README 配置表），但 patch 里设为 8；以 patch 为准。
- `workflow` 的每次 run 上限 `maxTotalAgents`，默认 1000（`docs/config-catalog.md:4762`，"runaway-loop backstop"）；并发 `maxConcurrentAgents` 默认 `min(16, max(1, cores-2))`。

**脚本式编排 `workflow`**（`docs/tool-catalog.md` 的 `dsh-tool-workflow` 节）：
- 入参：`script`（纯 JS，顶层 await 允许，末尾 `return`）、`meta{name,description,phases?}`、`args`、`run_in_background`。
- 脚本钩子：`agent(prompt, {schema?, label?, phase?, provider?, model?})`；`pipeline(items, ...stages)`（无屏障）；`parallel(thunks)`（屏障）；`phase(title)`；`log(msg)`。
- `schema` 只支持 type/properties/required/additionalProperties/items/enum/const/oneOf；失败返回 `null`；钩子误用直接终止整个脚本。
- 脚本没有 fs / 网络 / 定时器。agent 选项里**没有 `cwd`**（只有 label/phase/provider/model/schema）。

**子 agent 工具**（非团队模式，`dsh-tool-subagent`）：`subagent`（`description`、`prompt`、`cwd`）、`subagent_fork`、`list_subagent_models`；控制面 `dsh-tool-subagent-control` 提供同名的 `send_message`（参数 `agent_id`）、`list_agents`（`scope`）、`interrupt_agent`（`agent_id`）。**注意：这些名字与 team 工具同名但参数不同**，启用 team profile 后前三者会被换成 team 版本，legacy `subagent` 也被禁用。

## 2. creation mode（Cordis 创造模式）是什么

`docs/user/develop/practice/dynamic-cordis.md`、`docs/tool-catalog.md:880`、`packages/extensions/tool-cordis/README.md`：

- Web profile 里选 **Creator mode**，额外挂载两个只读工具：`cordis_inspect_list`（列出 Host / Client 的 inspect provider 及其方法与 schema）、`cordis_inspect_query`（`platform`=`host`|`client`、`provider`、`method`、`input`，读取 Service 方法、事件模式、插件 config schema、Tool schema、主题 token、Slot 树）。它**不能**调用业务 Service，也不能改运行时。
- 持久化改动走 `plugin_manager`（`docs/tool-catalog.md` 的 `dsh-plugin-manager` 节）：`action` ∈ list_plugins / list_bundles / set_plugin / set_bundle / install_bundle / remove_bundle / list_version_exemptions / set_version_exemption；`target` 为插件 id 或包名/安装 spec；`approvedBuilds`、`registry`。**每个动作都需要 danger-full-access 或本次审批**，改动影响该 profile 的所有会话。
- 流程（`dynamic-cordis.md` 的 MCP 示例）：agent 先 inspect → 写一个只含配置的 bundle（`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`，patch 插入 `@deepseek-ai/dsh-mcp-client` 等）→ `plugin_manager install_bundle` → 检查 `application: applied`（`restart-required` 表示未生效）→ 调用新工具验证。HMR 开启时同一会话内即生效。
- 所以 creation mode 是"运行时扩展 DSH 自身"的机制。它不做多 agent 协调。

## 3. 差距：mstack 的 m-team / m-dispatch 哪些是纯文字

| mstack 文字描述 | DSH 原生现状 | 差距 / 建议 |
|---|---|---|
| m-team "roles run as Agent subagents via m-dispatch" | 角色应为 `spawn_teammate`（有 durable roster、任务板）；m-team 的 harness notes 只写 "subagent / workflow" | 在 SKILL.md 的 DSH harness notes 加一行：角色用 `spawn_teammate`（需 team profile 已启用），否则退回 `subagent`/`workflow` |
| m-team step 4 "solo agent + 角色" | `spawn_teammate` 与 `subagent` 不能同时存在于同一 profile（team profile 禁用 `subagent`） | 必须说明：team 模式下 solo 基线只能是 Lead 自己或 `workflow` 的单个 `agent()`，不能用 `subagent` |
| m-dispatch 步骤 3 "每个代码改动任务有独立 workspace" | `spawn_teammate` **无 cwd**，成员共享 Lead 的目录；`workflow` 的 `agent()` 也无 cwd；只有 `subagent`/`subagent_fork` 有 `cwd` | **隔离任务不能用 team 或 workflow 派发**。m-dispatch 需要：要么用 `subagent`（带 `cwd`），要么 Lead 先用 bash 建好 `git worktree`，把路径写进 prompt 并要求 child 先 `pwd` 校验 |
| m-dispatch "first pass / rank all / best-of" 选择规则 | `workflow` 的 `parallel` 是屏障，`pipeline` 无屏障 | first pass 对应 `Promise.race` 式需求，DSH 脚本里没有 race 钩子；需要用 `pipeline` + 脚本内计数实现，或退回人工选择 |
| m-dispatch "VERIFY 返回 evidence，缺证据重派一次" | `agent(prompt,{schema})` 直接给结构化对象；失败为 `null` | 把 RETURN 字段写成 schema，`null` 即 gap，脚本内 `filter(Boolean)` 后统计 gap，省掉 prose 解析 |
| m-dispatch "不同模型族做验证" | `agent()` 支持 `provider`/`model` 覆盖 | 可用，但必须走 magpie 路由（`group/smart-split` 等），不要直连 `deepseek/*` |
| m-team step 5 "通过 artifact 协调，不靠 prose" | 任务板有 `write_scopes`（建议性）、`revision` CAS | 用 `team_task_*` 记录"谁改哪些文件"，并把 `write_scopes` 当成 m-team 的文件所有权表 |
| m-team "round = dispatch → score → supervise" | goal 的 round 是同一会话在 agent 空闲时自动续一轮（`dsh-goal-round-driver`，`max_goal_rounds` 默认 256，blocked 至少 3 轮） | **可以映射**：1 个 goal round = 1 个 m-team round。Lead 在每轮末尾 `update_goal` complete/blocked，并遵守"blocked 需 3 轮以上"。driver 等后代 settle 后才开下一轮，因此 teammates 跑完才会进入下一轮 |
| m-team "supervisor cadence via loop plugin" | `schedule_create`（`target=this_session`）可按 RRULE 把 prompt 投回本会话 | 用 `schedule_create` 代替 loop plugin 作为定时唤醒（注意：subagent 不能调用 schedule 工具） |
| m-team stop conditions（噪声带、两轮无提升） | 无内置度量 | 留在 m-team 的 `history.md` 与 goal 的 objective 文本里，由 Lead 判断，不要依赖 DSH 原语 |

### 可直接替换 m-dispatch 的 workflow 脚本模板（未运行，需在 DSH 中验证）

```js
// args: { roles: [{name, prompt}], verifierProvider? }
phase('dispatch');
const RESULT = {
  type: 'object',
  properties: {
    status: { enum: ['done', 'blocked'] },
    files: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'string' },   // 命令 + 输出
  },
  required: ['status', 'evidence', 'files'],
  additionalProperties: false,
};
const results = await parallel(args.roles.map(r => () =>
  agent(r.prompt, { label: r.name, phase: 'dispatch', schema: RESULT })
));
const gaps = results.map((x, i) => (x ? null : args.roles[i].name)).filter(Boolean);
phase('verify');
const verdicts = await pipeline(
  results.filter(Boolean),
  (prev, item) => agent(`Review without knowing the author: ${JSON.stringify(item)}`,
    { label: 'verify', phase: 'verify', provider: args.verifierProvider, schema: { type: 'object',
      properties: { verdict: { enum: ['APPROVE', 'REQUEST CHANGES'] } }, required: ['verdict'], additionalProperties: false } })
);
return { gaps, results, verdicts };
```

注意：这里的 `provider` 必须是 magpie 路由。隔离写入（worktree）不在脚本里做，需要 Lead 在调用前用 bash 建好并把路径放进 `args`。

### team 模式的 m-team 映射（推荐）

1. Lead：`create_goal`（objective 含噪声带、停止规则、`max_goal_rounds` = 轮数上限）。
2. 每轮：`spawn_teammate`（每个角色一个，`context: fresh`）；角色的 write 范围写进 `team_task_create.write_scopes`；`wait_agent` 直到 `team_task_list` 全部 completed。
3. 评分：用 `workflow` 的 `agent()` 做盲评（标签 A/B/…，不带作者信息），不要让写代码的成员自评。
4. 记录：`history.md` 与 `LEARNINGS.md` 由 Lead 写；本轮结束 `update_goal` 或 `blocked`。

## 4. mstack 能否发布 DSH bundle（preset/plugin）注册 team 角色

**可以，但只能做"可选 patch"，不应做全局默认。** 证据：

- bundle 的机制已存在：`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`（同 `agent-team-profile`）。安装用 `plugin_manager install_bundle`。
- bundle 可以包含：
  1. `cordis.patch.yml`：插入 `agent-team`、`tool-agent-team`，可选 `ui-agent-team`；参数照抄 profile 的 `maxMembers` / `maxTasks` / `maxMessageBytes` / `freshProvider` / `forkProvider`。
  2. 角色目录（读写范围、evidence 要求）的 prompt 模板，作为 `skill`（`dsh-tool-skill` 的 `skill` 工具）给 Lead 加载；mstack 的 `references/role-catalog.md` 可直接搬。
  3. 一个 workflow 模板（上节的脚本）作为文档，或用 `dsh-tool-workflow` 的参数示例。
- **不要做的事**：照搬 `agent-team-profile` 里 `tool-subagent: disabled: true`。这会改变整个 profile 的所有会话（`plugin_manager` 文档："Changes affect every session in this profile"），让 m-dispatch 的 `subagent` 消失，也会让 `cwd` 隔离失效。应做成独立 preset 或仅在 m-team 会话挂载的 scope。
- 风险：`dsh-experimental-agent-team` 文档明确写 "Experimental prototype with no stability promise"，升级指南 `team-direct-inbox` 已有破坏性变更（send_message 返回值变化、`maxPendingMessagesPerMember` 删除）。bundle 需要钉版本，并在 SKILL.md 里写明依赖的 DSH 版本。

## 5. 文档之间的不一致（实现前需核对）

- `send_message` 返回值：`docs/subsystems/agent-team.md` 写返回 inbox `MessageId`；`packages/experimental/agent-team/README.md` 同；`docs/upgrade-guide/.../team-direct-inbox/guide.md` 与生成的 `docs/tool-catalog.md` 写 `{ "sent": true }`。以生成的 tool-catalog 为准，其余两处需要核对。
- `maxMembers` 默认：README 写 16，profile 写 8。
- `m-dispatch/references/harness-commands.md` 列出的 DSH 工具（`subagent`、`subagent_fork`、`subagent_claude_code`、`subagent_codex`、`workflow`）与 team profile 会互斥，文档没有提到。

## 未做的事 / 风险

- 未运行任何 DSH 命令，所有结论来自文档与 schema 阅读；第 3 节的脚本模板未在 DSH 中执行验证。
- 未读 `.agents/notes/implemented/feature/2026-08-05-agent-teams.md`（文档引用的设计笔记，本次未要求）。
- 未核实 `workflow` 子 agent 是否真的继承 Lead 的 cwd（只看到 spawn 的 "effective directory supplies the default cwd" 文字）。
- 未验证 goal driver 是否把 team 成员算作"progressing descendants"（只有 README 文字）。
