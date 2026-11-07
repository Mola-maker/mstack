# Decisions

- Candidate patches cluster on exact diff text. Near-duplicate clustering was described in the papers and is not what §11 specifies. Newline differences and a git `index <sha>..<sha>` header are ignored so metadata does not split one patch. Any other difference, including whitespace inside a hunk, is a different cluster.
- A strict majority is the leading patch, not a pass. The different-family verifier still sees every candidate. Agreement alone does not prove correctness.
- Own subagents are the default. "Orca when it is on PATH" is narrowed to two cases: another vendor's agent, or a worktree a human will keep using.
- Judge family means a different vendor family (claude, gpt, gemini, deepseek, kimi…), not a different tier of one vendor. Tiers inside Claude were all that pstack's panel varied (research/round3/pstack-craft.md §3.1). If no free family exists, the verdict is marked `same-family` and counts as weaker evidence.
- DSH workflow and teammates cannot take a cwd, so isolated edits go to `subagent` or to a worktree the lead made. The opt-in preset keeps `subagent` on for that reason (dsh/mstack-team/README.md).
