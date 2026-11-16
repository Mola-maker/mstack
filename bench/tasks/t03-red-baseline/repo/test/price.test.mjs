import test from "node:test";
import assert from "node:assert/strict";
import { formatPrice } from "../src/price.mjs";

test("formats cents", () => assert.equal(formatPrice(1999), "$19.99"));
