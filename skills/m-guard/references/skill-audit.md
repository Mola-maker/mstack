# 装好之后的 skill 体检

在第三方 skill、插件或 MCP 已经装上之后读这份清单。它不安装钩子，也不代替装前那种"先别装"的判断（装前步骤在 SKILL.md 第 4 步）。全部手工做，做完把结论写进回复。

## 1. 把装上的东西列全

- 项目：`<repo>/.claude/skills/*/SKILL.md`，以及 `<repo>/.claude/settings.json` 里的 hooks 和 MCP。
- 用户目录：`~/.claude/skills`、`~/.dsh/skills`、`~/.codex/skills`（哪个存在看哪个）。
- Claude Code 插件：`claude plugin list`，再对可疑的那个跑 `claude plugin details <plugin>`（这两个命令在本仓库里用过）。不要编一个"列出全部 skill"的子命令。
- DSH 配置：`dsh --profile <p> --dump-config`。这是 DSH 专有的，别在 Claude Code 里跑。

每个 skill 记下：路径、frontmatter 的 `name`、description 第一句。

## 2. 重名

按 `name` 分组。两处同名就标出来。已知的一点：项目里的 skill 若叫 `verify`，会占掉 Claude Code 自带的同名入口（pstack 调研里核对过）——m-qa 生成的项目验证 skill 因此命名为 `<repo>-verify`，目录仍是 `.claude/skills/verify/`，不要把这个名字报成冲突。其它名字谁覆盖谁，没在钩子文档里逐条核对，不要猜优先级，把两份路径都报给用户，让用户留一份。

## 3. Frontmatter

对每个 SKILL.md：

- 没有 `name` 或 `description`：标为不会注册。
- 未加引号的值里出现 `: ` 或 ` #`：标为危险。mstack 的已知陷阱是，这种 YAML 会让 Claude Code 静默丢掉 skill 或描述。
- description 长于约 130 个字符：按同一条已知陷阱，描述可能被丢掉。长于 1024：超过本仓库 `scripts/check.mjs` 使用的 Agent Skills 上限。
- `name` 和目录名不一致：标出来。
- 只对 mstack 自己的 skill 要求第三个字段 `whenToUse`。别人的 skill 没有它不算失败。
- 若 `disable-model-invocation` 为 true：模型不会主动调用它。这是装上了却用不上，不是安全问题，但要写进结论。

## 4. 体积

- 单个 SKILL.md 超过 150 行，或超过 12000 字节：标为过重（mstack 自己的上限；Claude Code 还有更高的字符上限，超了会截断）。
- mstack skill 目录里出现 SKILL.md、`references/`、`scripts/` 以外的条目：标出来。第三方 skill 不必遵守这个布局。
- `scripts/` 里有需要网络安装的依赖、或二进制：回到 SKILL.md 第 4 步的装前规则，不要在这次审计里执行它。

## 5. 冲突

- 两条 description 用了同一句用户会说的话（"review"、"小心点"、"测一下" 这类）：只留一个，另一个停用。两个路由器同时注入"先用我"时，模型会选错。
- 两个 PreToolUse 钩子匹配同一个工具名：文档写明它们会并行跑。把两边的脚本路径和决定（ask 还是 deny）列出来。m-guard 自己的钩子若没装，不要把它算进去。
- 两个 MCP server 暴露同名工具：标出来，留一个。

## 6. 内容红旗（抽样读，不执行）

打开每个新 skill 的 SKILL.md 和它点名的脚本，只搜索这些意图：把环境变量或对话内容发到仓库以外、要求关掉权限提示、`curl|sh` 一类远程拉码再执行。命中则建议卸掉，并写出文件路径。不要为了"看看会不会"而运行那段脚本。

## 7. 记下

一行：留了什么、停了什么、版本或 commit、怎么卸（删哪个目录、或插件文档里的卸载方式）。卸载命令只写你在该项目 README 里看到的，不要编。
