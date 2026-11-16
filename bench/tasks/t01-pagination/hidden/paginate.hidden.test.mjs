import test from "node:test";
import assert from "node:assert/strict";
import { pageCount, paginate } from "../src/paginate.mjs";

const xs = ["a", "b", "c", "d", "e"];
test("every page", () => {
  assert.deepEqual(paginate(xs, 1, 2), ["a", "b"]);
  assert.deepEqual(paginate(xs, 2, 2), ["c", "d"]);
  assert.deepEqual(paginate(xs, 3, 2), ["e"]);
});
test("past the last page is empty", () => assert.deepEqual(paginate(xs, 4, 2), []));
test("size larger than the list", () => assert.deepEqual(paginate(xs, 1, 10), xs));
test("bad page or size throws RangeError", () => {
  for (const [p, s] of [[0, 2], [-1, 2], [1, 0], [1.5, 2], [1, 2.5], [NaN, 2]]) assert.throws(() => paginate(xs, p, s), RangeError, `${p},${s}`);
});
test("pageCount rounds up", () => {
  assert.equal(pageCount(5, 2), 3);
  assert.equal(pageCount(4, 2), 2);
  assert.equal(pageCount(0, 2), 0);
});
