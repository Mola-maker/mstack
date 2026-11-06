# m-qa — probe checklist and report template

## Readiness

- [ ] Service starts with the repo's documented command.
- [ ] URL answers (HTTP 200 or the app's health endpoint), not just "port is open".

## Functional flow probes (Playwright)

For each page/flow: navigate → assert expected state → one screenshot → check console/network.

- [ ] Main entry path (homepage or primary screen) renders without error.
- [ ] Primary user flow end-to-end (sign in / search / submit / checkout) works.
- [ ] Auth-gated pages behave correctly (or record as deferred if no test identity).
- [ ] Forms validate and submit; error states show something useful.
- [ ] Navigation/back/refresh don't lose state or break layout.
- [ ] Mobile/tablet/desktop viewports render correctly (thumb reach, ≥44px targets).

## Signals to record

- [ ] Console errors per page (`[]` is the target; any new error is a regression).
- [ ] Failed/repeated network requests.
- [ ] Load time and layout shift per page.
- [ ] Broken links/images.

## Design pass

- [ ] Design-system tokens exist and the page deviates where it should not.
- [ ] Spacing, typographic hierarchy, and alignment are consistent.
- [ ] Clickable elements look clickable; the obvious next step is the default.
- [ ] No generic "AI-looking" patterns (everything looks like everything else, dead padding, boilerplate copy) — list separately.

## Fix-loop discipline (only in "test and fix" mode)

- Reproduce before touching code; minimal fix; before/after screenshot pair; one commit per fix.
- Re-audit after fixes; warn loudly if the final score is worse than baseline.

## Report template

The summary line is only `verdict: clean`, `verdict: changed`, or `verdict: blocked`. Definitions are in `verify-skill.md`. Do not invent a fourth word.

```
# QA report — {target} {date}
## Summary
verdict: clean|changed|blocked
<one line: what ran, what was edited, what failed>
## Findings
| id | severity | page | problem | evidence | repro steps | status |
## Design findings
## Deferred / untested
## Evidence (path that survived cleanup)
```
