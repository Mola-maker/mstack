# 可选的 PreToolUse 钩子

m-guard 默认不安装任何钩子。下面的片段要用户自己贴进 Claude Code 的设置或插件钩子里才生效。没贴之前，SKILL.md 里的"不执行 / 不改范围外"只是 agent 的自觉，Bash 仍能改冻结目录外的文件。

核对过的字段来自 Claude Code 钩子文档（`https://code.claude.com/docs/en/hooks`，本文件撰写时读过该页）：

- 事件名是 `PreToolUse`。匹配器是工具名：`Bash`、`PowerShell`、`Edit`、`Write`。`Bash|PowerShell` 和 `Edit|Write` 都能匹配其中任意一个。
- 命令钩子从 stdin 收到 JSON。命令字符串在 `tool_input.command`。Edit/Write 的路径在 `tool_input.file_path`，且已经是绝对路径；Windows 上用反斜杠。
- 决定必须写在 `hookSpecificOutput` 里，并带 `hookEventName` 为 `PreToolUse`。本钩子只用 `permissionDecision: "ask"`。`ask` 会弹出确认，理由显示在提示里。它不是 `deny`。用户可以批准。
- 顶层的 `permissionDecision` 已废弃，PreToolUse 会忽略它。
- 进程退出码 0 且 stdout 为空：不额外做决定，走原来的权限流程。退出码 2 等价于拒绝。本脚本永远退出 0，所以它做不到硬拒绝。
- 钩子失败（起不来、JSON 无效、退出码不是 0 或 2）时，默认放行。不要加 `onFailure: "block"`，否则脚本一崩就会挡住所有匹配的工具调用。
- 多个 PreToolUse 同时返回时，`deny` 优先于 `ask`。本片段不返回 `deny`。
- 只匹配 `Bash` 时，没装 Git Bash 的 Windows 不会触发（那边的 shell 工具是 `PowerShell`）。所以匹配器写成 `Bash|PowerShell`。
- `args` 存在时是 exec 形式：`command` 必须是真实可执行文件，参数不再经过 shell。文档写明 `node` 加脚本路径在各平台都能跑。本片段用这种形式，避免自己发明 shell 转义。
- `${CLAUDE_PLUGIN_ROOT}` 在插件自带钩子里会替换成插件目录。把它贴进项目 `.claude/settings.json`（不属于任何插件）时，这个占位符是否还有值，文档没有写死。那种情况下改成脚本的绝对路径。
- 无人值守的 `claude -p` 里，没人回答的 `ask` 会被 Claude Code 当成拒绝，理由进工具结果。那是产品行为，不是这个脚本返回了 `deny`。

## 脚本

```
node "<this skill dir>/scripts/check-pretool.mjs"
```

`<this skill dir>` 是本 skill 的 SKILL.md 被加载时所在的目录（Claude Code 里显示为 skill base directory；在 mstack 仓库里是 `skills/m-guard`）。

从 stdin 读一条 PreToolUse JSON。命中时向 stdout 打一行 JSON；不命中时什么都不打。退出码始终是 0。单测：`node --test "<this skill dir>/scripts/*.test.mjs"`（glob 要加引号；Node 24 不接受裸目录参数）。

它会询问的形状只有这些：

- 递归删除正好打在 `/`、`/*`、`~`、`$HOME`、`${HOME}`、用户主目录本身，或 Windows 盘符根（如 `C:\`）。`rm -rf ~/proj` 和 `rm -rf node_modules` 不问。`bash -c '…'` 会再看一层内层命令。
- `git push` 带 `--force`、短选项里的 `-f`、或 `+refspec`，且目标是默认分支。只写 `--force-with-lease` 不问。默认分支用 `git symbolic-ref --short refs/remotes/origin/HEAD` 读取；当前分支用 `git rev-parse --abbrev-ref HEAD`。读不到时改为询问，而不是假装知道。单独一个位置参数时，只有 `origin` 和 `upstream` 被当成远程名；其它远程名且没写 refspec 时可能漏判，脚本会在理由里说明读不到分支的情况。
- `.mstack/freeze` 存在且至少有一行路径时，Edit/Write 的 `file_path` 不在任一前缀内。`.mstack/` 本身永远放行：checkpoint、closeout、handoff 和冻结文件自己都在里面，不用把 `.mstack` 写进冻结清单。文件不存在，或只有注释/空行：冻结未开启，不问。前缀相对钩子 JSON 里的 `cwd` 解析。比较前会把 `\` 换成 `/`，并保证 `/src` 不等于 `/src-old`。

不问这些：`DROP TABLE`、`git reset --hard`、NotebookEdit、通过 Bash 改文件。那些仍按 SKILL.md 第 1–2 步由你自己判断。解析不了的复合命令是尽力而为，不是策略边界。

## 冻结文件

项目根 `.mstack/freeze`，一行一个允许编辑的前缀，`#` 后是注释：

```
# 只许改 API
src/api
```

解除冻结是删掉这些行或删掉文件。mstack 没有 `/unfreeze`。

## 设置片段（用户自己贴）

插件钩子（只有决定启用时才加进 mstack 的 `hooks/hooks.json`；仓库默认不加）：

```json
{
  "matcher": "Bash|PowerShell",
  "hooks": [
    {
      "type": "command",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/skills/m-guard/scripts/check-pretool.mjs"],
      "statusMessage": "m-guard ask check"
    }
  ]
}
```

Edit/Write 再挂一条，匹配器换成 `Edit|Write`，`command` 和 `args` 相同。两条都放在 `hooks.PreToolUse` 数组里，和现有的 PreCompact 条目并列，不要覆盖别的事件。

项目或用户的 `.claude/settings.json` / `~/.claude/settings.json` 用同一形状，但 `args` 里写成脚本的绝对路径，不要依赖 `${CLAUDE_PLUGIN_ROOT}`。`statusMessage` 只是等待时的一行提示，可省略。

DSH 和 Codex 没有这个事件。不要在那两个环境里声称钩子已生效。

## 可选的 Stop 提醒（m-verify 验证门）

mstack 的 `hooks/hooks.json` 已注册 `hooks/stop-verify.mjs`，但默认什么都不做。它只提醒，永远不拦。

核对过的字段来自 Claude Code 钩子文档（`https://code.claude.com/docs/en/hooks`，撰写时读过 Stop 一节和 JSON output 一节）：

- 事件名 `Stop`：主 agent 答完时触发。用户中断不触发；API 错误走 `StopFailure`。
- stdin 的 JSON 含通用字段（`session_id`、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name`），加上 `stop_hook_active`、`last_assistant_message`、`background_tasks`、`session_crons`。本钩子只用 `cwd` 和 `stop_hook_active`。`stop_hook_active` 为 `true` 表示 Claude Code 已因某个 stop 钩子在续跑；本钩子此时直接退出，不重复提醒。
- 会让 Claude 继续的写法有三种：`decision: "block"`（要 `reason`）、退出码 2（stderr 当理由）、`hookSpecificOutput.additionalContext`。本钩子一种都不用。`continue: false` 会整个停下，也不用。
- 只给用户看一行提示：stdout 打一个 JSON 对象 `{"systemMessage": "..."}`，退出码 0。文档：`systemMessage` 是"显示给用户的警告"，所有事件都接受；Stop 一节没有写它被丢弃（别的事件如 PreCompact、SessionEnd 明写丢弃）。成功钩子的普通 stdout 不会出现在对话里，所以不能只 `console.log` 文本。
- `systemMessage` 和普通 stdout 上限 10000 字符。
- Stop 没有匹配器（文档："no matcher support"），`hooks.json` 里的条目不写 `matcher`。
- 8 次连续续跑的上限只约束会续跑的钩子，本钩子不续跑。

### 打开与关闭

- 打开：在项目里建文件 `.mstack/verify/gate`（`mkdir -p .mstack/verify && touch .mstack/verify/gate`）。
- 关闭：删掉这个文件。没有文件就没有任何输出。
- 打开后，每次答完：当前代码（含未提交和未跟踪文件，不含 `.mstack/`）没有达到所需层级的验证回执，就显示一行，写明所需层级、已有层级和要跑的命令。所需层级读项目 `.claude/skills/verify/SKILL.md` 的 `Required level: L<n>`，没有则为 L1。回执由 `skills/m-verify/scripts/receipt.mjs write` 写入，规则见 m-verify 的 `references/ladder.md`。
- 门关着（没有 gate 文件）：完全静默。不是 git 仓库、stdin 不是 JSON：也静默。
- 门开着而检查本身失败或超时：不再静默（静默等于悄悄把提醒关掉）。钩子照样退出 0、不下 `decision`，但用 `systemMessage` 打一行 "verify gate could not be evaluated: <原因>"，例如 `tree hash timed out after 4000 ms` 或 git 的报错。
- 耗时：哈希要把变更和未跟踪文件都 `git add` 进临时索引，代价随这些文件的数量增长；`receipt.mjs` 自带截止时间（钩子传 `--timeout-ms`，默认 4000，可用环境变量 `MSTACK_STOP_VERIFY_TIMEOUT_MS` 改），到点自己退出并清理 `.git/mstack-tmp/` 里的临时索引。钩子总超时是 10 秒。仓库太大时用户会每轮都看到超时那一行；办法是关门，或缩小未跟踪文件（补 `.gitignore`）。
- 已知限制：只改文档也要新回执；嫌烦就关掉门，不要降所需层级。
