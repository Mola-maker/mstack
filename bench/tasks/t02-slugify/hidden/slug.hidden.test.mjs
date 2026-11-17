import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.mjs";

test("the visible case", () => assert.equal(slugify("Café au  lait, s'il vous plaît!"), "cafe-au-lait-s-il-vous-plait"));
test("accents", () => assert.equal(slugify("Crème Brûlée à l'orange"), "creme-brulee-a-l-orange"));
test("runs collapse", () => assert.equal(slugify("a---b___c   d"), "a-b-c-d"));
test("edges are trimmed", () => assert.equal(slugify("  --Hello, World!--  "), "hello-world"));
test("digits stay", () => assert.equal(slugify("Top 10 of 2026"), "top-10-of-2026"));
test("empty result", () => {
  assert.equal(slugify(""), "untitled");
  assert.equal(slugify("!!! ???"), "untitled");
});
