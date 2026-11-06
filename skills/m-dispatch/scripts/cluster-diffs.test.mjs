import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clusterDiffs, main } from "./cluster-diffs.mjs";

const BODY = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n";

test("strict majority of identical diffs, index line ignored", () => {
  const clustered = clusterDiffs([
    { name: "a.patch", text: `index aaaabbbb..ccccdddd 100644\n${BODY}` },
    { name: "b.patch", text: BODY.replace(/\n/g, "\r\n") },
    { name: "c.patch", text: BODY.replace("+new", "+other") },
  ]);
  assert.deepEqual(clustered.majority, ["a.patch", "b.patch"]);
  assert.equal(clustered.tie, false);
  assert.equal(clustered.clusters.length, 2);
});

test("tie when no cluster has more than half", () => {
  const clustered = clusterDiffs([
    { name: "a.patch", text: "one\n" },
    { name: "b.patch", text: "two\n" },
    { name: "c.patch", text: "one\n" },
    { name: "d.patch", text: "two\n" },
  ]);
  assert.equal(clustered.majority, null);
  assert.equal(clustered.tie, true);
});

test("whitespace inside a hunk stays a different cluster", () => {
  const clustered = clusterDiffs([
    { name: "a.patch", text: "+new\n" },
    { name: "b.patch", text: "+new \n" },
  ]);
  assert.equal(clustered.majority, null);
  assert.equal(clustered.clusters.length, 2);
});

test("cli prints majority and usage fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "m-dispatch-"));
  const left = join(dir, "a.patch");
  const right = join(dir, "b.patch");
  writeFileSync(left, BODY);
  writeFileSync(right, BODY);
  const result = main([left, right]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).majority, [left, right]);

  const script = fileURLToPath(new URL("./cluster-diffs.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /usage: node "<this skill dir>\/scripts\/cluster-diffs\.mjs"/);
});
