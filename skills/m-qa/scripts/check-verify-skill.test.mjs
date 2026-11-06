// Tests for check-verify-skill.mjs. Run: node --test "skills/m-qa/scripts/*.test.mjs"
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { checkVerifySkill } from "./check-verify-skill.mjs";

const script = new URL("./check-verify-skill.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const repoOf = (dir) => basename(join(dir, "..", "..", ".."));
const skillFor = (dir) => `---
name: ${repoOf(dir)}-verify
description: "Drive the sample app from a cold start."
---

# Verify sample

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
`;

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

function tree(dir, { skillBody = skillFor(dir), featureBody = feature, readme = "# Map\n\n- [Create](./create.md)\n" } = {}) {
  mkdirSync(join(dir, "features"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillBody);
  writeFileSync(join(dir, "features", "README.md"), readme);
  if (featureBody !== null) writeFileSync(join(dir, "features", "create.md"), featureBody);
}

test("a complete driver passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "m-qa-"));
  tree(dir);
  const problems = checkVerifySkill(dir);
  if (problems.length) throw new Error(problems.join("; "));
});

test("missing sections, placeholders, and a thin feature fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "m-qa-"));
  tree(dir, {
    skillBody: skillFor(dir).replace("## Doctor\nRead-only health check.\n\n", "").replace("sample app", "{{APP}}"),
    featureBody: "# Create\n\n## Gotchas\n- no\n",
  });
  const problems = checkVerifySkill(dir);
  for (const needle of ["{{placeholders}}", "missing heading ## Doctor", "Sub-features"]) {
    if (!problems.some((p) => p.includes(needle))) throw new Error(`missing ${needle}: ${problems}`);
  }
});

test("cli exits 0 on ok and 1 on a broken tree", () => {
  const good = mkdtempSync(join(tmpdir(), "m-qa-"));
  const bad = mkdtempSync(join(tmpdir(), "m-qa-"));
  tree(good);
  tree(bad, { featureBody: null, readme: "# Map\n" });
  const ok = spawnSync(process.execPath, [script, good], { encoding: "utf8" });
  if (ok.status !== 0 || ok.stdout.trim() !== "ok") throw new Error(`expected ok, got ${ok.status}: ${ok.stdout}`);
  const fail = spawnSync(process.execPath, [script, bad], { encoding: "utf8" });
  if (fail.status !== 1) throw new Error(`expected 1, got ${fail.status}: ${fail.stdout}`);
});

test("a bare name: verify collides and is rejected; <repo>-verify is required (bug regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "m-qa-"));
  tree(dir, { skillBody: skillFor(dir).replace(`${repoOf(dir)}-verify`, "verify") });
  const problems = checkVerifySkill(dir);
  if (!problems.some((p) => p.includes(`expected ${repoOf(dir)}-verify`))) throw new Error(`expected name rejection, got: ${problems}`);
  const good = mkdtempSync(join(tmpdir(), "m-qa-"));
  tree(good);
  const ok = checkVerifySkill(good);
  if (ok.length) throw new Error(`expected pass for ${repoOf(good)}-verify, got: ${ok}`);
});
