import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv } from "@mola/plugin-sdk";

test("parseArgv splits positionals and flags", () => {
  const r = parseArgv(["tasks/a.md", "--json", "--route", "group/smart-split", "--n=3"]);
  assert.deepEqual(r.positionals, ["tasks/a.md"]);
  assert.deepEqual(r.flags, { json: true, route: "group/smart-split", n: "3" });
});

test("parseArgv honors the -- separator and boolean shorts", () => {
  const r = parseArgv(["-q", "--", "--not-a-flag"]);
  assert.deepEqual(r.flags, { q: true });
  assert.deepEqual(r.positionals, ["--not-a-flag"]);
});
