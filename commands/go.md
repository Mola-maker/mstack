---
description: "One entry point: say what you want; mstack plans, builds, verifies, reviews, shows live progress and pings you when done."
argument-hint: "<what you want, in any words>  (add 提PR / ship to end with a PR)"
---

# /go — one sentence in, verified result out

The user should never need a skill name. Carry this intent through the whole pipeline yourself:

<intent>
$ARGUMENTS
</intent>

If the intent is empty, read `.mstack/runs/*/progress.json` for a run with status running or blocked and resume it; if there is none, ask for the intent in one short line.

## 0. Start the run (visible from the first second)

- Pick the stages. `think` only if the intent is vague (you could not write a 3-step plan from it without guessing the goal). `ship` only if it asks for a PR, push, 提PR, 推送 or ship. `scout` always, except for a fix you can already point to by file:line. Then `plan,implement,verify,review`. A one-line fix still goes through verify.
- Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/go-progress.mjs" start "<intent>" --stages <comma list>` and keep the printed run id. Every progress call below uses this script; `mola statusline`, `mola dash` and `mola web` read the file it writes.
- Create one todo per stage with TaskCreate/TodoWrite, so the user sees the pipeline in the UI.
- Announce one line: `Using /go: <stages joined by →>, run <id>`.

## 1. Stages

For each stage: `stage <id> <name> running --model <model>` → do it → `stage <id> <name> done|failed --summary "<one line>" --artifact <file>`. For every subagent you spawn, call `worker <id> <agent-name>-<n> <stage> working --model <model>` before it starts and `... done|failed` when it returns. Write each stage artifact into `.mstack/runs/<id>/`.

| Stage | Who does it | Artifact | Done when |
|---|---|---|---|
| think | you, using m-think's premise attack; questions only if a wrong guess is expensive, each with a default | think.md | goal, non-goals, assumptions written |
| scout | run `mola scout "<need>" --out .mstack/runs/<id>/scout` if `mola` is on PATH; otherwise spawn `m-researcher` (GitHub, registries, docs) and `m-explorer` (this repo and sibling repos) in parallel, looking for existing code that already does the job | reuse.md: candidates (link, stars, last push, license), files read, decision per need: reuse / adapt / write + why | at least 3 channels tried, and the decision written |
| plan | you; spawn `m-critic` once on the plan when it has more than 3 steps | plan.md, citing reuse.md for every "write it ourselves" step | ordered steps, each with its check command |
| implement | `m-implementer` per independent step, in parallel when files do not overlap; small edits yourself | implement.md (files changed, one line each) | every plan step done or marked blocked |
| verify | `m-verifier` (a different agent from the implementer) | verify.md: exact commands and their result lines | fresh test/build output read, not assumed |
| review | `m-reviewer`, model family different from the implementer | review.md: FINDING / CLEARED lines | no open blocking FINDING |
| ship | follow m-ship | PR URL in ship.md | CI green or the failure reported |

Rules that hold across stages:
- Verify fails → back to implement with verify.md as input. At most 3 strikes; then `block` with reason "verify failed 3 times" and report the evidence.
- A blocking review finding → fix it (implement → verify again), same 3-strike limit.
- Read only excerpts; spill long output to files in the run dir.
- Copied or adapted code keeps its license header and gets a source line in implement.md; GPL/AGPL or unlicensed code is never copied.
- Never commit, merge or push to main/master/release yourself. Work on a branch `agent/<id>`; landing on a protected branch is `mola land`, after review, behind the ship gate.

## 2. Gates (the only times you stop)

Pushing, opening a PR, publishing, deleting outside the working tree, paying or messaging others all need the user's yes, every time:
1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/go-progress.mjs" block <id> "<reason>" "<exact action>"` → approval id.
2. Notify (section 3), then ask with AskUserQuestion. The user may instead approve from `mola web` or `mola go approve <id>`: run `check <id> <approvalId>` before acting.
3. Record the answer with `decide <id> <approvalId> approve|deny`. Denied → `done <id> stopped`, then report.

Everything else (reversible choices, file edits in the repo, running tests) needs no approval: take the sensible default and say so in one line.

## 3. Finish and notify

- `done <id> done` (or `failed` / `stopped`), and mark the todos.
- Notify: use PushNotification if you have it; otherwise run `mola notify "<one-line result>" --title "go <id>"` if `mola` is on PATH. Do the same when blocked on a gate.
- Report in the user's language, with a one-line conclusion first, then what changed (file:line), how it was verified (command + result line), what was not done, and the risks.

## Never

- Claim done without a verify artifact that contains real command output from this run.
- Let the implementer verify or review its own work.
- Skip progress calls: an invisible run is a failed run for this command.
