# Acceptance ladder

"It compiles" and "it was installed on a real device and driven" are different verdicts. Every claim names the level it was proven at; every project declares the level it requires.

| Level | Proves | Android example | Web example |
|---|---|---|---|
| L0 static | the code parses and type-checks | `./gradlew lintDebug`, `kotlinc` type check | `tsc --noEmit`, `eslint .` |
| L1 build | the artifact is produced | `./gradlew assembleDebug` exits 0, APK exists | `npm run build` exits 0, `dist/` exists |
| L2 unit tests | logic passes in isolation | `./gradlew testDebugUnitTest` | `npm test` (vitest/jest, jsdom) |
| L3 installed and launched | the artifact runs in the real runtime | `adb install -r app-debug.apk`, `adb shell am start -W …` returns, `adb logcat` shows no crash | built app served, a real browser loads the page with no console error |
| L4 behavior driven | the user-visible behavior works end to end | Espresso or `adb shell input` taps through the flow, screenshot/UI dump shows the result | Playwright clicks through the flow, asserts text and the side effect |
| L5 non-functional | speed, size, accessibility, security hold | cold-start time over N runs, APK size, TalkBack pass | Lighthouse budget, bundle size, axe scan |

## Rules

- **A claim below the project's required level is PARTIAL**, never VERIFIED. "Builds" at L1 on a project that requires L3 is PARTIAL, whatever the unit tests say.
- Declare the level once per project: a line `Required level: L<n>` under the title of `.claude/skills/verify/SKILL.md` (made by `m-qa`; `check-verify-skill.mjs` checks its form and warns when it is absent). Without that line the default is L1.
- A failed check at level N caps the receipt at N-1. A level is the highest passing check, never inferred from a lower one.
- Run the check at the level you claim, then record it (below). A receipt records what ran; it does not replace reading the output.

## Receipt

`node "<m-verify dir>/scripts/receipt.mjs" write --level <0-5> --cmd "<command>" --exit <n> [--log <path>]` appends the check to `.mstack/verify/receipts/<tree>.json`:

```json
{"tree": "<40-hex>", "level": 3, "checks": [{"level": 3, "cmd": "…", "exit": 0, "log": null}], "ts": "…"}
```

`receipt.mjs check [--required <0-5>]` exits 0 only if a receipt for the current tree reaches the required level. Otherwise it exits 1 with one line naming the required level, the level found and the command to run. Re-running the same command at the same level replaces its earlier result.

### Tree hash

Receipts are keyed by the working-tree hash, so any edit leaves the old receipt behind. Other mstack receipts (for example the review receipts in FRAMEWORK §13.4) should adopt this algorithm unchanged:

1. Copy the git index to a temporary file and point `GIT_INDEX_FILE` at it. The real index is never touched.
2. In that temporary index run `git add -A -- . ':!.mstack'`, then `git rm -r --cached -q --ignore-unmatch -- .mstack` (covers `.mstack/` files that are already tracked).
3. `git write-tree` prints the hash. Delete the temporary index.

It covers uncommitted and untracked non-ignored files, and ignores `.mstack/` so writing a receipt does not invalidate it. Line-ending conversion is whatever `git add` does under the repo's own settings, so two calls on an untouched checkout agree.

Cost: hashing adds every changed and untracked file to the temporary index, so it grows with their number; each run also writes loose objects for them into the real object store (expected from `git add`; `git gc` collects them). `receipt.mjs` has its own deadline (`--timeout-ms`, or `MSTACK_RECEIPT_TIMEOUT_MS`, default 60 s) and exits 2 with `tree hash timed out after N ms`, removing its temporary index (kept under `<gitdir>/mstack-tmp/`, stale ones swept on the next run: a file goes only when its pid is dead and it is over 10 minutes old, because pids are not shared between WSL and Windows runs on the same repo). The Stop reminder passes a 4 s deadline; when the check is too slow it shows one line, `verify gate could not be evaluated: <reason>`, instead of going quiet. Fix a slow repo by ignoring build output or turning the gate off.

## Known limitation

Docs-only changes are not exempted this round: with a gate that requires L3, a README edit also needs a new receipt, which can mean booting an emulator. The way out is to turn the Stop reminder off (delete `.mstack/verify/gate`), not to weaken the required level.
