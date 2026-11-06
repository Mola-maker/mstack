# Handoff template (`.mstack/handoff.md`)

Read this when m-handoff's Save step writes the handoff. The file is overwritten each save; the previous version goes to `.mstack/handoff-archive/`. Keep it short: a resume should cost minutes, not a re-read of the session.

## Three layers

```markdown
# handoff — <YYYY-MM-DD HH:mm>

## Task frame          (stable: changes only when the goal itself changes)
- Goal: <one sentence; link .mstack/goals/<slug>.md, and its ## Closeout if written>
- Constraints: <hard requirements, deadlines, "do not touch X">

## Progress            (condensed: rewritten from scratch on every save)
- Decisions: <decision — why, alternatives rejected>
- Remaining (priority order):
  1. <step> (verified)
  2. <step> (done)
  3. <step> (assumed)
- Notes: <gotchas, blockers, failed approaches>

## Recent steps        (verbatim: pruned on every save — keep only the last few)
- `<command>` → <key output line>
- `<command>` → <key output line>
```

Provenance marks: `(verified)` = ran and saw the evidence; `(done)` = finished but not independently re-checked; `(assumed)` = not run — must be re-verified before use.

## What the auto snapshot is (and is not)

The plugin's PreCompact hook (`hooks/precompact.mjs`) appends a section like this without touching anything already in the file:

```markdown
## Auto snapshot — <ISO timestamp>

- branch: <git branch>
- goal: <newest .mstack/goals/*.md, or "none">
- `git status --short`:
  ```
  <output, truncated>
  ```

Mechanical snapshot only — decisions and next steps still need a hand-written m-handoff pass.
```

It is a safety net for the case where the session compacts before anyone ran Save. It contains observable state only; the three layers above still have to be written by m-handoff. When restoring, trust the snapshot's branch/status facts, but never read decisions into it.
