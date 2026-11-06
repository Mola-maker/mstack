---
name: m-qa
description: "QA via the project verify skill; report clean, changed, or blocked. Use for 测一下页面/QA/验收/验证skill."
whenToUse: "The user wants a running app tested, or a project-local verify skill created or updated under .claude/skills/verify/."
---

# m-qa

测试正在运行的产品，并在项目里留下一份可重复使用的驱动说明。驱动放在 `.claude/skills/verify/`。报告的结论只能是 `clean`、`changed` 或 `blocked` 三者之一。默认只报告，不改产品代码。

## When to use / not use

**用**："测一下 / 验收 / QA / 有没有 bug"，某个页面、CLI 或服务可以跑了，或这个仓库还没有脚本化的方式去驱动真实界面。

**不用，转给别的 m-skill**：
- 看 diff 对不对、对规范 → `m-review`。
- 跑仓库自己的测试、基线、diff 扫描 → `m-verify`。
- 没有可运行界面的逻辑 bug → `m-debug`。
- `.claude/skills/verify/SKILL.md` 已经存在时，不要再写第二份驱动；维护这一份。

## Procedure

1. **定范围。** 目标是 URL 还是本地命令、哪些流程、做到多深。默认 report-only。只有用户明确说"测并修"时才改产品代码。
2. **生成或维护驱动。** 按 `references/verify-skill.md`。没有这份 skill 就根据仓库写出来（Launch / Doctor / Drive / Evidence / Cleanup，外加 `features/`）。frontmatter 的 `name` 写 `<repo>-verify`（`<repo>` 是仓库目录名），不要写 `verify`——那个名字会占掉 Claude Code 自带的同名入口。已经有就只改 `.claude/skills/verify/` 里面的文件。单仓里的应用若在子目录，把驱动写在那个包的 `.claude/skills/verify/`。
3. **结构检查。** `node "<this skill dir>/scripts/check-verify-skill.mjs" <项目>/.claude/skills/verify`。`<this skill dir>` 是本 SKILL.md 被加载时所在的目录（Claude Code 里显示为 skill base directory；在 mstack 仓库里是 `skills/m-qa`）。找不到这个文件就按 `references/verify-skill.md` 的章节手工核对，并在报告里写明没跑脚本。退出码不是 0 就先改驱动，不要开始报 `clean`。
4. **真的跑一遍。** 按驱动自己的 Launch → Doctor → 至少一条 feature 的 Drive → Evidence → Cleanup。清理之后，它点名的证据文件还必须在。没跑过的驱动只是草稿。
5. **按驱动测用户要的流程。** 用它写明的 harness，不要另起一套一次性脚本。探针和报告骨架在 `references/qa-checklist.md`。
6. **修复环（仅当用户要求）。** 先复现，再最小改动，再按驱动重测，一次修复一个提交。失败的尝试也要跑清理，避免端口和进程留下来。
7. **下结论。** 定义见 `references/verify-skill.md`。功能检查失败又没修好 → `blocked`，不要写成 `clean`。

## Output

- `.mstack/qa/<YYYY-MM-DD>-<slug>.md`。摘要第一行是 `verdict: clean|changed|blocked`。
- 新建或改过的 `.claude/skills/verify/**`。
- 一句中文：结论、改了哪些文件、哪些流程没测。

## Stop conditions

- 服务起不来、doctor 失败、或清理把证据删掉 → `blocked`，停。
- 维护驱动时不要改产品代码。应用行为不对就记 finding 或 `blocked`，不要借维护的名义改产品。
- 两次回滚，或改动碰到与 finding 无关、又不在驱动目录里的文件 → 停，把进度给用户。
- 同一失败连续 3 次 → 停（原则 9）。不要把旅程改弱来换通过。

## Harness notes

- Claude Code：生成的 skill 名字是 `<repo>-verify`（目录仍是 `.claude/skills/verify/`），不要设 `disable-model-invocation`（设了模型就不会调用它）。浏览器流程在驱动要求 Playwright 时用 Bash 跑。
- DSH：文件位置相同。维护时可以用 `subagent` 并行读各个 feature 文件；开车仍由当前会话按驱动的 Launch 来做。
- Codex：用 `codex exec` 跑驱动里的命令。skill 仍写到 `.claude/skills/verify/`，这样下一次 Claude Code 会话找得到。
