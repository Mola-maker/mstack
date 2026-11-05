---
name: m-qa
description: Real-device acceptance testing of a running site: start the service, drive the real flows in a browser, catch visual/design/policy problems, and report with evidence (screenshots, scores, repro steps). Use when asked to "测一下/验收/QA/看看这个页面/有没有bug" — report-only by default.
whenToUse: A site or page is ready to test end-to-end in a real browser; the user wants bugs found — and, optionally, fixed — with evidence.
---

# m-qa

Test a running website the way a real user does: boot the service, walk the actual flows in a browser (Playwright), capture screenshots, and score health and design quality. Default to report-only; fix only when explicitly asked.

## When to use

Use it: on "测一下/验收/QA/有没有bug", when a feature or page is ready for testing, or for a visual design pass.

Not this skill: code-level correctness review → `m-review`; just wanting the current state scored → this skill's report-only mode; product/headless API-only bugs with no browser → `m-verify`/`m-debug`.

## Procedure

1. **Set scope and mode.** Parse target (URL or localhost), pages/flows, and depth. Default mode is *report-only* (find and document, never fix). "test and fix" switches to the fix loop.
2. **Start the service.** Run the repo's own dev/build/start command (read package.json / Makefile / AGENTS.md). Wait until it actually answers (`curl` the URL or health endpoint).
3. **Drive real flows.** Use Playwright to visit pages, follow the main user paths, and exercise forms/navigation — never mock the happy path. Capture one screenshot per step and any broken/error states.
4. **Check design, not just function.** Against a design system if one exists (`design-system.md`, `:root` CSS, `tailwind.config.*`), flag spacing, hierarchy, typography, responsiveness, and generic "AI-looking" patterns separately from functional bugs.
5. **Assess health signals.** Watch for console errors, broken requests, layout shift, and load time per page.
6. **Triage and (if fixing) fix loop.** Sort findings by severity. If fixing: reproduce → minimal fix → re-test with a before/after screenshot pair → one commit per fix → re-audit. Stop frequently to re-evaluate (see Stop conditions).
7. **Report.** Write the report plus screenshots; give a summary and a health/design score delta.

See `references/qa-checklist.md` for the probe checklist and report template.

## Output

- A report file (`.mstack/reviews/` or a repo `qa-reports/` dir) with: findings (severity, evidence, repro steps), scores, and before/after screenshots.
- A one-line summary: "QA found N issues, fixed M, health X → Y."
- What could not be tested (auth-only pages, third-party widgets) as "deferred".

## Stop conditions

- Stop and ask for a clean worktree before the fix loop (each fix should commit atomically).
- Stop after two reverts, after an edit that touches a file unrelated to the finding, or when risk grows — show progress and ask whether to continue.
- Stop the fix loop at a hard cap and report remaining issues rather than grinding.

## Harness notes

- Claude Code / DSH: Playwright via Bash; `curl` for readiness.
- DSH: `subagent` for parallel page probes on large sites.
- Codex: `codex exec` per-page probe scripts.
