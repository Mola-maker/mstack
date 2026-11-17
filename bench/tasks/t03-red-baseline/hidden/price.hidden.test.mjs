import test from "node:test";
import assert from "node:assert/strict";
import { formatPrice } from "../src/price.mjs";

test("cases from the README", () => {
  assert.equal(formatPrice(1999), "$19.99");
  assert.equal(formatPrice(5), "$0.05");
  assert.equal(formatPrice(0), "$0.00");
  assert.equal(formatPrice(-350), "-$3.50");
});
test("non-integers throw TypeError", () => {
  for (const v of [1.5, "100", NaN, undefined]) assert.throws(() => formatPrice(v), TypeError, String(v));
});
