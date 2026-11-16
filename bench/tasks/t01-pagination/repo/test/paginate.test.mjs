import test from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.mjs";

test("first page of five items, size two", () => {
  assert.deepEqual(paginate(["a", "b", "c", "d", "e"], 1, 2), ["a", "b"]);
});
