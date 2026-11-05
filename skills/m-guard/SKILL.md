---
name: m-guard
description: 上安全护栏：破坏性命令警告、目录冻结编辑、插件/skill 装前体检、死循环刹车，外加 Mola 自己的已知陷阱。Use when the user says "be careful / 小心点 / 冻结这个目录 / 这个插件安全吗 / 死循环了", or before touching prod / live systems.
whenToUse: Add safety guardrails before risky work: warn on destructive commands, freeze edits to a directory, vet third-party plugins before install, brake on repeated-failure loops, and avoid Mola's own known traps.
---

# m-guard — 安全护栏与陷阱

开工前或进生产环境前，主动上三道可撤的保护，并替用户挡住已知会翻车的坑。护栏是"提醒/冻结"，不是权限边界：Bash 命令仍能绕过目录冻结，所以它防的是手滑不是恶意。真正致命的动作（递归删 `/`/`~`、force-push 默认分支）要硬拒。

## When to use / not use

**用**：碰生产或共享环境前；用户说"小心点 / safety / 冻结这个目录 / 只改这个模块"；要装第三方插件/skill/MCP/二进制；同一错误连续报错、工具调用来回空转。

**不用，转给别的 m-skill**：
- 只是普通 feature dev、用户自建小 repo → 默认不上护栏，别给每个会话都套冻结。
- 要排查"为什么这次会话变慢/变贵/没按计划走" → 转 `m-review` 或专门诊断，不是护栏。
- 死循环原因是代码逻辑 bug → 报警后转 `m-debug` 换假设，护栏只在"重试同一步"时踩刹车。

## Procedure

1. **破坏性命令警示**：跑 Bash/PowerShell 前识别这些模式并先征询可覆盖的警告——`rm -rf/-r`、`DROP/TRUNCATE TABLE|DATABASE`、`git push --force`、`git reset --hard`、`git checkout/restore .`、`kubectl delete`、`docker rm -f`/`system prune`。Windows 另有 `Remove-Item/del/rd -Recurse|-Force`、`rd /s`、`Clear-Disk`、`iex`。安全例外（免警告）：删 `node_modules`、`.next`、`dist`、`build`、`__pycache__`、`.cache`、`coverage` 这类产物目录。**硬拒**：`rm -r`/`-R` 直接作用于 `/`、`~`、`$HOME`；force-push 到默认分支（`--force-with-lease` 除外）。
2. **目录冻结**（可选）：问用户哪个目录，把 Edit/Write 限定在该路径内，范围外 block（不是 warn）；路径要 resolve 真实绝对路径，尾部 `/` 防 `/src` 误匹配 `/src-old`。Read/Bash/Grep 不受限——它防的是误改，不是安全边界。`/unfreeze` 或换会话解除。
3. **死循环刹车**：同一错误连续 3 次 → 停，别再第 4 次（原则 9）；记录已试假设，转 `m-debug` 或上报，而不是重跑。
4. **插件装前体检**（装任何第三方 skill/MCP/二进制前）：先查 `gh api repos/<owner>/<repo>` 看 stars/pushed_at/license/archived，优先官方源；读 `package.json` 的 pre/postinstall、`cordis.patch.yml` 要插的行、MCP 的启动命令；二进制先对 SHA-256 再跑；skill 逐篇读 SKILL.md 和脚本，拒掉外传数据、关安全提示、远程拉码执行的内容。先在 throwaway profile 试跑一次，再进真实环境，并记录版本与回滚路径。
5. **冲突体检**：装新插件/skill 前先 `--dump-config` 看是否和已装的干同一件事——两个工具干一个活会让模型犯迷糊，只留一个。
6. Mola 的现成坑读 `references/known-traps.md`，匹配到就照做。

## Output

- 被拦或警告的动作清单 + 用户的处理决定；冻结目录的当前边界与解除方式。
- 插件体检结论：选了什么版本、为什么、它跑什么、做了哪些检查及结果、怎么卸载。

## Stop conditions

- 致命形状（`rm -r` 根目录、force-push 默认分支）→ 硬拒，不提供"继续"。
- 体检发现插件要外传数据 / 关安全提示 / 拉远程码 → 拒绝安装并说明。
- 用户被反复问同一件事（每次 ≤1 个问题）→ 停下来把已做决定落盘，别连续发问。

## Harness notes

- Claude Code：`hookSpecificOutput.permissionDecision` 要嵌套在 `hookSpecificOutput` 下，顶层不生效；PowerShell 硬拦需 `.claude/settings.json` 的 deny 规则。
- DSH：无 PreToolUse hook，护栏靠本 skill 的"动手前自查"落地；目录冻结用自觉 + `todo_write` 圈范围。
- Codex：`codex exec` 一次性执行，护栏在提示词里显式声明边界，没有交互式确认。
