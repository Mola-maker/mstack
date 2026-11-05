# mstack

[![check](https://github.com/Mola-maker/mstack/actions/workflows/check.yml/badge.svg)](https://github.com/Mola-maker/mstack/actions/workflows/check.yml)

mstack 是 Mola-maker 的个人 agent 工作流技能栈：把 superpowers、gstack、pstack、oh-my-claudecode（OMC）四套 skill 去重、合并、按个人使用习惯重写成 **16 个互不重叠的 skill**。同一份 `skills/` 目录同时供 Claude Code（plugin）、DSH（`~/.dsh/skills`）和 Codex 使用。

![mstack demo](assets/demo.gif)

（[MP4 版](assets/demo.mp4) · 源码在 `demo/`，Remotion：`cd demo && npm i && npm run render`）

设计约束（详见 [FRAMEWORK.md](FRAMEWORK.md)）：短 prompt 也能接得上（`m-start` 总入口读 `.mstack/` 状态续干）、每个 SKILL.md ≤150 行、长跑任务必须写 closeout、同一个错误连错 3 次就停。

## 16 个 skill 一览

| skill | 说明（来自 frontmatter） |
|---|---|
| `m-start` | 总入口：读 `.mstack/` 状态选 skill、恢复未完成的工作，"继续/开工"这类短 prompt 也能路由 |
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
| `m-team` | 会进化的 agent team：开放式大预算任务交给按轮次重组的团队，supervisor 每轮诊断卡点、重设角色与知识流向 |

## 安装

### Claude Code

方式一（GitHub marketplace）：

```sh
claude plugin marketplace add Mola-maker/mstack
claude plugin install mstack@mstack
```

方式二（本地 plugin marketplace）：

```sh
claude plugin marketplace add /path/to/mstack
claude plugin install mstack@mstack
```

方式三（直接软链 skills 到个人目录）：

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

作者机器上的实际做法（2026-11-04，细节和理由见 [docs/migration.md](docs/migration.md)）：

- superpowers：整体停用（`claude plugin disable superpowers@claude-plugins-official`）。
- OMC：保留它的 agents、MCP 工具（state / notepad）和 hooks；关掉关键词触发和 persistent-mode（`settings.json` 的 `env.OMC_SKIP_HOOKS=keyword-detector,persistent-mode`）；全局 CLAUDE.md 写明工作流先走 mstack。
- 注意：用户级 `settings.json` 的 `skillOverrides` **对插件 skill 不生效**，没法单独隐藏 OMC 的某个 skill。

## 验证

```sh
node scripts/check.mjs                       # FRAMEWORK.md §8 验收：16 个 skill、6 节结构、≤150 行、frontmatter 合法、无上游引用
claude plugin validate .                     # 插件清单
claude -p "列出所有以 mstack: 开头的 skill"    # 真实加载：应列出 16 个
```

CI（`.github/workflows/check.yml`）在每次 push 时跑前两类检查。有 `.sources/`（上游原文，不入库）时 `check.mjs` 还会检查 source-map 覆盖率和"连续 3 行雷同"。

## 怎么造出来的

主会话（Claude）写 [FRAMEWORK.md](FRAMEWORK.md) 规格和每个 worker 的任务书（`tasks/w*.md`），用 `tasks/dispatch.sh` 把任务派给 DSH headless worker（WSL，`mola-cli` profile，magpie 路由 `group/smart-split`）并行写 skill，主会话再审查、修正、跑验收。改 skill 时照这个流程：改规格 → 派 worker 或直接改 → `check.mjs` → push → `claude plugin marketplace update mstack && claude plugin update mstack@mstack`。

## 仓库结构

```
.claude-plugin/              plugin.json（插件清单）+ marketplace.json（本仓库即 marketplace）
skills/<name>/SKILL.md       16 个 skill（≤150 行，细节放 references/）
FRAMEWORK.md                 规格：画像 → 约束、来源映射、格式、共享约定、验收标准、§9 m-team
docs/source-map.md           每个来源文件 → 归入哪个 m-skill
docs/migration.md            与 superpowers / OMC 共存的做法
scripts/check.mjs            验收脚本
tasks/                       构建记录：DSH worker 任务书与分派脚本
reviews/                     独立验收记录（DSH reviewer 的 findings 与修复）
demo/ · assets/              Remotion 演示动画源码与渲染产物
CHANGELOG.md · NOTICE.md · LICENSE
```

MIT License（[LICENSE](LICENSE)）；上游致谢见 [NOTICE.md](NOTICE.md)。
