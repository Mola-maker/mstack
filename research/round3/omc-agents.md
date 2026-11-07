# OMC agent study and proposed mstack agent set (round 3)

Sources read: `C:/Users/22494/.claude/plugins/cache/omc/oh-my-claudecode/5.7.31/agents/*.md` (19 files, 2560 lines), `docs/shared/agent-tiers.md`, `skills/ralph/SKILL.md`, `skills/plan/SKILL.md`, `src/agents/definitions.ts`, `src/agents/utils.ts`, `.claude-plugin/plugin.json`. Verified with `claude plugin details oh-my-claudecode` and `claude plugin details mstack` (Claude Code 2.1.319). Not verified: plugin-agent restrictions on `hooks` and `permissionMode` (a binary grep timed out and was stopped).

## 1. Anatomy of a strong OMC agent prompt

**Frontmatter (observed in all 19 files):** `name`, `description` (a one-line role plus the model in parentheses in some files), `model` (`opus` | `sonnet` | `haiku`), and optionally `disallowedTools: Write, Edit`. No file uses a `tools:` allowlist; read-only is enforced by deny-list only.

**Body:** one `<Agent_Prompt>` root with XML-like sections. The core set, in order:

| Section | Job | Paraphrased example (executor) |
|---|---|---|
| `Role` | Identity plus explicit "not responsible for" boundaries | "You implement; you do not design architecture, plan, or debug root causes." |
| `Why_This_Matters` | Gives the reason behind the rules, so the model generalises | "Executors that over-engineer create more work than they save." |
| `Success_Criteria` | Checkable end-state, not vibes | "Smallest viable diff; diagnostics clean; fresh build output shown." |
| `Constraints` | Hard rules, hand-off targets, escalation limits | "After 3 failed attempts, escalate to architect with full context." |
| `Investigation_Protocol` | Numbered procedure, often with a classification step | Trivial / Scoped / Complex, then explore, then one step at a time. |
| `Tool_Usage` | Which tool for which question | "ast_grep_search for structure; Grep for text; always dry-run replace." |
| `Execution_Policy` | Effort and stop rule | "Trivial: verify only the modified file. Stop when verification passes." |
| `Output_Format` | Fixed template the caller can parse | `## Changes Made` / `## Verification` / `## Summary`. |
| `Failure_Modes_To_Avoid` | Named anti-patterns, each with an "Instead:" fix | "Test hacks: modifying tests to pass instead of fixing production code." |
| `Examples` | Good/Bad pair with concrete numbers | Bad: adding a timeout parameter spawned a 200-line TimeoutConfig class. Good: 3 lines changed. |
| `Final_Checklist` | Self-audit questions before answering | "Did I verify with fresh build/test output (not assumptions)?" |
| `Final_Response_Contract` | Last message must contain the deliverable | Used in 9 files (architect, critic, debugger, verifier, tracer, security-reviewer, code-reviewer, analyst). |

Patterns worth copying:
- **Writer is not reviewer.** Verifier, writer and critic all state that verification must be a separate pass from the authoring pass.
- **Evidence over claims.** Verifier rejects "should / probably / seems to" and requires fresh command output. Output tables carry `Command | Output | Result`.
- **Circuit breaker.** Debugger, architect and executor all stop after 3 failed hypotheses and escalate. This is the same rule as mstack's own "3 failures → stop".
- **Context budget.** Explore caps reads (`limit: 100`, use symbols for files over 500 lines) and caps search rounds at 2 per path.
- **Final-message contract.** Subagent output is only what the caller receives, so the last message must hold the full report. Same point as our SubagentHandback rule.

Weaknesses to avoid copying: prompts are 90–280 lines and carry OMC-only tool names (`lsp_diagnostics`, `TodoWrite`, `.omc/plans/`). Several prompts also point to a `preamble.ts` and to agents that do not ship (the tiers doc lists `vision` and `ai-slop-cleaner`, which are absent from `agents/`).

## 2. Model tiers and why

Observed frontmatter:

- **opus (7):** analyst, architect, code-reviewer, code-simplifier, critic, planner, security-reviewer.
- **sonnet (10):** debugger, designer, document-specialist, executor, git-master, qa-tester, scientist, test-engineer, tracer, verifier.
- **haiku (2):** explore, writer.

Rationale, as the prompts themselves argue:
- **haiku** for high-volume, narrow, reversible reads. Explore returns paths and relationships, and the caller can re-check it cheaply.
- **sonnet** for bounded execution and evidence work: implementing a scoped change, reproducing a bug, running tests. Debugger and verifier run commands and read output, so they need reliability but not deep reasoning.
- **opus** for judgement where a false pass is expensive. Critic says "a false approval costs 10-100x more than a false rejection". Security and code review sit here for the same reason.

Caveats found in the sources:
- `docs/shared/agent-tiers.md` says "debug simple issue → architect (haiku)", which contradicts architect's frontmatter (opus). Do not copy that table.
- `src/agents/definitions.ts` sets `securityReviewerAgent` to `sonnet`, but `agents/security-reviewer.md` says `opus`. The file and the source disagree; I did not determine which one the runtime uses.
- Skills override the tier per call, for example `Task(subagent_type="oh-my-claudecode:executor", model="haiku" | "sonnet" | "opus", ...)` in `skills/ralph/SKILL.md:224-226`. Plan's consensus review runs architect and critic as separate `Task` calls on one frozen plan snapshot.

## 3. Proposed mstack agent set (7 agents)

Names use the `m-` prefix, so they do not collide with OMC agents if both are installed. Claude Code namespaces them as `mstack:<name>` in any case.

Key: "deny" = `disallowedTools: Write, Edit`. Only add `tools` if a tool must be granted explicitly. Frontmatter fields are the ones observed in the binary (see section 4).

| # | Agent | Model | Tools | Used by | Success criteria | Output contract |
|---|---|---|---|---|---|---|
| 1 | `m-explorer` | haiku | deny Write, Edit | m-think, m-plan (facts), m-debug (locate) | Every path absolute; all matches for 3 naming variants; caller can proceed | `## Findings` (files:line + why), `## Relationships`, `## Next` |
| 2 | `m-implementer` | sonnet | none extra (worktree-isolated) | m-dispatch (one per subtask, own worktree) | Smallest diff; the plan's own verify command run and output shown; no debug leftovers | `## Changes` (file:line), `## Verification` (command → exit code, counts), `## Blocked` if any |
| 3 | `m-debugger` | sonnet | none extra | m-debug | Reproduces before investigating; 3–5 ranked hypotheses; one fix; regression test or stated seam gap | `## Symptom / Root cause / Repro / Fix / Verification` with file:line; stops at 3 failed hypotheses |
| 4 | `m-verifier` | sonnet | deny Write, Edit | m-verify, m-ship (pre-PR) | Every acceptance criterion VERIFIED / PARTIAL / MISSING with evidence; runs commands itself; different agent from the author | Verdict PASS / FAIL / INCOMPLETE; evidence table (command, output, result); gaps |
| 5 | `m-reviewer` | opus | deny Write, Edit | m-review (code and PR) | Findings have severity and file:line; checks what is missing, not only what is present; no style noise above MINOR | Findings list by severity; "no issues found" stated explicitly if none; hand-offs named |
| 6 | `m-critic` | opus | deny Write, Edit | m-plan step 8, m-review of plans and specs | Predicts 3–5 risk areas before reading; each CRITICAL/MAJOR has evidence and a concrete fix; no praise padding | APPROVE / REVISE / REJECT with numbered findings; open questions split out |
| 7 | `m-researcher` | sonnet | deny Write, Edit; WebSearch/WebFetch/context7 as needed | m-research (one channel per agent) | Each claim cited with URL or path; single-source claims flagged; channel named | `## Answer`, `## Sources` (channel, URL), `## Single-source claims` |

Notes on the set:
- m-research requires ≥3 channels. One agent should serve one channel, and the caller cross-checks. Do not let one agent do all three.
- m-verify asks for a different model family for risky work. Agent frontmatter can only pick Claude tiers, so cross-family checks still go through m-dispatch (DSH or codex), as m-dispatch already describes.
- m-reviewer and m-verifier are read-only by deny-list. Plugin agents do not enforce the rule any other way. The m-dispatch tables treat `Agent` with deny Write/Edit as the reviewer lane, so this matches the existing skill text.
- Not proposed: a separate architect, tracer or scientist. Architecture belongs to m-think and m-plan, tracing to m-debug, and data analysis is out of scope for mstack.
- Each agent's prompt should follow section 1 (Role, Why, Criteria, Constraints, Protocol, Output, Failure modes, Final contract), but keep it at 60–120 lines and drop OMC-only tool names.

## 4. Claude Code plugin agent format (verified)

- **Location:** an `agents/` directory at the plugin root. Confirmed by the OMC layout: `claude plugin details oh-my-claudecode` lists 19 agents, and its `plugin.json` has no `agents` key. The mstack `.claude-plugin/plugin.json` also has none, and mstack has no `agents/` directory yet (`claude plugin details mstack` → `Agents (0)`). Adding `agents/*.md` should work without a manifest change. I have not tested this by installing a copy.
- **Each file:** Markdown with YAML frontmatter, then a body that becomes the agent's system prompt.
- **Keys confirmed in the Claude Code 2.1.319 binary's agent-frontmatter list:** `name`, `description`, `prompt`, `tools`, `disallowedTools`, `model`, `effort`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `autoCompactWindow`, `skills`, `initialPrompt`, `memory`, `background`, `omitClaudeMd`, `isolation`. Also `color` appears in the manifest-level key list.
- **Keys used in practice:** `name`, `description`, `model`, `disallowedTools`.
- **Unverified:** whether plugin agents honour `hooks`, `permissionMode` and `mcpServers`. Do not rely on them until tested. Keep `model` to `opus` / `sonnet` / `haiku`; full model IDs are not verified.
- **Invocation:** `subagent_type="<plugin>:<name>"` (e.g. `oh-my-claudecode:executor`), with an optional `model` override per call.
- **Cost:** `claude plugin details` projects OMC agents at ~20–70 tokens always-on and ~1.6k–8.2k tokens on invoke. mstack's 16 skills are ~50–70 always-on and ~0.75k–3.3k on invoke. Keeping the 7 agents at 60–120 lines keeps the on-invoke cost in the same range.

## Not done and risks
- No agent files were written. This report only proposes them. The output file is the only file created.
- I did not install a test plugin to confirm that `agents/` loads with the proposed frontmatter. Verify with `claude plugin details mstack` after adding one agent, before adding all seven.
- The `security-reviewer` model conflict in section 2 is unresolved.
- Plugin behaviour for `hooks` and `permissionMode` is unverified.
