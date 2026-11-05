/**
 * cmd-rtk argv tests: the passthrough must not reshape its arguments, so the
 * raw token stream is the primary source and the parsed view is only a
 * fallback. Both are pure functions — no process is spawned here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { rawTokens, reconstruct } from "@mola/plugin-cmd-rtk";

test("rawTokens returns everything after the command name, verbatim", () => {
  const argv = ["--json", "rtk", "bypass", "git", "status", "--porcelain", "--", "weird name"];
  assert.deepEqual(rawTokens("rtk", argv), ["bypass", "git", "status", "--porcelain", "--", "weird name"]);
});

test("rawTokens finds the command name wherever the bin left it", () => {
  assert.deepEqual(rawTokens("rtk", ["mola", "-v", "rtk", "gain"]), ["gain"]);
});

test("rawTokens returns null when the name is absent (alias invocation)", () => {
  assert.equal(rawTokens("rtk", ["r", "gain"]), null);
  assert.equal(rawTokens("rtk", []), null);
});

test("rawTokens only looks at the first occurrence", () => {
  assert.deepEqual(rawTokens("rtk", ["rtk", "bypass", "rtk", "gain"]), ["bypass", "rtk", "gain"]);
});

test("reconstruct rebuilds positionals and flags from the parsed view", () => {
  assert.deepEqual(
    reconstruct({ positionals: ["bypass", "git", "status"], flags: { porcelain: true } }),
    ["bypass", "git", "status", "--porcelain"],
  );
  assert.deepEqual(
    reconstruct({ positionals: [], flags: { format: "%h" } }),
    ["--format", "%h"],
  );
});
