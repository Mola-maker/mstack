# 写 skill 的清单（m-learn）

m-learn 在把一条教训写成 SKILL.md 之前读这份。普通 lesson（第一次、还没验证）不走这里。

来源里的做法是：无 skill 先跑一遍并记下借口，再写文案堵住这些借口；入库前要验证过；按 create / verify / retrieve / refine / retire 流转，并记下成功次数。下面的次数和退役数字是本仓库的默认——那些材料只说"低成功率就退役"，没有给阈值。要改阈值，写在该条记录里。

## 够不够格

- 同一 key 至少 2 次，并且下面的复跑通过，才写成 skill。用户点名要 skill 时，次数可以不满 2，验证不能省。
- 证据只来自一个项目：记录放该项目 `.mstack/learnings/<slug>.md`，不放进共享 skill 目录。
- 没跑过基线的草稿停在 create，不检索。

## RED-GREEN

1. **RED。** 不加载这份 skill，跑一个会踩这个坑的场景。记下 agent 用来开脱的原话（跳过步骤、自称完成但没有命令输出、用"以后再补"带过）。保存输出位置。
2. **GREEN。** 只写能堵住这些原话的句子。每一句借口都能指到 skill 里的一句。不要先写一篇总论再盼它生效。
3. **复跑。** 同一场景，加载 skill。通过：不再出现记下的借口，并且做了那条规则要求的动作。
4. **补洞。** 复跑冒出新借口：把原话写进文案，再跑一次。每一轮留三条证据：借口原话、挡住它的句子、复跑结果放在哪。

## 记录

项目内用 `.mstack/learnings/<slug>.md`，开头固定这些字段：

```markdown
# <slug>
- state: create
- scope: project
- trigger: <一句话，检索靠它>
- seen: <次数；每处一次：日期 + 文件或会话>
- baseline_excuse: <原话，或 "not run">
- blocking_line: <skill 里挡住这句借口的句子，或 "none">
- rerun: <pass/fail + 输出位置，或 "not run">
- uses: 0/0
- retire_rule: attempts>=4 且成功不到一半，或连续 3 次失败
```

`uses` 写成 `成功次数/调用次数`。每次 retrieve 分母加一；按规则做成，分子加一。改的是这个文件，不是聊天记录。

## 状态怎么走

- **create** — 草稿在，基线还没跑，或复跑还没过。不检索。
- **verify** — `baseline_excuse`、`blocking_line`、`rerun: pass` 都有。这时才允许检索。
- **retrieve** — 触发词对得上才加载。用一次就更新 `uses`。
- **refine** — 检索之后又失败。在记录里写下哪里失败、为什么、下次要看什么，改文案，把 state 放回 create，用同一场景再跑基线。没复跑不能回到 verify。
- **retire** — 命中该条的 `retire_rule`。标 retire，以后不加载。文件不删，次数留着。

共享目录（会进以后的 agent）只在 verify 通过、并且用户看过全文点头之后写入。见 m-learn 的停止条件。
