import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as api from "../src/api.mjs";
import { dispatch } from "../src/routes.mjs";

test("fetchUser exists, getUser is gone", () => {
  assert.equal(typeof api.fetchUser, "function");
  assert.equal(api.getUser, undefined);
});
test("dispatch still reaches the handler", () => {
  assert.equal(dispatch("GET /user", 2).name, "Lin");
  assert.equal(dispatch("GET /user", 99), null);
});
test("no getUser left in the sources", () => {
  for (const f of ["api.mjs", "routes.mjs", "routes.json"]) assert.doesNotMatch(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"), /getUser/, f);
});
