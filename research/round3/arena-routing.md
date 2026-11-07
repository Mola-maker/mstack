# Arena-based model routing (round 3)

Snapshot: all Arena pages fetched 2026-11-06 (pages show "Nov 6, 2026"). Scores are Elo-style with ±CI; "(Prelim)" = provisional.
Method: WebFetch on arena.ai category pages (`/leaderboard/text/<slug>`, `/leaderboard/webdev`, `/vision`, `/search`, `/document`, `/leaderboard` Agent) and the HF dataset `lmarena-ai/leaderboard-dataset`. The values are transcribed by a summarizing model, not checked against raw HTML. Treat rank ±3 as noise.

## 0. Source caveats

- lmarena.ai 301-redirects to arena.ai (rebranded Jan 2026). Use arena.ai.
- Ranks differ between arena.ai and HF `text` config for the same models (e.g., Kimi K3 #19 vs #25, Sonnet 5.5 #45 vs #33). Scores agree within CI. HF split is probably a different style-control view. Unverified which one is canonical.
- Several WebSearch results (SEO sites: "Claude Mythos 5 1531", "Gemini 4 Carbon 1528 on Benchleader") conflict with the primary pages. Discarded.
- The "Agent" board (arena.ai/leaderboard) is an IPS metric, not Elo. Not comparable to Text scores.
- Category list on arena.ai Text: Overall, Expert, Occupational, Math, Instruction Following, Multi-Turn, Creative Writing, Coding, Hard Prompts, Hard Prompts (English), +more (29 total). **No "Longer Query" filter seen; not verified.** No Chinese-language board fetched; "Chinese writing" below is a proxy.

## 1. Leaderboards (top picks, Nov 6, 2026)

| Board | #1 | #2 | #3 | Notes |
|---|---|---|---|---|
| Text Overall | Gemini 4 Carbon (High) 1526 (Prelim) | Gemini 4 Argon (High) 1523 | Muse Wonder (Max) 1513 | Claude Opus 5.5 (High) #4 1505 |
| Coding | Gemini 4 Carbon (High) 1568 (Prelim) | Gemini 4 Argon 1553 | Claude Fable 5 (High) 1551 | Opus 5.5 (High) #5 1549; Opus 4.7 (High) 1551 |
| Hard Prompts | Gemini 4 Carbon (High) 1547 (Prelim) | Gemini 4 Argon 1546 | Muse Wonder (Max) 1533 | Opus 5.5 (High) #4 1531 |
| Instruction Following | Gemini 4 Argon (High) 1528 | Gemini 4 Carbon 1524 (Prelim) | Claude Opus 5.5 (High) 1518 | |
| Math | Gemini 4 Argon (High) 1535 | Claude Fable 5.1 (Max) 1524 | Claude Fable 5 (High) 1521 | Gemini 3.8 Flash (High) #5 1517 (Prelim) |
| Multi-Turn | Gemini 4 Carbon (High) 1560 (Prelim) | Gemini 4 Argon 1540 | Muse Wonder (Max) 1525 | Fable 5 (High) #4 1517 |
| Creative Writing | Gemini 4 Argon (High) 1525 | Claude Opus 5.5 (High) 1518 | Gemini 4 Carbon 1514 (Prelim) | Fable 5 (High) #4 1502 |
| WebDev / Code Arena | Claude Opus 5.5 (Max) 1814 | Claude Sonnet 5.5 (xHigh) 1772 | GPT-6 Astra (Max) 1770 | Gemini 4 Carbon #4 1767 (Prelim); Kimi K3.1 Pro #10 1684 (Prelim) |
| Vision | Claude Fable 5 (High) 1309 | Qwen3.8-Max 1300 | Claude Opus 4.7 1299 | Opus 5.5 (High) #6 1296 |
| Search (web-augmented) | Qwen3.8-Max 1260 | GPT-5.6 Sol (xHigh) 1259 | Claude Opus 4.6 (Search) 1252 | Opus 5 (High) #5 1240 |
| Document | Claude Fable 5.1 (Max) 1516 | Claude Opus 5 (High) 1508 | Claude Opus 4.6 (High) 1507 | 46 models, 540k votes |
| Agent (IPS, not Elo) | Claude Opus 5.5 (Max) 20.1% | Gemini 4 Carbon (High) 16.7% | Claude Sonnet 5.5 (Max) 15.4% | Date not shown on page |

Votes and model counts: Text 9.14M votes / 419 models; WebDev ~1.0M / 154; Vision 1.58M / 167; Search and Document as listed. Coding and Creative Writing views share the Text pool.

## 2. Gateway models → Arena entries

Ranks: arena.ai text page (A) and HF text config (H). "—" = not in visible top rows (arena.ai shows ranks 1–153; HF shows 1–100).

| Gateway id | Arena entry | Text rank (A / H) | Score | Other boards |
|---|---|---|---|---|
| auto/claude-opus-5-5 | Claude Opus 5.5 (High); Max variant on WebDev | 4 / 4 | 1505 / 1512 | WebDev #1 (Max) 1814; Coding #5; Hard #4; Vision #6 |
| auto/claude-sonnet-5-5 | Claude Sonnet 5.5 (xHigh) | 45 / 33 | 1473 / 1469 | WebDev #2 1772 |
| auto/gpt-6-luna | GPT-6 Luna (Max) | 97 / — | 1440 | not in top 10 anywhere |
| auto/kimi-k3 | Kimi K3 (Max) | 19 / 25 | 1488 / 1475 | WebDev top 15 shows Kimi K3.1 Pro (#10 Prelim) — K3 vs K3.1 mapping unverified |
| auto/deepseek-v4-pro | DeepSeek-V4-Pro (plus High/Preview variants) | 64 / 49 | 1458 / 1451 | not in WebDev top 15 |
| auto/deepseek-v4-flash | DeepSeek-V4-Flash | 104 / 91 | 1436 / 1432 | |
| auto/gemini-3.8-flash | Gemini 3.8 Flash (High) | 9 / 8 | 1498 / 1500 (Prelim) | Hard #10 1519; Math #5 1517 |
| auto/minimax-m3 | MiniMax-M3 | 103 / 98 | 1436 / 1428 | |
| auto/minimax-m3.1-flash | not found in visible rows | — | — | **Missing or below visible rank; unverified** |
| grok-4.7 | Grok 4.7 (xHigh) | 93 / — | 1442 | |
| glm-5.3 | GLM-5.3 (Max) (also GLM-5.3-Flash #28–33) | 26 / 24 | 1482 / 1476 | |
| deepseek/deepseek-flash (dsh direct) | DeepSeek-V4.1-Flash (Max) | HF #37 | — | **Do not use direct** (CLAUDE.md: never `deepseek/*`; 402 risk) |

Routing groups (`group/smart-split`, `group/claude-cheap`, `group/claude-ultra`): no Arena entry. Their backing model is not stated in `magpie-routes.txt`. Treat as unknown until magpie shows the underlying model.

## 3. Task → model (coding-agent work)

Score notes: "Arena" = category score above. Only the gateway ids can be used. Cost tiers are rough and unverified (no pricing fetched).

| Task | 1st | 2nd | Budget | Evidence (Arena) | Cost tier |
|---|---|---|---|---|---|
| Planning / architecture | auto/claude-opus-5-5 | auto/gemini-3.8-flash* | auto/deepseek-v4-pro | Hard #4 1531; Text #4 1505; Multi-Turn strong for Gemini 4 but not gateway | high / mid / low |
| Implementation | auto/claude-opus-5-5 | auto/claude-sonnet-5-5 | auto/deepseek-v4-pro | WebDev #1 1814, #2 Sonnet 5.5 1772; Coding Opus 5.5 #5 1549 | high / mid / low |
| Debugging | auto/claude-opus-5-5 | auto/claude-sonnet-5-5 | auto/gemini-3.8-flash | Coding #5 1549; Math #5 1517 (Flash) | high / mid / low |
| Code review | auto/claude-opus-5-5 | auto/gemini-3.8-flash* | auto/deepseek-v4-pro | IF #3 1518 (Opus 5.5); Gemini 4 leads IF (not on gateway) | high / mid / low |
| Test writing | auto/claude-sonnet-5-5 | auto/claude-opus-5-5 | auto/deepseek-v4-flash | **Inferred** from Coding + WebDev; no test-specific board | mid / high / low |
| Frontend / webdev | auto/claude-opus-5-5 | auto/claude-sonnet-5-5 | auto/kimi-k3 | WebDev #1, #2; Kimi K3 Text #19 (WebDev K3 not confirmed) | high / mid / mid |
| Long-context reading | auto/claude-opus-5-5 | auto/gemini-3.8-flash* | auto/deepseek-v4-pro | Document #2 Opus 5 1508; no "longer query" board found | high / mid / low |
| Research / search | group/smart-split (backing model unknown) | auto/claude-opus-5-5 | auto/gemini-3.8-flash* | Search board: no gateway model in top 10; Opus 5 #5 1240 | — |
| Cheap fan-out exploration | auto/gemini-3.8-flash* | auto/deepseek-v4-flash | auto/minimax-m3 | Flash Text #8–9 1498–1500 (Prelim); DS-V4-Flash #91–104 1436 | low / low / low |
| Chinese writing | auto/kimi-k3 | auto/deepseek-v4-pro | auto/glm-5.3 | **Proxy only**: Text ranks 19 / 49–64 / 24; no Chinese board fetched | mid |
| Vision / screenshots | auto/claude-opus-5-5 | auto/gemini-3.8-flash* | — | Vision #6 Opus 5.5 1296; no gateway model in vision top 5 except Opus 5.5 | high |

`*` Gemini 3.8 Flash on Vision is not in the top 10 (Gemini 3.7 Flash #7 1294 Prelim). Its vision score is therefore unverified.

## 4. Per-family prompt adapter rules

Sources are the vendor docs fetched on 2026-11-06. Lines marked "not in source" were checked and not covered by the fetched page.

### 4.1 Anthropic Claude (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1)
Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices (plus per-model pages linked there).
- **Structure:** XML tags for mixed instructions/context/examples (`<instructions>`, `<context>`, `<input>`). For long context: put documents first, wrap each in `<document>` with `<source>` subtags, put the query last (section "Long context prompting").
- **System prompt:** role in one sentence is enough; the page's "Tool use" note says "Use this tool when..." is preferred over "CRITICAL: MUST" (overtriggering on Opus 4.5+).
- **Effort:** `output_config.effort` (low / high / max; xhigh on Opus 5.5 routes). `budget_tokens` returns 400 on 4.7+. Use effort as the throttle, not prompt text.
- **Prefill:** do not use assistant prefill. Migrate to direct "Respond directly without preamble" or XML-tagged output.
- **Verbosity:** Opus 5 page has its own "response length and verbosity" section. Expect Opus 5 to be more verbose than prior models; say the length you want.
- **Tools:** Opus 4.6 does more upfront exploration at high effort; remove "if in doubt, use X" phrasing.
- **Language:** not checked.

### 4.2 OpenAI GPT-6 family (Astra, Sol, Terra, Luna)
Source: https://developers.openai.com/api/docs/guides/prompt-guidance (covers GPT-6 Astra/Sol/Terra/Luna only; GPT-5.x only as migration comparisons).
- **Effort:** Astra and Sol reject `reasoning_effort: none`. Terra, Sol, Luna support `none`. Start Terra at `medium`. Keep `reasoning.effort` unchanged per request to preserve the prompt-cache prefix; change mid-conversation via `configuration_update`.
- **Tools:** Astra, Sol, Terra require the Responses API for tool calling. Sol and Luna need `reasoning_effort: "none"` for function calling in Chat Completions.
- **Agentic:** the guide says to "persist until the user's intended goal is complete", except for destructive or irreversible actions, and to ask for approval only after preparing a reviewable result.
- **Style:** Astra leans to lists and tables; add "clear, concise paragraphs, each developing one main idea" to override.
- **Not in source:** system vs developer role placement, XML/delimiter advice, verbosity parameter.

### 4.3 Google Gemini (3.x; Gemini 4 Carbon / Argon)
Source: https://aistudio.google.com/docs/prompting-strategies (redirect from ai.google.dev). Covers Gemini 2.5 and 3 in detail; Gemini 4 and 3.6+ only in a parameter note.
- **Placement:** constraints and persona first (system instruction or start of user prompt). For long inputs, put context first and the task last, with a bridge like "Based on the information above...".
- **Delimiters:** XML-style (`<context>`, `<task>`) or Markdown headings. Pick one format and keep it consistent within a prompt.
- **Sampling:** Gemini 4 and 3.6+ ignore `temperature`, `top_p`, `top_k`. Remove them from request config (don't just leave defaults).
- **Verbosity:** default is "direct and efficient". Ask for detail explicitly. Gemini 3 Flash has a "strictly grounded" clause option.
- **Grounding:** enable Google Search for recent or obscure facts; code execution for arithmetic and counting.
- **Thinking controls:** `thinking_level` / `thinking_budget` are not on this page; use the separate thinking docs (not checked).

### 4.4 DeepSeek (V4 Pro, V4 Flash)
Source: https://api-docs.deepseek.com/guides/thinking_mode.
- **Toggle:** `thinking: {type: enabled|disabled}` (via `extra_body` in OpenAI SDK). Default: enabled, effort high.
- **Effort:** `reasoning_effort` low / high / max. Mapping: minimal and low to low; medium, high, xhigh to high; max to max.
- **Sampling:** `temperature`, `presence_penalty`, `frequency_penalty` are silently ignored in thinking mode. `top_p` is fixed (V4 Pro: 0.95 with tools, 1.0 without).
- **Tool quirk:** with `tools` present, `reasoning_content` must be passed back on every later request or the API returns 400.
- **Prompting advice:** none on the thinking page. Use the general DeepSeek prompting guide (not fetched).
- Do not route through `deepseek/*` direct (CLAUDE.md).

### 4.5 Moonshot Kimi (K3)
Source: https://platform.kimi.ai/docs/guide/prompt-best-practice (fetched). Thin.
- **System:** put role in a `system` message in `messages`.
- **Structure:** triple quotes, XML tags, or section headings to delimit input. Outline the task as numbered steps.
- **Length:** specify paragraphs or bullet counts, not word counts ("word counts are imprecise").
- **Language:** "Moonshot AI" is a proper noun; don't translate it in system prompts.
- **Not in source:** thinking/effort controls, tool-calling notes, temperature. The page says `llms.txt` lists more; not checked.

### 4.6 MiniMax (M3.1-Flash; M3)
Source: https://platform.minimax.io/docs/guides/text-generation (only the M3.1-Flash thinking section was found).
- **Thinking:** M3.1-Flash thinking cannot be turned off. `thinking: disabled` or `effort: none` returns 400. Lower `effort` instead. Omitting effort defaults to `max`.
- **Field by protocol:** Anthropic-compatible `output_config.effort`; OpenAI-compatible `reasoning_effort`; Responses API `reasoning.effort`. Levels: low, medium, high, xhigh, max.
- **Output:** on OpenAI-compatible, thinking is in `reasoning_content` and `content` holds only the answer (no `<think>` parsing).
- **Conflict:** `magpie-routes.txt` lists `auto/minimax-m3` as `none/high`, which contradicts "cannot disable" for M3.1-Flash. Assume M3 may differ; verify.
- **Not in source:** system prompt defaults, temperature/top_p, tool-calling, structure advice.

### 4.7 xAI Grok (grok-4.7)
Source: https://docs.x.ai/developers/model-capabilities/text/reasoning (the prompt-engineering URL returned 404 and was not used).
- **Effort:** `reasoning.effort` low / medium / high / xhigh (xhigh on grok-4.6+; treated as high on 4.5). Default high. Thinking cannot be turned off.
- **Unsupported:** `presencePenalty`, `frequencyPenalty`, `stop` error on reasoning models.
- **Tool quirk:** grok-4.7 returns encrypted reasoning on every Responses call; pass reasoning items back unchanged in the next `input`.
- **Not in source:** structure (XML vs Markdown), system-prompt guidance, tool-calling section.

### 4.8 Zhipu GLM (GLM-5 / 5.3)
Source: https://docs.z.ai/guides/llm/glm-5 (fetched). GLM-4.5 page also checked.
- **Thinking:** `thinking: {type: enabled|disabled}`, default enabled. GLM-4.5 page: disable for simple retrieval or translation; keep default for moderate work; max for hard math or coding.
- **Output:** `reasoning_content` streamed separately from `content`.
- **Sampling:** examples use temperature 1.0 and 0.6 with no guidance; top_p not discussed.
- **Not in source:** effort levels, structure advice, tool-call details, GLM-5.3 specifics.

## 5. Verified vs unverified

- **Verified (primary page, fetched 2026-11-06):** Text overall top 10; all category tops listed in section 1; WebDev top 15; Vision/Search/Document top 10; Agent top 10; gateway-to-arena mapping for 9 of 11 gateway ids (the two missing are minimax-m3.1-flash and grok-4.7 for HF only; grok-4.7 is on arena.ai text at #93).
- **Partly verified:** HF vs arena.ai ranks (differ; see section 0). Gemini 4 and some "Preliminary" scores (not final).
- **Unverified:** Longer Query, Chinese, and Kimi K3-vs-K3.1 mapping; minimax-m3.1-flash presence; all cost tiers (no pricing fetched); Anthropic language notes; OpenAI developer/system role and XML advice; Gemini thinking_level values; Kimi thinking and tool notes; GLM effort parameters; xAI structure guidance.
- **Not done:** test-writing and frontend picks are inferred from general boards, not a dedicated board. The "Coding" board for DeepSeek/Kimi/GLM/MiniMax was not fetched for their gateway entries.
