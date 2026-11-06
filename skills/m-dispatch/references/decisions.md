# Decisions

- Candidate patches cluster on exact diff text. Near-duplicate clustering was described in the papers and is not what §11 specifies. Newline differences and a git `index <sha>..<sha>` header are ignored so metadata does not split one patch. Any other difference, including whitespace inside a hunk, is a different cluster.
- A strict majority is the leading patch, not a pass. The different-family verifier still sees every candidate. Agreement alone does not prove correctness.
- Own subagents are the default. "Orca when it is on PATH" is narrowed to two cases: another vendor's agent, or a worktree a human will keep using.
