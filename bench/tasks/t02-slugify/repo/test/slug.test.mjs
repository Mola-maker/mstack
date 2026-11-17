import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.mjs";

test("a title with an accent, a comma and double spaces", () => {
  assert.equal(slugify("Café au  lait, s'il vous plaît!"), "cafe-au-lait-s-il-vous-plait");
});
