---
name: m-verify
description: "Produce fresh evidence that a change actually works before claiming it is done, green, or fixed — run the real test/build/repro, read the actual output, and test behavior not implementation. Use when \"验证一下 / 跑测试 / 真的能跑吗 / 确认修好了\"."
whenToUse: "Before any success claim, commit, PR, or \"done\" — or whenever confidence that a feature or fix works is required."
---

# m-verify

The only acceptable proof that work is done is fresh evidence from the real artifact: a command you just ran whose output you read. "Should work", confidence, and agent self-reports are not evidence.

## When to use / not use

Use before committing, before opening a PR (`m-ship`), after a fix (`m-debug`), when a subagent reports success (`m-dispatch`), and whenever you are about to say "passes / fixed / done".

Do NOT use it to review design or catch missing features — route that to `m-review`. Do NOT use it as a substitute for thinking first (`m-think`).

## Procedure

1. **Name the claim precisely.** Turn "it works" into a falsifiable statement: "all tests pass", "build exits 0", "empty email is rejected with `Email required`".
2. **Identify the command that proves it.** One claim → one command. If no command proves it, say so rather than bluffing.
3. **Run it fresh, now.** Execute the full command in this message. A previous run is not evidence.
4. **Read the actual output.** Check the exit code, count failures, and eyeball the real result — never a `| tail -1` truncation or your own echo.
5. **Compare.** If the output confirms the claim, report it *with* the evidence. If not, report the actual state *with* the evidence. No "should", "probably", "seems to".

## Output

Follow §4's report format, then the evidence summary: what was verified, the exact command(s) run, what passed, and what failed or remains unverified. Quote a failing assertion's diff (e.g. "Extra items in the right set"), not the assertion line — an exception, an empty result, and a real mismatch all print red; only the last proves the instrument works.

## Stop conditions

- Same failure returns twice after a real fix, or 5 runs elapsed → stop; route the stubborn red to `m-debug`.
- A check needs a missing tool, secret, service, or network → report it; do not stub, skip, or work around it.
- No realistic verification path exists → say that explicitly and describe the closest manual check you *did* run.

## Harness notes

- Claude Code / Codex: run the repo's own check command (bare `pytest`, `npm test`, `cargo test`, `go test ./...`) — a green single-file run is not a green suite.
- DSH: run Bash the same way; use a raw command (not a summarizing filter) when the exact counts or paths matter.
- Cross-model check: for risky or high-stakes work, dispatch one subagent on a different model whose only job is to re-run the verification (`subagent_claude_code` / `subagent_codex` in DSH). The verifier is never the author.
