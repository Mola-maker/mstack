import { fileURLToPath } from "node:url";
/** `mola models rank` reads the same shared loader as `mola run` (plugin-sdk routing.ts). */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { loadRoutingFile } from "@mola/plugin-sdk";
import { loadRankTable } from "@mola/plugin-cmd-model";

const here = path.dirname(fileURLToPath(import.meta.url));

test("loadRankTable loads the real repo config/model-routing.json through the shared loader", () => {
  const t = loadRankTable({ env: {} as never, startDir: here });
  assert.equal(typeof t, "object");
  const shared = loadRoutingFile({ env: {} as never, startDir: here }).table!;
  assert.deepEqual(Object.keys((t as { tasks: object }).tasks), Object.keys(shared.tasks));
});

test("loadRankTable returns the one-line reason for a missing file", () => {
  const r = loadRankTable({ env: { MOLA_ROUTING_FILE: "/nonexistent/r.json" } as never });
  assert.equal(typeof r, "string");
  assert.ok((r as string).startsWith("cannot read ") && (r as string).includes("r.json"), r as string); // OS-native path in the message
});
