import test from "node:test";
import assert from "node:assert/strict";
import { deepMerge, getPath, setPath, matchesAnyGlob, globToRegExp } from "@mola/core";

test("deepMerge: later layer wins; objects merge; null deletes", () => {
  const base = { a: 1, b: { c: 2, d: 3 }, arr: [1, 2] };
  const over = { b: { c: 20 }, arr: [9], gone: null };
  assert.deepEqual(deepMerge({ ...base, gone: "x" }, over), { a: 1, b: { c: 20, d: 3 }, arr: [9] });
});

test("getPath/setPath dotted keys", () => {
  const obj: Record<string, unknown> = {};
  setPath(obj, "a.b.c", 42);
  assert.deepEqual(obj, { a: { b: { c: 42 } } });
  assert.deepEqual(getPath(obj, "a.b.c"), { found: true, value: 42 });
  setPath(obj, "a.b.c", null);
  assert.equal(getPath(obj, "a.b.c").found, false);
  assert.equal(getPath(obj, "a.b.missing").found, false);
});

test("glob: ** crosses separators, * stays in a segment, windows paths match", () => {
  assert.ok(matchesAnyGlob("/home/u/.claude/x/y.md", ["~/.claude/**".replace("~", "/home/u")]));
  assert.ok(globToRegExp("~/x/**".replace("~", "/h")).test("/h/x"));
  assert.ok(matchesAnyGlob("C:\\Users\\u\\file.txt", ["C:/Users/u/*"]));
  assert.equal(matchesAnyGlob("/etc/passwd", ["/home/**"]), false);
});
