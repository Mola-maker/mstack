import test from "node:test";
import assert from "node:assert/strict";
import { legacyRound } from "../src/price.mjs";

test("legacy currency rounding is half-even", () => {
  assert.equal(legacyRound(2.5), 2);
});
