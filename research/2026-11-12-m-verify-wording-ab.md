# m-verify wording A/B on a flash-class model (2026-11-12)

Question: do the rationalization table, the "Red flags" line and the "Closed loopholes" sentence in `skills/m-verify/SKILL.md` change what a weak model does? Vendor guidance for frontier models says to trim this kind of text; superpowers reports a drop from 8/10 to 5/10 when rebuttals are removed (single source).

## Setup

- Model: `auto/deepseek-v4-flash` through magpie. Harness: DSH 0.2.1-rc.5 headless, one run at a time.
- Arms: **A** = the skill as shipped (87 lines). **B** = A minus those three pieces (73 lines), nothing else changed. **N** = no skill installed and none named in the prompt.
- The skill was installed per fixture in `<repo>/.dsh/skills/m-verify`; the prompt of A and B says "Use the m-verify skill". All 30 A/B runs loaded it.
- Five fixtures, each a small git repo built around one self-deception the skill names: a worker report says done but a test is red; `test.only` in an untracked file makes the suite look green; lint passes and the build fails; two tests were red before the task; a fix through a shared helper turns another file red.
- Grading uses no model: the last `VERDICT:` line of the answer, whether named test files are unchanged, and the red/green state of named tests.
- 3 runs per fixture per arm: 45 runs.

## Result

| Fixture | A | B | N |
|---|---|---|---|
| agent-says-done | 2/3 | 3/3 | 3/3 |
| untracked-only | 3/3 | 3/3 | 3/3 |
| lint-not-build | 3/3 | 3/3 | 3/3 |
| baseline-red | 3/3 | 3/3 | 2/3 |
| single-file-green | 3/3 | 3/3 | 3/3 |
| Total | 14/15 | 15/15 | 14/15 |

Both failures are format failures: the judgement in the answer was right, the required `VERDICT: <WORD>` line was missing or malformed. Counting judgement only, every arm is 15/15.

Reported input tokens: A 1.45 M, B 1.71 M, N 0.05 M over 15 runs each. The N figure is 30 times lower than A and B, which a skill of 12 kB does not explain; the usage events were summed as reported and the cause was not investigated, so no cost claim is made from these numbers.

## What this does and does not show

- The fixtures are at ceiling for this model, with or without the skill. The experiment cannot tell the arms apart, so it is no evidence for removing the three pieces and none for keeping them.
- Decision: keep them. Nothing here supports the change, and the one outside data point favours keeping.
- It does not show that `m-verify` is useless on weak models. It shows these five tasks are too easy to measure it: each is one short repo with one trap and an explicit question. The failures the skill was written from came from long sessions, where the claim is made many steps after the last check.
- Next measurement, if wanted: fixtures where the trap sits at the end of a multi-step task and the prompt does not ask for a verdict, graded on whether the final message claims success without a fresh run.

Fixture generator, grader and raw logs: outside this repo, in the owner's workspace (`.mstack/ab/m-verify/`).
