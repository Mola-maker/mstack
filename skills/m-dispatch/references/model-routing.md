# Model routing (m-dispatch, m-team, m-review)

Read this at step 3 of m-dispatch, when m-team picks a judge, or when m-review picks a reviewer. One file holds the data: `config/model-routing.json` at the mstack repo or plugin root. `mola run` reads the same file, so what you do by hand here is what the CLI does by code. If the file is not reachable from where you run, use the table below and note it in the dispatch note.

## What the file contains

- `tasks.<kind>.picks` — magpie routes for that kind of work, best first. `evidence` says why; `unverified: true` means no dedicated leaderboard backs the pick, so treat it as a default you may override with a local result.
- `families.<name>` — `match` substrings that classify a route id, a `style` (xml, markdown, xml-or-markdown) and `rules` for writing a brief to that family. Classify a route by the first family whose `match` appears in its id (`auto/claude-opus-5-5` → claude, `group/smart-split` → group).
- The ranks come from a leaderboard snapshot dated in the file. They go stale; when your own eval disagrees with the file, your eval wins and the disagreement is a Ruling line.

## Choosing a route

1. Name the kind per subtask: plan, implement, debug, review, test, frontend, long-context, research, explore, zh-writing, vision. A subtask that fits none gets `implement` if it edits and `explore` if it only reads.
2. Take `picks[0]`. On a 402/429 or a missing route, take the next entry; do not retry the same one. When the list is spent, stop and report (m-dispatch stop conditions).
3. Never route to `deepseek/*` directly. Only `group/*` and `auto/*` are allowed.
4. Same brief on several models (a race): take one route per family from `picks`, so the candidates differ in training, not only in size.

| Kind | First pick | Next family worth trying |
|---|---|---|
| plan, review, long-context | claude-opus | gemini |
| implement, debug, test | claude-opus or sonnet | deepseek |
| frontend, vision | claude-opus | claude-sonnet / gemini |
| explore | gemini flash | deepseek flash |
| research | group/smart-split | claude-opus |
| zh-writing | kimi | deepseek |

The table is a map to the file, not a copy of it. Read the file for the exact route ids.

## Judge family

The judge of a patch, a plan or a team round must come from a family that none of its authors used. Tiers inside one family (opus versus haiku) are the same family and do not count.

1. List the family of every author route (rules above).
2. Take the `review` picks and use the first whose family is absent from that list.
3. If every family in `picks` was used by an author, use the next family in the file that is not (kimi, glm, deepseek). If you still have none, mark the verdict `same-family` in the report; it is weaker evidence and you must say so.
4. The judge sees labels and artifacts only (m-review rules).

## In plain Claude Code

The `Agent` tool accepts only Claude aliases (opus, sonnet, haiku), so only the claude picks are reachable and every candidate and judge is one family. To get a different family, send the judging through `mola run --kind review` (it picks the route and writes the family brief), through DSH (`subagent` or a `workflow` `agent()` with a magpie `provider`), or through `subagent_codex`. Name the route you used in the report. If none of these is available, the run is `same-family`: say so, score anyway, and make no claim of a team gain or a verified judgement. Never invent a route id the tool will reject.

## Adapting the brief per family

Write the brief once with the five template parts (GOAL / SCOPE / CONTEXT / VERIFY / RETURN), then change only the wrapping.

- **claude** — each part in an XML tag (`<goal>`, `<scope>`, `<context>`, `<verify>`, `<return>`). Long material first, the question last. Plain "use X when…" instead of capitals and MUST. No prefilled reply. State the length you want, because Opus-class models run long. Control depth through the route's effort, not prose.
- **gpt** — markdown headings for the five parts. Say to keep going until the goal is met, except for destructive actions. Ask for short paragraphs if you do not want lists.
- **gemini** — constraints and role first, then the long context, then the task, joined by a sentence such as "Based on the material above…". One delimiter style per prompt. Ask for detail when you need it; the default is short.
- **deepseek, kimi, glm, minimax, grok** — markdown, numbered steps, explicit output shape. Kimi: role in the system message, counts of bullets or paragraphs rather than words. DeepSeek thinks by default and ignores sampling knobs, so do not rely on temperature. The last three have `unverified` rules; keep prompts short and literal.
- **group/*** — the model behind it varies. Use neutral markdown with explicit steps and an explicit RETURN shape.

Example, claude wrapping of the template:

```
<goal>Make the 3 failing tests in tests/parse.test.mjs pass.</goal>
<scope>Read: src/parse/. Write: src/parse/tokens.mjs only.</scope>
<context>Failure text is in .mstack/dispatch/fail-1.txt.</context>
<verify>node --test "tests/*.test.mjs" → 0 failures, exit 0.</verify>
<return>Changed files; the verify command and the output you saw. Under 200 words.</return>
```

The same content for a markdown family uses `## GOAL`, `## SCOPE`… headings. Do not mix both styles in one brief.

`mola run` applies these rewrites itself. In a plain session you do it by hand; skipping the adapter costs quality, not correctness, so it is a Ruling line when you skip it for speed.
