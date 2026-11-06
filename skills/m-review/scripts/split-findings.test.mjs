import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addedFileRecord, splitFindings, main } from "./split-findings.mjs";

const DIFF = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -10,3 +10,4 @@
 context
-old
+new
 context
diff --git a/src/gone.js b/src/gone.js
--- a/src/gone.js
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;

test("repro confirms, missing repro does not count", () => {
  const text = `# review
FINDING src/a.js:11 | off-by-one | last row dropped
REPRO node t.js → expected 3 got 2

FINDING src/a.js:12 | maybe a race | two writers
CLEARED src/a.js:11 | rename is the point of this function
`;
  const parsed = splitFindings(text, DIFF);
  assert.equal(parsed.counts.confirmed, 1);
  assert.equal(parsed.counts.unconfirmed, 1);
  assert.equal(parsed.counts.cleared, 1);
  assert.equal(parsed.conclusion.length, 1);
  assert.equal(parsed.confirmed[0].repro.output, "expected 3 got 2");
  assert.equal(parsed.confirmed[0].inScope, true);
});

test("context lines and unknown files are out of scope", () => {
  const text = `FINDING src/a.js:10 | stale comment | readers misled
REPRO true → ok
FINDING src/other.js:1 | missing | breaks import
REPRO true → ok
FINDING src/gone.js:0 | removed helper | callers throw
REPRO node caller.js → cannot find helper
`;
  const parsed = splitFindings(text, DIFF);
  assert.equal(parsed.counts.outOfScope, 2);
  assert.equal(parsed.conclusion.length, 1);
  assert.equal(parsed.conclusion[0].file, "src/gone.js");
});

test("arrow with an empty side is an error", () => {
  const parsed = splitFindings("FINDING src/a.js:11 | bad | breaks\nREPRO node t.js →\n", null);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.counts.confirmed, 0);
});

test("cli exits 1 when a confirmed finding is outside the diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "m-review-"));
  const report = join(dir, "report.md");
  const diff = join(dir, "change.diff");
  writeFileSync(report, "FINDING src/a.js:10 | stale | misleads\nREPRO true → ok\n");
  writeFileSync(diff, DIFF);
  // This checkout's own untracked files must not leak into the fixture.
  const result = main([report, "--diff", diff], undefined, () => new Map());
  assert.equal(result.code, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.counts.conclusion, 0);
});

test("cli usage exits 2", () => {
  const script = fileURLToPath(new URL("./split-findings.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /usage: node "<this skill dir>\/scripts\/split-findings\.mjs"/);
});

test("an untracked file's existing lines are in scope; a line past EOF is not", () => {
  const extra = new Map([["newfile.js", addedFileRecord("export const n = 1;\n")]]);
  const text = `FINDING newfile.js:1 | dropped | suite misses the new file
REPRO node t.js → expected 1 got 0
FINDING newfile.js:9 | no such line | nothing
REPRO true → ok
`;
  const parsed = splitFindings(text, "", extra);
  assert.equal(parsed.counts.conclusion, 1);
  assert.equal(parsed.counts.outOfScope, 1);
  assert.equal(parsed.conclusion[0].file, "newfile.js");
  assert.equal(parsed.conclusion[0].inScope, true);
});

test("empty git diff still keeps a finding in an untracked file (review repro)", () => {
  const dir = mkdtempSync(join(tmpdir(), "m-review-untracked-"));
  const git = (...args) => {
    const r = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q");
  writeFileSync(join(dir, "newfile.js"), "export const n = 1;\n");
  const report = join(dir, "report.md");
  const diff = join(dir, "d.patch");
  writeFileSync(report, "FINDING newfile.js:1 | dropped | suite misses the new file\nREPRO node t.js → expected 1 got 0\n");
  writeFileSync(diff, "");
  const script = fileURLToPath(new URL("./split-findings.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [script, report, "--diff", diff], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const body = JSON.parse(child.stdout);
  assert.equal(body.counts.conclusion, 1);
  assert.equal(body.counts.outOfScope, 0);
  assert.equal(body.conclusion[0].inScope, true);
});
