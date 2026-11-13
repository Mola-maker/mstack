---
name: m-cua
description: "Drive a real desktop app, Android device or browser to prove L3/L4 acceptance. Use for 点一下/操作界面/真机验收/computer use."
whenToUse: "A claim needs the built artifact installed, launched and operated through its real UI, or the user asks to operate a desktop app, Android device or emulator."
when_to_use: "A claim needs the built artifact installed, launched and operated through its real UI, or the user asks to operate a desktop app, Android device or emulator."
---

# m-cua

Computer use for acceptance: operate the real UI, then leave a replayable script and a receipt. The driver is a tool with no model inside; the observe, act, observe loop runs in you. Read the UI as a tree of elements with refs. A screenshot is evidence for a person, not how you find a button.

## When to use / not use

Use when the acceptance level is L3 (installed and launched) or L4 (behavior driven) in `m-verify`'s `references/ladder.md`, and the thing under test has a window, a device screen or a page. Use it too when the user asks you to operate an app.

Do not use it for what a command already proves: unit tests and builds belong to `m-verify`. A project that already has a scripted driver (`.claude/skills/verify/`, kept by `m-qa`) is driven through that; m-cua supplies the driver when there is none, and its script is what `m-qa` then records.

## Procedure

First line you say: `Using m-cua: drive the real UI, keep the script.`

1. **Pick the driver.** Desktop app → `desktop`. Android app → `android`. Web page → `web`. One target, one driver.
2. **Run the doctor.** `node "<this skill dir>/scripts/cua-doctor.mjs" --need <driver>`. `<this skill dir>` is the directory this SKILL.md was loaded from. Exit 0 means usable: go on. It prints one state per driver:
   - `ready`: call the tool by name.
   - `not-on-path` (still exit 0): the tool works but the shell cannot see it. Call it by the full path the doctor printed, in every command and in the script. Do not reinstall and do not rerun the doctor.
   - `no-device`: start the emulator or authorise the device, then rerun.
   - `missing`: install with the printed command if the user allowed installs; otherwise report it and stop.
   - `broken`: run the command it names and read the error.
3. **Prefer what the harness already has.** If this session lists computer-use tools for the target (an MCP server that snapshots and clicks), use them for exploring. The CLI in `references/drivers.md` is the fallback and is always what the final script uses, so the check runs anywhere.
4. **Explore: observe, act, observe.** Take a snapshot, act on one ref from that snapshot, take a new snapshot and confirm the change before the next action. A ref belongs to its snapshot; after the UI changes, old refs are stale. Commands per driver are in `references/drivers.md`.
5. **Write the script.** Put the steps that worked into `.mstack/cua/<slug>.mjs` (or `.sh`): launch, wait for a named element, act, assert on text or state read back from the UI, exit non-zero on any miss. Selectors are roles and names, never screen coordinates or refs from your session. Waits name an element or text, never a fixed sleep.
6. **Prove the script.** Run it from a cold start: it must pass. Then break the expectation on purpose (assert a wrong text) and run again: it must fail. A script that cannot fail proves nothing.
7. **Record the level.** L3 if the script launches the artifact and checks that it is up; L4 if it drives a flow and asserts the result. `node "<m-verify dir>/scripts/receipt.mjs" write --level <3|4> --cmd "<the script command>" --exit <code>`.
8. **Clean up.** Close the app or stop the emulator you started. Leave what was already running alone.

## Output

- `.mstack/cua/<slug>.mjs`: the replayable script.
- `.mstack/cua/<slug>/`: the last snapshot or UI dump as JSON or XML, plus one screenshot when a person will read the report.
- A receipt line from step 7, and in the report: driver, level, the command, pass or fail, and what was not driven.

## Stop conditions

- The doctor still exits 1 after one fix attempt → report the state and the fix line; do not claim L3.
- A command returns `POLICY_DENIED`, or the step seems to need `--headed` (real pointer and keyboard) or `--force` → stop and ask the user. Never add either flag to get past a failure: headed input lands in whatever window the user is working in.
- The same action fails 3 times in a row → stop and report the last error and snapshot (principle 9).
- A step needs credentials, a payment, or sending a message to a real person → stop and ask.
- The target shows private content you were not asked to read (mail, chats, password managers) → do not snapshot it; narrow the snapshot to the app under test.
- An elevated window, a UAC prompt or a locked screen blocks input → report it; do not work around it.

## Harness notes

- Claude Code: session computer-use MCP tools, when present, are for step 4 only. The script in step 5 uses the CLI.
- DSH and Codex: run the CLI through Bash. In WSL the desktop driver sees Linux windows only; drive Windows apps from a Windows shell.
- PowerShell: quote every ref (`'@s8f3k2p9:e8'`); a bare `@token` is the splatting operator.
- Snapshots, screenshots and clipboard reads can hold private content. Keep them under `.mstack/` and out of PR text and public logs.
