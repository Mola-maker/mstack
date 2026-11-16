# Repeatable desktop acceptance (m-cua)

This file is the checklist and the recorded-miss scorer for a real desktop task. How to copy the graphical session environment is in `drivers.md` (desktop, Linux session). Do not treat a fake `cua-doctor` run, or a doctor `ready`, as task success. Do not start the app under test from a non-graphical or CI shell that might steal a window from a session already in use.

## Verdicts

Keep these four results separate. A later one does not erase an earlier one, and an earlier one is not a pass.

1. **App identified.** `cua-doctor --need desktop` is `ready` or `not-on-path`, and `list-apps` names the app. The window may also be listed and accessible.
2. **Menu or other click executed.** A semantic click returned `ok` and named a delivery. Re-snapshot and confirm the intended change. `delivered_unverified` is not that confirmation.
3. **Target control unreadable.** The name the user asked for is not in the snapshot tree, or `find --name` returns `ok: true` with `match: null`. A screenshot may still show the name. That is a miss, not a pass.
4. **Task failed.** The named file was not selected, or the asked-for edit did not happen. Report the highest verdict you actually reached, then fail.

If a clearly authorized fallback stays in the same app and desktop driver (for example a named View menu item), label it as a fallback, snapshot and find again, and stop when the name is still missing. Do not loop. Do not switch to `mola-cua` or Android because a desktop name was missing.

## Offline fixture: Thunar marker unreadable

`acceptance/thunar-marker-unreadable/` holds sanitized snapshots and `find` envelopes from a real run (2026-11-16, Asia/Shanghai). The window title was `native-doc - Thunar`. After the session environment was inherited correctly and a new Thunar registered, doctor was `ready` with `apps: ["thunar"]`, and the window was accessible. `find --name 标记完成.txt` returned `match: null` twice. A semantic click opened the View menu (`delivered_unverified`). The log has no click on List View. The later snapshot still had Icon View checked. The filename was visible as an icon in screenshots taken at the time, but it never appeared as an accessible name. No file was selected and no folder was created. `mola-cua` was not used. The missing name is an upstream `agent-desktop` / AT-SPI gap; mstack cannot fix that in the driver.

Score a recording (this fixture must exit 1 until a later driver recording exposes the name):

```sh
node "<this skill dir>/scripts/assert-named-target.mjs" \
  --name "标记完成.txt" \
  --snapshot "<this skill dir>/references/acceptance/thunar-marker-unreadable/snapshot-before.json" \
  --snapshot "<this skill dir>/references/acceptance/thunar-marker-unreadable/snapshot-after.json" \
  --find "<this skill dir>/references/acceptance/thunar-marker-unreadable/find-before.json" \
  --find "<this skill dir>/references/acceptance/thunar-marker-unreadable/find-after.json"
```

The checker reads only a successful envelope (`ok: true`) and then only the snapshot `data.tree` or the find `data.match`. A failed envelope, or a `name` in metadata, errors, or a request echo, is not a hit. Exit 1 with `unreadable` means the target name is not visible: treat that as failure. Exit 0 means a later recording exposed the name. The checker does not start a GUI, does not call a desktop driver, and does not use screenshot coordinates. Live re-runs belong in a computer-use session that inherits the environment described in `drivers.md`.
