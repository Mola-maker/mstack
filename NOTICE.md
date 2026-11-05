# NOTICE

mstack 的 skill 改写自以下四个开源项目的 skill / workflow 文档（合并、去重后按作者的使用习惯重写）：

- **[obra/superpowers](https://github.com/obra/superpowers)** — MIT License
- **[garrytan/gstack](https://github.com/garrytan/gstack)** — MIT License
- **[michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude)**（poteto 的 pstack）— MIT License
- **[Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)**（OMC）— MIT License

mstack 是对上述项目内容的**重写（rewrite）而非复制**：所有 SKILL.md 均按 FRAMEWORK.md 的格式与约束用自己的话重新撰写，不复制来源原文（仓库内 `scripts/check.mjs` 会对照 `.sources/` 检查连续 3 行以上的雷同）。各来源文件的对应关系见 [docs/source-map.md](docs/source-map.md)。

`m-team` 另外参考了：

- **Evolving Agent Teams**（Cao, Mao, Li, Gonzalez, Stoica，UC Berkeley，[arXiv 2610.36848](https://arxiv.org/abs/2610.36848)）：会按轮次重组的团队、持久知识、产物级协作、硬门槛。
- **[stablyai/orca](https://github.com/stablyai/orca)** — MIT License：`m-dispatch` / `m-team` 的可选 Orca 后端命令取自它的 orchestration / orca-cli 指南。

感谢以上作者把这些工作公开。

mstack 本身以 MIT License 发布。
