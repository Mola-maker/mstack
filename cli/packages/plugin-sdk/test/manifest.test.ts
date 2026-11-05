import test from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "@mola/plugin-sdk";

const good = {
  schemaVersion: 1,
  id: "mola-cmd-demo",
  version: "0.1.0",
  kind: "command",
  entry: { ts: "./dist/index.js" },
  provides: ["cmd:demo"],
  requires: [],
  permissions: { mola: ["events", "commands"] },
  hooks: { emit: ["mola.command.started"], listen: [] },
};

test("validateManifest accepts a valid manifest", () => {
  const r = validateManifest(good);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.manifest?.id, "mola-cmd-demo");
});

test("validateManifest accepts a Rust sidecar entry", () => {
  const r = validateManifest({
    ...good,
    id: "mola-syncd",
    kind: "sync",
    entry: { bin: "./bin/mola-syncd", protocol: "jsonrpc-stdio" },
  });
  assert.equal(r.ok, true);
});

test("validateManifest rejects non-objects and bad ids", () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest({ ...good, id: "Bad ID" }).ok, false);
});

test("validateManifest rejects missing fields, bad kind, bad entry", () => {
  const { schemaVersion: _s, ...noSchema } = good;
  assert.ok(validateManifest(noSchema).errors.some((e) => e.includes("schemaVersion")));
  assert.ok(validateManifest({ ...good, kind: "agent-adapter" }).errors.some((e) => e.includes("kind")));
  assert.ok(validateManifest({ ...good, entry: {} }).errors.some((e) => e.includes("entry")));
  assert.ok(
    validateManifest({ ...good, entry: { ts: "./x.js", bin: "./x" } }).errors.some((e) =>
      e.includes("both"),
    ),
  );
  assert.ok(
    validateManifest({ ...good, entry: { bin: "./x" } }).errors.some((e) => e.includes("protocol")),
  );
});

test("validateManifest rejects bad permissions and arrays", () => {
  assert.ok(
    validateManifest({ ...good, permissions: { "fs.eat": ["*"] } }).errors.some((e) =>
      e.includes("unknown key"),
    ),
  );
  assert.ok(
    validateManifest({ ...good, provides: "agent:claude" }).errors.some((e) =>
      e.includes("provides"),
    ),
  );
  assert.ok(
    validateManifest({ ...good, permissions: { mola: "events" } }).errors.some((e) =>
      e.includes("permissions.mola"),
    ),
  );
});
