---
name: m-cua
description: "Drive a real desktop app, Android device or browser to prove L3/L4 acceptance. Use for 点一下/操作界面/真机验收/computer use."
whenToUse: "A claim needs the built artifact installed, launched and operated through its real UI, or the user asks to operate a desktop app, Android device or emulator."
when_to_use: "A claim needs the built artifact installed, launched and operated through its real UI, or the user asks to operate a desktop app, Android device or emulator."
---

# m-cua

Computer use for acceptance: operate the real UI, then leave a replayable script and a receipt. The driver is a tool with no model inside; the observe, act, observe loop runs in you. Read the UI as a tree of elements with refs. Prefer names and refs. A screenshot is also how you locate a visible target when the tree does not expose its name, but only after the user has authorized headed visual input for this task.

## When to use / not use

Use when the acceptance level is L3 (installed and launched) or L4 (behavior driven) in `m-verify`'s `references/ladder.md`, and the thing under test has a window, a device screen or a page. Use it too when the user asks you to operate an app.

Do not use it for what a command already proves: unit tests and builds belong to `m-verify`. A project that already has a scripted driver (`.claude/skills/verify/`, kept by `m-qa`) is driven through that; m-cua supplies the driver when there is none, and its script is what `m-qa` then records.

## Procedure

First line you say: `Using m-cua: drive the real UI, keep the script.` When this skill is reached from `m-start` or `/go`, the user's sentence is the task; do not ask them to type driver commands.

1. **Pick the driver.** Desktop app → `desktop` (the CLI is `agent-desktop`). Android app → `android` (`adb`, or `mola-cua snapshot` / `find` / `click` / `wait`). Web page → `web`. One target, one driver. `mola-cua snapshot` is Android even if you pass `--app`; that flag does not select the desktop tree. Unknown `mola-cua` subcommands (for example `list-apps`) can forward to `agent-desktop` when `MOLA_CUA_AGENT_DESKTOP` points at the executable, not a build directory.
2. **Run the doctor.** `node "<this skill dir>/scripts/cua-doctor.mjs" --need <driver>`. `<this skill dir>` is the directory this SKILL.md was loaded from. Exit 0 means the driver is present and, for desktop, `list-apps` has named an application. That is not proof that a given control is readable or that the user task passed. It prints one state per driver:
   - `ready`: call the tool by name.
   - `not-on-path` (still exit 0): the tool works but the shell cannot see it. Call it by the full path the doctor printed. Do not reinstall and do not rerun the doctor. The script must not hard-code that path: it reads it at run time from `cua-doctor.mjs --need <driver> --json` (`drivers[0].bin`).
   - `no-app` (desktop only, exit 1): the tool and the accessibility bus answered, but no application has registered. Start a new app after the bus is up, in the same graphical session. Then rerun the doctor. How to copy the session environment, and what `ready` does and does not mean, is in `references/drivers.md`.
   - `no-device`: start the emulator or authorise the device, then rerun.
   - `missing`: install with the printed command if the user allowed installs; otherwise report it and stop.
   - `broken`: run the command it names and read the error.
3. **Prefer what the harness already has.** If this session lists computer-use tools for the target (an MCP server that snapshots and clicks), use them for exploring. The CLI in `references/drivers.md` is the fallback and is always what the final script uses, so the check runs anywhere.
4. **Explore: observe, act, observe.** Take a snapshot and look up the named target (`find` or a name in the tree) before acting on it. `find` with `ok: true` and `match: null` (or `matches: []`) is a miss, not a success. If the name is absent, try one clearly labeled semantic fallback that stays in the same authorized app and desktop driver (for example a named View menu item), then snapshot and find again. Do not retry past the 3-failure stop. Do not switch to `mola-cua` or Android because a desktop name was missing. After a click, snapshot again and confirm the intended change; `delivered_unverified` is not proof the task succeeded. A ref belongs to its snapshot; after the UI changes, old refs are stale.
   If the name is still absent, the user has authorized headed visual input for this task, and you can see a current screenshot, use `scripts/cua-visual.mjs` (desktop only). `observe` packs `list-windows` and a current `--window-id` screenshot plus bounds, scale and the mapping formula. You locate the target in that `before.png` and pass `--png-x` `--png-y` to `act --headed-visual`. The wrapper converts to screen coordinates, refuses a moved window or an out-of-image point, runs `--headed focus-window` and `--headed mouse-click --xy`, and returns the after image. It does not detect the target, does not add `--headed` by itself, and never sets task success from delivery. You must confirm the intended change in the after image. If headed visual was not authorized, or you cannot see the screenshot, report the name as unreadable and stop. Commands and freshness rules are in `references/drivers.md`.
5. **Write the script.** Put the steps that worked into `.mstack/cua/<slug>.mjs` (or `.sh`): launch, wait for a named element, act, assert on text or state read back from the UI, exit non-zero on any miss. Selectors are roles and names, never screen coordinates or refs from your session. Waits name an element or text, never a fixed sleep. A headed visual step may call `cua-visual.mjs observe` then `act`, but the script must not store png or screen coordinates: a later run needs a fresh observe and a fresh locate by the model.
6. **Prove the script.** Run it from a cold start: it must pass. Then break the expectation on purpose (assert a wrong text) and run again: it must fail. A script that cannot fail proves nothing.
7. **Record the level.** L3 if the script launches the artifact and checks that it is up; L4 if it drives a flow and asserts the result. `node "<m-verify dir>/scripts/receipt.mjs" write --level <3|4> --cmd "<the script command>" --exit <code>`.
8. **Clean up.** Close the app or stop the emulator you started. Leave what was already running alone.

## Output

- `.mstack/cua/<slug>.mjs`: the replayable script.
- `.mstack/cua/<slug>/`: the last snapshot or UI dump as JSON or XML, plus one screenshot when a person will read the report.
- A receipt line from step 7, and in the report: driver, level, the command, pass or fail, and what was not driven.

## Stop conditions

- The doctor still exits 1 after one fix attempt → report the state and the fix line; do not claim L3.
- The named target is not in the tree, or `find` returns `match: null` after the allowed semantic fallback, and headed visual was not authorized (or you cannot see a current screenshot) → report it as unreadable and fail the task. Do not call the doctor `ready` a pass, and do not silently change driver or add `--headed`.
- A command returns `POLICY_DENIED`, or a semantic step seems to need `--headed` (real pointer and keyboard) or `--force` → stop and ask the user. Never add either flag to recover from a failed headless click. Headed visual is a separate, default-off path: use `cua-visual.mjs act --headed-visual` only when the user has already said yes to headed visual input for this task.
- The same action fails 3 times in a row → stop and report the last error and snapshot (principle 9).
- A step needs credentials, a payment, or sending a message to a real person → stop and ask.
- The target shows private content you were not asked to read (mail, chats, password managers) → do not snapshot it; narrow the snapshot to the app under test.
- An elevated window, a UAC prompt or a locked screen blocks input → report it; do not work around it.

## Harness notes

- Claude Code: session computer-use MCP tools, when present, are for step 4 only. The script in step 5 uses the CLI.
- DSH and Codex: run the CLI through Bash. In WSL the desktop driver sees Linux windows only; drive Windows apps from a Windows shell.
- PowerShell: quote every ref (`'@s8f3k2p9:e8'`); a bare `@token` is the splatting operator.
- Snapshots, screenshots and clipboard reads can hold private content. Keep them under `.mstack/` and out of PR text and public logs.
