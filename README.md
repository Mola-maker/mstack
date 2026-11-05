# mstack

mstack 是 Mola-maker 的个人 agent 工作流技能栈：把 superpowers、gstack、pstack、oh-my-claudecode（OMC）四套 skill 去重、合并、按个人使用习惯重写成 **15 个互不重叠的 skill**。同一份 `skills/` 目录同时供 Claude Code（plugin）、DSH（`~/.dsh/skills`）和 Codex 使用。

设计约束（详见 [FRAMEWORK.md](FRAMEWORK.md)）：短 prompt 也能接得上（`mstack` 总入口读 `.mstack/` 状态续干）、每个 SKILL.md ≤150 行、长跑任务必须写 closeout、同一个错误连错 3 次就停。

## 15 个 skill 一览

| skill | 说明（来自 frontmatter） |
|---|---|
| `mstack` | 总入口：读 `.mstack/` 状态选 skill、恢复未完成的工作，"继续/开工"这类短 prompt 也能路由 |
| `m-think` | 动手前想清楚：攻击前提、一次最多问 3 个带默认值的问题、产出设计稿 |
| `m-plan` | 把设计拆成有序、可验证的步骤，每步写清验证方式，并由独立 critic 复核 |
| `m-goal` | 长跑目标循环：goal 文件、检查点、停止条件，任何退出路径都强制写 closeout |
| `m-dispatch` | 并行分派到 Claude subagent / DSH headless / Codex，各自隔离工作区，最后合并并独立验证 |
| `m-verify` | 没有新鲜证据不说"完成"：跑真测试、读真实输出、测行为不测实现 |
| `m-debug` | 复现 → 竞争假设 → 找根因 → 回归测试；连错 3 次停下换思路 |
| `m-review` | 多角度并行 review，写的人不审自己的代码；收到 review 意见先验证再改 |
| `m-ship` | 同步上游 → 真测试 → 独立 review → 写 PR 文档 → 开 PR → 盯 CI 和评论 |
| `m-qa` | 网页真机验收：起服务、Playwright 走真实流程、截图对比、性能与设计问题，带证据汇报 |
| `m-research` | 多渠道调研：≥3 个独立渠道并行、去重交叉验证、每个关键论断标注来源 |
| `m-handoff` | 存档 / 恢复上下文到 `.mstack/handoff.md`：compact 前、换模型前、会话结束时必写 |
| `m-learn` | 复盘沉淀：post-mortem 进 lessons，可复用流程进候选 SKILL.md，事实进 memory |
| `m-deslop` | 删 AI 味：多余代码、注释、抽象、废话，先保行为再做减法 |
| `m-guard` | 安全护栏 + 插件冲突体检 + 死循环刹车 + Mola 的已知陷阱清单 |

## 安装

### Claude Code

方式一（本地 plugin marketplace）：

```sh
claude plugin marketplace add /path/to/mstack
claude plugin install mstack@mstack
```

方式二（直接软链 skills 到个人目录）：

```sh
for d in /path/to/mstack/skills/*/; do
  ln -s "$d" ~/.claude/skills/"$(basename "$d")"
done
```

### DSH

把每个 skill 软链进 `~/.dsh/skills`：

```sh
for d in /path/to/mstack/skills/*/; do
  ln -s "$d" ~/.dsh/skills/"$(basename "$d")"
done
```

### Codex

Codex 需要实体文件，复制而不是软链：

```sh
mkdir -p ~/.codex/skills
cp -r /path/to/mstack/skills/* ~/.codex/skills/
```

## 和原插件怎么共存

装了 mstack 后，superpowers 建议整体停用，OMC 只保留 MCP 工具、停掉重叠的 skill。具体建议和理由见 [docs/migration.md](docs/migration.md)——那里只有建议，不会替你改任何配置。

## 仓库结构

```
.claude-plugin/plugin.json   Claude Code plugin 清单
skills/<name>/SKILL.md       15 个 skill（≤150 行，细节放 references/）
docs/source-map.md           每个来源 skill → 归入哪个 m-skill
docs/migration.md            停用重叠插件的建议
NOTICE.md                    上游项目致谢与许可证
```

许可证见 [NOTICE.md](NOTICE.md)。
