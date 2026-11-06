# mstack skill evals: research and proposal

2026-11-06. Scope: test that mstack's 16 skills trigger on the right prompts and improve outcomes. Legend: [V] verified from source or local output; [W] fetched page or repo; [U] unverified.

## 1. What each tool or practice does

**Current check (`scripts/check.mjs`, CI `.github/workflows/check.yml`)** [V]
- Structure only: 16 skill dirs, frontmatter fields, name = dir, ≤150 lines, 5 sections in order, no foreign skill refs, source-map coverage, no 3-line verbatim copy from `.sources/`.
- Says nothing about triggering or outcomes; keep it as the cheap gate.

**`claude plugin eval` (CLI 2.1.319)** [V]
- Runs `<eval dir>/**/case.yaml` (or `prompt.md` + `graders/*.md`). Default dir `evals/`.
- Each case is a headless `claude` run on the plugin, graded by deterministic graders (`regex`, `tool_used`, `tool_order`, `file_exists`) and LLM graders (`llm`, `baseline`; judge default `haiku`).
- A no-plugin baseline arm runs automatically (`--ablation with-without`). `arm: with-only` marks graders only the plugin arm can satisfy, such as `tool_used: Skill`.
- Flags: `--runs`, `--threshold` (default 1.0), `--json [path]`, `--no-publish`, `--case <glob>`, `--tag`, `-j`, `--max-cost-usd` (exit 2 on breach), `--trust-plugin` (CI), `--scaffold` (runs author bash; off by default).
- Schema from the binary [V]: `schema_version: "1.1"` required; `name` required; `execution{prompt,max_turns,timeout_seconds,allowed_tools,...}`; `runs≤50`; `graders` (≥1, unique names). Unknown keys make the CLI refuse the case.
- Grader types [V]: `regex` (`target`, `pattern`, `match`), `tool_used` (`tool`, `input_match` regex over tool input, `min`, `max`), `tool_order`, `file_exists`, `llm` (`criteria`, `focus`), `baseline`. All take `name`, `weight`, `arm`.

**skill-creator plugin** [V]
- `scripts/run_eval.py`: trigger-rate test. Writes a temp command file into `<project>/.claude/commands/`, runs `claude -p <query> --output-format stream-json`, and detects a trigger. Side effect: run it on a scratch copy.
- `scripts/run_loop.py`: train/test split with `improve_description.py` tuning the description. The only trigger-accuracy loop I found; use it for description tuning.
- Format is `evals.json`, not case.yaml. This proposal uses case.yaml (native CLI).

**Anthropic authoring guidance** [W, platform.claude.com best-practices]: description ≤1024 chars, third person, what + when; body <500 lines; "build evaluations first" (≥3 scenarios, baseline, iterate); test on every model used. The page says no built-in runner exists, which looks stale [U].

**Trigger-eval precedent** [W] `dfadler/agent-config` `plugins/eval-authoring` lint rules EVAL020 (needs a must-not-fire case), EVAL022 (Skill `input_match` allows a `plugin:` prefix), EVAL028 (boundary case needs a `pair:` twin). Rule sources read; linter not run.

**NVIDIA SkillSpector** [W, README summary, not run]
- Security scanner (71 patterns; prompt injection, exfiltration, tool poisoning). CLI `skillspector scan ./skill/`, `--no-llm`; SARIF output. Exact CI flags [U]. Security, not quality.

**promptfoo** [W, repo description only]
- Declarative prompt/agent testing with CI support. Assertion and CI details [U]: docs fetch was empty. A fallback only.

**LLM-as-judge** [V]: prefer deterministic checks; use `llm` only where a regex cannot check, with narrow `criteria`.

## 2. Proposal for mstack

### 2a. Layout
```
E:\mstack\evals\
  route-continue-to-m-start\case.yaml
  route-review-pr-to-m-review\case.yaml
  boundary-quicksort-no-skill\case.yaml   (optional, see 2d)
```
No `plugin.json` change needed (default `evals/`).

### 2b. Example case 1: `继续` routes to m-start

`evals/route-continue-to-m-start/case.yaml`:
```yaml
schema_version: "1.1"
name: route-continue-to-m-start
description: A terse "继续" should route through mstack:m-start.
tags: [routing, trigger]
execution:
  prompt: "继续"
  max_turns: 6
  timeout_seconds: 300
  allowed_tools: [Read, Glob, Grep]
runs: 3
graders:
  - type: tool_used
    name: fires-m-start
    tool: Skill
    input_match: '"skill"\s*:\s*"(?:[\w-]+:)?m-start"'
    min: 1
    arm: with-only
  - type: regex
    name: reply-mentions-router
    target: last_message
    pattern: "m-start|路由|\\.mstack"
    match: contains
    weight: 0.5
```

### 2c. Example case 2: `review一下这个PR` fires m-review, never m-ship

`evals/route-review-pr-to-m-review/case.yaml`:
```yaml
schema_version: "1.1"
name: route-review-pr-to-m-review
description: "review一下这个PR" fires m-review and never m-ship.
tags: [routing, trigger]
execution:
  prompt: "review一下这个PR"
  max_turns: 8
  timeout_seconds: 420
  allowed_tools: [Read, Glob, Grep]
runs: 3
graders:
  - type: tool_used
    name: fires-m-review
    tool: Skill
    input_match: '"skill"\s*:\s*"(?:[\w-]+:)?m-review"'
    min: 1
    arm: with-only
  - type: tool_used
    name: must-not-fire-m-ship
    tool: Skill
    input_match: '"skill"\s*:\s*"(?:[\w-]+:)?m-ship"'
    max: 0
    arm: with-only
  - type: llm
    name: no-push-or-merge
    criteria: "The reply reviews code or asks which PR to review. It does not push, merge, or open a PR."
    focus: last_message
    weight: 1
```
Caveat [U]: with no PR in the fixture, the agent may ask which PR instead of firing a skill. Fix with a `scaffold_script` (needs `--scaffold`) that creates a branch with a small diff.

### 2d. Boundary (negative) case, optional
`evals/boundary-quicksort-no-skill/case.yaml`: prompt `"用 Python 写一个快速排序"`; one `tool_used` grader with `tool: Skill`, `input_match: '"skill"\s*:\s*"(?:[\w-]+:)?m-'`, `max: 0`, `arm: with-only`; tags `[trigger-boundary, pair:route-continue-to-m-start]` per the EVAL028 convention [W convention; U whether the CLI requires it].

### 2e. Grade and run
- Local: `claude plugin eval E:\mstack --runs 3 --threshold 0.8 --no-publish --max-cost-usd 2 --json E:\mstack\evals\results\last.json`. Filter with `--case "route-*"`. Pass = score ≥ threshold over `runs`. Routing relies on `tool_used` (deterministic); the LLM grader is a tiebreak.
- Re-run after any `description:` edit in `skills/*/SKILL.md`; that is the likeliest regression.
- CI: keep live evals out of the push workflow (cost, auth). Use a `workflow_dispatch` or weekly job: `claude plugin eval . --trust-plugin --threshold 0.8 --no-publish --max-cost-usd 5`, with the auth secret [U, headless auth unverified].

### 2f. Additions to `scripts/check.mjs` (static, no model calls)
Active only when `evals/` exists:
1. Each `case.yaml` parses, has `schema_version: "1.1"`, `name`, `execution.prompt`, and a non-empty `graders` list with unique names.
2. Each grader has a known `type` and only that type's keys (section 1).
3. Each `tool_used` with `tool: Skill` has an `input_match` that allows the `plugin:` prefix (EVAL022).
4. No `init` placeholder text remains.
5. Coverage: each of the 16 skill names appears in a should-fire grader; at least one `max: 0` boundary check exists (EVAL020).
6. Each description ≤1024 chars.

YAML parsing: check.mjs has no deps. Either add the `yaml` npm package (a new dependency; decide) or parse in the existing Python `pyyaml` step of `check.yml`. Whether a skill fires in practice and whether the outcome improves are checkable only by live runs.

## 3. Top recommendations
1. **Add the two case files (2b, 2c) and run them once locally.** Nothing here is verified until the output is read.
2. **Make routing graders deterministic:** `tool_used` with a prefix-tolerant regex. Do not grade routing with the LLM.
3. **Cover the boundary.** Positives alone cannot show over-triggering (EVAL020/028 precedent).
4. **Add the static checks (2f) first.** They fail malformed cases without spending credits.
5. **Keep live evals out of default CI** (manual or weekly job, `--max-cost-usd`, `--threshold 0.8`). Run SkillSpector as a separate security job, after `skillspector --help` confirms its flags. Use `run_loop.py` only for description tuning, on a scratch copy.
## Not done / risks
- No live eval run; no SkillSpector run; promptfoo verified only from its repo description.
- Exa failed (401, no `EXA_API_KEY`); sources are WebFetch, WebSearch and gh only.
- `input_match` format comes from the EVAL022 rule and the binary; not confirmed by a passing run. Headless CI auth and live cost are unmeasured.
- Only this file was written. `scripts/check.mjs`, `evals/`, and CI are unchanged.
