import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, stripJsonc, MolaError } from "@mola/core";

test("jsonc: comments and trailing commas are stripped", () => {
  const text = `{
    // line comment
    "a": 1, /* block */
    "b": [1, 2,],
  }`;
  assert.deepEqual(parseJsonc(text), { a: 1, b: [1, 2] });
});

test("jsonc: comment markers inside strings survive", () => {
  const r = parseJsonc(`{"url": "https://x//y", "g": "a/*b*/", "e": "\\"}"}`);
  assert.deepEqual(r, { url: "https://x//y", g: "a/*b*/", e: '"}' });
});

test("jsonc: invalid input throws CONFIG_INVALID (exit 65)", () => {
  assert.throws(() => parseJsonc("{ nope", "test"), (err: any) => {
    assert.ok(err instanceof MolaError);
    assert.equal(err.code, "CONFIG_INVALID");
    assert.equal(err.exitCode, 65);
    return true;
  });
});

test("stripJsonc keeps escaped quotes inside strings", () => {
  assert.equal(stripJsonc(`"a\\" // not a comment"`), `"a\\" // not a comment"`);
});
