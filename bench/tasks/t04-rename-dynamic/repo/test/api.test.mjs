import test from "node:test";
import assert from "node:assert/strict";
import { fetchUser } from "../src/api.mjs";

test("fetchUser finds a user", () => assert.equal(fetchUser(1).name, "Ada"));
