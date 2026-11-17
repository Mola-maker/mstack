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
| Replay | in the script, look the element up again each run: `agent-desktop find --app <app> --role button --name "<name>" --first` returns `data.match.ref_id`; pass that ref to `click` or `get`. Do not use `batch` for replay: it takes fixed refs, and a ref dies with its snapshot |

Rules that save retries:

- Default delivery is headless: it does not move the pointer or take focus. Stay headless. On Windows `type`, `right-click`, `double-click` and pointer input return `POLICY_DENIED` headless; use `set-value` instead of `type`, and a ref `click` instead of pointer input.
- `--headed` moves the real pointer and sends real keys into the user's desktop. Use it only after the user said yes for this task, never to recover from a headless failure. The same goes for `press --force`, which bypasses the dangerous-shortcut block.
- Retry a failed command only when `error.disposition.retry` is `safe`. On `STALE_REF`, snapshot again.
- Dense apps: `snapshot --skeleton` first, then `snapshot --root '<ref>'` for one region.
- Measured on Windows 11 through the npm launcher (2026-11-12, v1.3.0): `list-apps` about 0.25 s, a window snapshot about 0.5 s. Install size 31 MB.

## android: mola-cua (plain adb as the fallback)

`mola-cua` (github.com/Mola-maker/agent-desktop, directory `mola-cua/`) drives a device or emulator over `adb` with the same model as the desktop driver: a snapshot is a tree, every element you can act on or read has a ref, every command prints one JSON envelope. The doctor says whether it is installed; when it is not, use the plain `adb` table further down.

| Step | Command |
|---|---|
| Check | `mola-cua status` (adb found, devices, `ready`) |
| Before launching | `mola-cua health <package> --clear` (empties the crash log, so an old crash is not counted) |
| Install (L3) | `mola-cua install <apk>` |
| Launch (L3) | `mola-cua launch <package>`; `data.already_running: true` means it was not a cold start |
| Not crashed (L3) | `mola-cua health <package>` → `running: true`, `crashed: false` |
| Observe | `mola-cua snapshot --app <package> -i --compact` |
| Find | `mola-cua find --id <resource id> --first`, or `--text`, `--name`, `--role`; the ref is `data.match.ref_id` |
| Act | `mola-cua click '<ref>'`, `mola-cua set-value '<ref>' '<text>'`, `mola-cua press back` |
| Wait | `mola-cua wait --text "<text>" --timeout 10000` (add `--gone` to wait for it to leave) |
| Assert (L4) | `mola-cua get '<ref>' --property text`, `mola-cua is '<ref>' --property checked`, or `find … --count` |
| Evidence | the last `snapshot` output; `mola-cua screenshot <file.png>` for a person |
| Clean up | `mola-cua close-app <package>` |

What its answers mean:

- **A ref is re-found before every action.** `STALE_REF`: the element is gone, take a new snapshot. `AMBIGUOUS_TARGET` with no `error.details.candidates`: several elements now match, take a new snapshot. Never reuse a ref from before the screen changed.
- **`error.disposition.delivery` says whether input reached the device.** `not_delivered`: retry is safe. `delivery_uncertain` or `delivered_unverified`: do not retry blindly; observe first, because the tap or the text may have landed.
- **`set-value` reads the field back.** `verified: true` is the proof. `verified: false` comes with a reason (a password field, or text equal to the placeholder): confirm another way. `ACTION_FAILED` carries `expected` and `found`.
- **A row is named by the first texts inside it** (`Wi-Fi · Connected`). `find --text Wi-Fi --first` returns the text element; clicking it taps inside the row.
- **More than one device**: `AMBIGUOUS_TARGET` whose `error.details.candidates` lists device serials. A new snapshot does not help: pass `--device <serial>` (or set `ANDROID_SERIAL`) on every command.
- **Where the doctor looks for it**: PATH, then cargo's bin directory (`cargo install` puts it there). `MOLA_CUA_BIN=<full path>` names a build that is not installed; the doctor then reports `not-on-path` and you call that path.
- A dump takes one to several seconds. Use `wait` for a named text or id, not repeated snapshots.
- Not confirmed on a real device yet: `set-value` typing and `install` (the tool's README says what was run). If `set-value` fails on your device, report `expected` and `found`; do not switch to raw `input text` and claim it worked.

### Without mola-cua: plain adb

With several devices attached, pass `-s <serial>` on every command.

| Step | Command |
|---|---|
| Install (L3) | `adb install -r <apk>` |
| Launch (L3) | `adb shell am start -W -n <package>/<activity>`; the output must contain `Status: ok` |
| Not crashed (L3) | `adb shell pidof <package>` prints a pid; `adb logcat -d -b crash` has no entry for the package after launch |
| Observe | `adb exec-out uiautomator dump /dev/tty` prints the UI as XML, followed by one line `UI hierchary dumped to: /dev/tty` that the script must cut off before parsing: each `node` has `text`, `resource-id`, `content-desc`, `clickable`, `bounds="[x1,y1][x2,y2]"` |
| Act | tap the centre of a node's `bounds`: `adb shell input tap <x> <y>`; text: `adb shell input text '<text>'` (write a space as `%s`); back: `adb shell input keyevent 4` |
| Wait | loop on the dump until a node with the expected `resource-id` or `text` appears, with a deadline |
| Assert (L4) | the dump after the flow contains the expected `text` on the expected `resource-id` |
| Evidence | save the final dump; `adb exec-out screencap -p > shot.png` for a person |
| Clean up | `adb shell am force-stop <package>` |

Rules for the fallback:

- Find the node in the dump every time and compute the tap point from its `bounds`. Never store coordinates in the script: they change with screen size and density.
- Clear logcat before launching (`adb logcat -c`) so an old crash is not counted.
- `uiautomator dump` fails while an animation runs ("could not get idle state"): retry up to 3 times, 1 s apart, then report.
- An empty text field reports its placeholder as `text` (the dump also has a `hint` attribute): equal text and hint means empty.
- From Git Bash, `/dev/tty` and `/sdcard/...` arguments are rewritten into Windows paths: prefix the command with `MSYS_NO_PATHCONV=1`.

Both ways: a WebView or a game surface exposes few nodes. Say so in the report; that screen is not covered at L4 by this driver.

## web: Playwright

Use the project's own Playwright install; `m-qa` owns web flows and its verify skill holds the script. Selectors are roles and names (`getByRole('button', { name: 'Save' })`), waits are assertions (`await expect(locator).toHaveText(...)`), never `waitForTimeout`. For a desktop app built on Chromium or Electron, `agent-desktop launch <app> --cdp` exposes a DevTools endpoint Playwright can attach to.
