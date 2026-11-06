# mola 人类模式输出（B2e）

`--json` 没变：stdout 仍是恰好一个 envelope，stderr 一条错误。下面只是人不加 `--json` 时看到的样子。颜色只在 TTY 且没设 `NO_COLOR` / `MOLA_NO_COLOR` / `--no-color` 时出现；管道和测试里是纯文本。

## help

之前是一行一个命令，没有分组，也没有例子：

```text
mola — plugin-based agent orchestration CLI

usage: mola [--json] [-v…] [-q] ... <command> [args]

commands:
  agents list    discovered agents (PATH probe + `magpie ls` merge)
  agents routes  the route ids magpie shows one agent
  doctor         health: node, plugins, magpie, agents, tools
  ...
```

之后按用途分组，末尾三个例子（`mola` 不带参数和 `mola help` 一样）：

```text
mola — plugin-based agent orchestration CLI
run "mola help" for the command list

usage: mola [--json] [-v…] [-q] [--config <path>] [--cwd <dir>] [--no-color] [--yes] <command> [args]

Overview
  dash     one screen: agents, superagents, recent runs, health
  doctor   health: node, plugins, magpie, agents, tools (per-plugin checks)

Run a task
  dispatch  run one task through the DSH headless worker (WSL, profile mola-cli)
  run       route a task to an agent (ADR-0003 filter + score, quota ladder)
  ...

examples
  mola doctor
  mola run "count TODOs in README.md"
  mola dash
```

## doctor

之前每行 `ok  ` / `FAIL`，顺序是注册顺序：

```text
ok    node>=22 — node v24.22.2
FAIL  tool.git — git not found on PATH
ok    plugins.plan-ok — 17 plugins, plan clean
```

之后失败排在前面，每项一个字形，说明就是修复提示：

```text
✘  tool.git  git not found on PATH
✔  node>=22  node v24.22.2
✔  plugins.plan-ok  17 plugins, plan clean
✔  magpie.healthcheck  magpie healthcheck ok
✔  tool.gh  gh 2.103.3 — not authenticated — run `gh auth login` for PR workflows
```

这台机器上 18 项都过了，所以看到的是一列 ✔。

## plugin list / agents / model / hooks / runs / superagent

之前是制表符或空格挤在一行上。之后是对齐的表，状态用 ✔ / ▲ / ✘。

`mola plugin list`：

```text
   id                    version  kind     tier     state
✔  mola-cmd-dash         0.1.0    command  builtin  active
✔  mola-cmd-doctor       0.1.0    command  builtin  active
```

`mola agents list`（health 不是 ok 的用 ▲，坏掉的用 ✘）：

```text
   agent  health   route             managed  machine
▲  claude unknown  -                 magpie   local
✔  dsh    ok       -                 path     wsl:Ubuntu
```

`mola model show dsh` / `mola model routes`：

```text
✔  group/claude-cheap  (source: profile patch)

   verdict  route
✔  allowed  group/smart-split
✘  banned   deepseek/deepseek-v4-pro[1M]
```

`mola hooks list`、`mola runs list` 同样是表。`mola runs show <id>` 是键值列表，事件行仍是 `mola.agent.message ×2` 这种。

`mola superagent status`：

```text
✔  layerfs  http://127.0.0.1:3082  running  load 0/3 workers, 0 queued
   setup ok, all health parts ready
```

setup 没完成时，问题行后面紧跟 `fix:` 和 superagent-ops.md 里的那条命令。`tickets` 同样是表：instance、source、state、`received=` / `filtered=` / `dropped=`。

## run / dispatch

之前人类模式也会把每个 NDJSON 事件打到 stderr，然后再把 `io.data()` 的整份 JSON 打到 stdout。

之后：

- `--json` 或 `-v`：stderr 仍是 NDJSON 事件流，stdout 仍是一个 envelope。
- 人类模式：spinner（只在 TTY 上转）加一行进度，然后是最终回答，再一行摘要：`agent · machine · route · duration · run id`。
- handler 已经自己写过人类输出时，router 不再追加 data。没写过时，data 打成表或键值列表，不再是 raw JSON。

## dash

`mola dash` 一屏四段，数据都是别的插件已经注册的，不另写一套探测：

```text
mola dash

Agents
     agent   health  detail
  ✘  claude  broken  spawn claude ENOENT
  ✔  dsh     ok      0.2.1-rc.5
  ✔  magpie  ok      magpie gateway answers

Superagents
  ✔  layerfs  running  setup ok  load 0/3  queued 0  tickets 2
  ✔  cad2gis  running  setup ok  load 0/3  queued 0  tickets 1

Recent runs
  (no recorded runs)

Health
  ✔  magpie.healthcheck  magpie healthcheck ok
  ✔  tool.rtk            rtk 1.1.0 (path: /root/.local/bin/rtk)
  ✔  tool.git            git 2.53.0 (/usr/bin/git)
  ✔  tool.gh             gh 2.103.3 — not authenticated — run `gh auth login` for PR workflows
```

- Agents 来自 `ctx.agents` 的 `detect()`（已注册的适配器，不是 `mola agents list` 那份 PATH + `magpie ls` 合并）。
- Superagents 来自 `ctx.tools` 的 `superagent` 适配器（`instances` / `api` / `interpretState`）。`tickets` 是 `/sources` 的条数——这个 API 没有工单列表。
- Recent runs 是 state store 里 `mola-rec-runs` 的 `run:*`，最多 8 条。
- Health 只跑 `magpie.healthcheck`、`tool.rtk`、`tool.git`、`tool.gh`。失败的排在前面。

`mola dash --json` 打一份 snapshot envelope（`agents` / `superagents` / `runs` / `health`），不看 `--watch`。

`mola dash --watch [秒]` 默认 5 秒。是 TTY 就清屏重画，Ctrl-C 退出；不是 TTY（管道、测试）只打一次，避免挂住。
