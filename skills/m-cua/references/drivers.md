# Drivers (m-cua)

One section per driver: how it reads the UI, how it acts, how it waits, what the script asserts on. Run `cua-doctor.mjs --need <driver>` first.

## desktop: agent-desktop

`agent-desktop` (vercel-labs, Apache-2.0) reads the OS accessibility tree: UI Automation on Windows, AX on macOS, AT-SPI on Linux. Every command prints one JSON envelope with `ok` and `data` or `error`. It carries its own guides, matched to its version; read them before the first use instead of guessing flags:

```sh
agent-desktop skills get desktop      # the loop, refs, retry rules
agent-desktop skills get platform     # what differs on this OS
agent-desktop <command> --help
```

| Step | Command |
|---|---|
| Launch | `agent-desktop launch <app> --activate` |
| Observe | `agent-desktop snapshot --app <app> -i --compact` (interactive elements, each with a ref) |
| Two windows | `AMBIGUOUS_TARGET` lists window ids in `error.details`; pass one with `--window-id` |
| Act | `agent-desktop click '<ref>'`, `set-value '<ref>' <text>`, `press <key>` |
| Wait | `agent-desktop wait --app <app> --text "<text>"`, or `--wait-for role:text` on a snapshot or action |
| Assert | `agent-desktop find` / `get` / `is`, then compare the JSON in the script |
| Replay | `agent-desktop batch '<json array of {command,args}>' --stop-on-error` |

Rules that save retries:

- Default delivery is headless: it does not move the pointer or take focus. On Windows `type`, `right-click`, `double-click` and pointer input need the global `--headed` flag and return `POLICY_DENIED` without it. Prefer `set-value` over `type`.
- Retry a failed command only when `error.disposition.retry` is `safe`. On `STALE_REF`, snapshot again.
- Dense apps: `snapshot --skeleton` first, then `snapshot --root '<ref>'` for one region.
- Measured on Windows 11 through the npm launcher (2026-11-12, v1.3.0): `list-apps` about 0.25 s, a window snapshot about 0.5 s. Install size 31 MB.

## android: adb

No extra agent is installed on the device; everything goes through `adb`. With several devices attached, pass `-s <serial>` on every command.

| Step | Command |
|---|---|
| Install (L3) | `adb install -r <apk>` |
| Launch (L3) | `adb shell am start -W -n <package>/<activity>`; the output must contain `Status: ok` |
| Not crashed (L3) | `adb shell pidof <package>` prints a pid; `adb logcat -d -b crash` has no entry for the package after launch |
| Observe | `adb exec-out uiautomator dump /dev/tty` prints the UI as XML: each `node` has `text`, `resource-id`, `content-desc`, `clickable`, `bounds="[x1,y1][x2,y2]"` |
| Act | tap the centre of a node's `bounds`: `adb shell input tap <x> <y>`; text: `adb shell input text '<text>'`; back: `adb shell input keyevent 4` |
| Wait | loop on the dump until a node with the expected `resource-id` or `text` appears, with a deadline |
| Assert (L4) | the dump after the flow contains the expected `text` on the expected `resource-id` |
| Evidence | save the final dump; `adb exec-out screencap -p > shot.png` for a person |
| Clean up | `adb shell am force-stop <package>` |

Rules:

- Find the node in the dump every time and compute the tap point from its `bounds`. Never store coordinates in the script: they change with screen size and density.
- Clear logcat before launching (`adb logcat -c`) so an old crash is not counted.
- `uiautomator dump` fails while an animation runs ("could not get idle state"): retry up to 3 times, 1 s apart, then report.
- A WebView or a game surface exposes few nodes. Say so in the report; that screen is not covered at L4 by this driver.
- From Git Bash, `/dev/tty` and `/sdcard/...` arguments are rewritten into Windows paths: prefix the command with `MSYS_NO_PATHCONV=1`.

## web: Playwright

Use the project's own Playwright install; `m-qa` owns web flows and its verify skill holds the script. Selectors are roles and names (`getByRole('button', { name: 'Save' })`), waits are assertions (`await expect(locator).toHaveText(...)`), never `waitForTimeout`. For a desktop app built on Chromium or Electron, `agent-desktop launch <app> --cdp` exposes a DevTools endpoint Playwright can attach to.
