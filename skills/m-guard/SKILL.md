---
name: m-guard
description: "Guardrails: destructive-command checks, folder freeze, plugin vetting, loop brake, known traps. Use for 小心点/冻结目录/这插件安全吗/死循环了."
whenToUse: "Add safety guardrails before risky work: warn on destructive commands, freeze edits to a directory, vet third-party plugins before install, brake on repeated-failure loops, and avoid Mola's own known traps."
when_to_use: "Add safety guardrails before risky work: warn on destructive commands, freeze edits to a directory, vet third-party plugins before install, brake on repeated-failure loops, and avoid Mola's own known traps."
---

# m-guard — 安全护栏与陷阱

开工前或进生产环境前，给这次会话加上可撤的保护，并挡住已经翻过车的坑。没有装上 `references/hooks.md` 里的钩子时，这些保护只是你自己的行为：你不执行、你不改范围外的文件。平台不会替你拦截。装上之后，钩子也只返回 `permissionDecision: "ask"`，让用户确认，不是硬拒绝。

## When to use / not use

**用**：碰生产或共享环境前；用户说"小心点 / safety / 冻结这个目录 / 只改这个模块"；要装或刚装完第三方插件/skill/MCP/二进制；同一错误连续报错、工具调用来回空转。

**不用，转给别的 m-skill**：
- 只是普通 feature dev、用户自建小 repo → 默认不上护栏，别给每个会话都套冻结。
- 要排查"为什么这次会话变慢/变贵/没按计划走" → 不归 m-guard。m-review 只审 diff，也不归它。把最近的工具调用和耗时列给用户，让用户决定查哪一层（模型路由、钩子、还是某个循环），不要替用户选一个 skill 硬套。
- 死循环原因是代码逻辑 bug → 报警后转 `m-debug` 换假设。护栏只在"重试同一步"时踩刹车。

## Procedure

1. **破坏性命令**：跑 Bash/PowerShell 前先认这些形状，并先问一句可被用户否决的警告——`rm -rf/-r`、`DROP/TRUNCATE TABLE|DATABASE`、`git push --force`、`git reset --hard`、`git checkout/restore .`、`kubectl delete`、`docker rm -f`/`system prune`。Windows 另有 `Remove-Item/del/rd -Recurse|-Force`、`rd /s`、`Clear-Disk`、`iex`。删 `node_modules`、`.next`、`dist`、`build`、`__pycache__`、`.cache`、`coverage` 不必警告。递归删除正好打在 `/`、`~`、`$HOME`（或用户主目录本身），以及 force-push 默认分支：你自己不要执行。`--force-with-lease` 不算这一类。口头说"我不会跑"，并写明这不是平台拦截，除非用户已经按 `references/hooks.md` 装了钩子。
2. **目录冻结**（可选）：问用户允许改哪些目录，每行一个前缀写进项目根的 `.mstack/freeze`（`#` 开头是注释）。然后只在这些前缀里 Edit/Write。尾部 `/` 用来区分 `/src` 和 `/src-old`。`.mstack/` 永远不冻结：checkpoint、closeout、handoff 和冻结文件本身必须随时能写，不用把它加进清单。Read/Bash/Grep 不受限——Bash 里的 `sed` 仍能改冻结范围外的文件，所以这不是安全边界。没装钩子时，范围外不写靠你自己做到。解除：删掉该文件或删掉对应行，并告诉用户；也可以开新会话。没有 `/unfreeze` 这个命令。
3. **死循环刹车**：同一错误连续 3 次 → 停，别再第 4 次（原则 9）。记下已试假设，转 `m-debug` 或上报。
4. **装前体检**：装任何第三方 skill/MCP/二进制前，先 `gh api repos/<owner>/<repo>` 看 stars、pushed_at、license、archived，优先官方源。读 `package.json` 的 pre/postinstall、（仅 DSH）`cordis.patch.yml` 要插的行、MCP 的启动命令。二进制先对 SHA-256 再跑。skill 逐篇读 SKILL.md 和脚本，拒掉外传数据、关掉安全提示、或远程拉码执行的内容。先在 throwaway profile 试跑，再进真实环境，并记下版本和回滚办法。
5. **冲突与装后体检**：装之前先看环境里已有什么。DSH 用 `dsh --profile <p> --dump-config`（仅 DSH）。Claude Code 用 `claude plugin list`，再对具体插件用 `claude plugin details <plugin>`。两个工具干同一件事就只留一个。装完再按 `references/skill-audit.md` 做一遍（重名、frontmatter、体积、冲突）。清单是手工的，不会自动挡住安装。
6. 命中 Mola 的现成坑时读 `references/known-traps.md`，按里面的做法走。

钩子脚本（用户选择要装时才挂上）：`node "<this skill dir>/scripts/check-pretool.mjs"`，从 stdin 读一条 PreToolUse JSON。`<this skill dir>` 是本 SKILL.md 被加载时所在的目录（Claude Code 里显示为 skill base directory；在 mstack 仓库里是 `skills/m-guard`）。找不到这个文件就按第 1–2 步手工判断，并在回复里写明没跑脚本。用法和设置片段在 `references/hooks.md`。

## Output

- 你拒绝或警告过的动作，以及用户的决定。冻结边界写了哪些前缀、怎么解除。
- 钩子是否在起作用：只有在 `.claude/settings.json`、`~/.claude/settings.json` 或插件 `hooks/hooks.json` 里看到本脚本时才能说"已安装"。没查就写"未检查钩子"。不要写"已硬拦"。
- 插件体检：版本、理由、它会跑什么、检查结果、怎么卸。装后体检的重名/冲突结论。

## Stop conditions

- 递归删除 `/`、`~`、`$HOME`，或 force-push 默认分支：你不要执行，也不要给"我帮你跑"的下一步。用户仍可在自己的终端里跑；钩子装上后也只是询问。
- 体检发现外传数据、关安全提示、或拉远程码 → 拒绝安装并说明。
- 同一件事反复追问（每次最多 1 个问题）→ 停，把已经做的决定写下来。

## Harness notes

- Claude Code：可选 PreToolUse 片段见 `references/hooks.md`。`permissionDecision` 必须放在 `hookSpecificOutput` 里，并带 `hookEventName: "PreToolUse"`；写在顶层会被忽略。本仓库不默认装这个钩子。DSH 和 Codex 没有这条 PreToolUse 路径。
- DSH：没有 PreToolUse。护栏就是动手前自查。冻结只靠你遵守 `.mstack/freeze`，可用 `todo_write` 把允许的前缀记在任务列表里。
- Codex：`codex exec` 一次跑完，没有交互式确认。把"不要跑的命令"和"允许改的目录"写进提示词。
