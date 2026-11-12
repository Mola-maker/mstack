// Tests for the `Required level` rule of check-verify-skill.mjs. Run: node --test "skills/m-qa/scripts/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkVerifySkill, verifySkillWarnings } from "./check-verify-skill.mjs";

const script = fileURLToPath(new URL("./check-verify-skill.mjs", import.meta.url));

const feature = `# Create

A user adds one item.

## Sub-features
- create-save persists a title.

## How to get to it (user POV)
- Choose New.

## Driving it with the sample CLI
- Preconditions: the doctor check passed.

## Gotchas
- A toast alone is not proof.
`;

function project(levelLine) {
  const root = mkdtempSync(join(tmpdir(), "m-qa-level-"));
  const dir = join(root, ".claude", "skills", "verify");
  mkdirSync(join(dir, "features"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---
name: ${basename(root)}-verify
description: "Drive the sample app from a cold start."
---

# Verify sample
${levelLine}
## Launch
Start it.

## Doctor
Read-only health check.

## Drive
One command per action.

## Evidence
Keep screenshots.

## Cleanup
Stop the pid you started.
`);
  writeFileSync(join(dir, "features", "README.md"), "# Map\n\n- [Create](./create.md)\n");
  writeFileSync(join(dir, "features", "create.md"), feature);
  return dir;
}

test("a driver with `Required level: L3` passes", () => {
  assert.deepEqual(checkVerifySkill(project("\nRequired level: L3\n")), []);
});

test("a driver without a Required level line passes with one warning naming the L1 default", () => {
  const dir = project("");
  assert.deepEqual(checkVerifySkill(dir), []);
  const warnings = verifySkillWarnings(dir);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /L1/);
  assert.deepEqual(verifySkillWarnings(project("\nRequired level: L2\n")), []);
});

test("cli prints ok and exits 0 for a missing line, warning on stderr", () => {
  const r = spawnSync(process.execPath, [script, project("")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "ok");
  assert.match(r.stderr, /warning: .*L1/);
});

test("an unfilled or out-of-range level is rejected", () => {
  for (const line of ["Required level: L<n>", "Required level: L6", "Required level: L7", "Required level: Lx", "Required level: 3"]) {
    const problems = checkVerifySkill(project(`\n${line}\n`));
    assert.ok(problems.some((p) => p.includes("Required level")), `${line}: ${problems.join("; ")}`);
  }
});
