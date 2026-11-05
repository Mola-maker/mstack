import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolvePlugin,
  resolvePlugins,
  planLoad,
  activateAll,
  createNullLogger,
} from "@mola/core";

function makePluginDir(id: string, extra: Record<string, unknown> = {}, entryJs?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mola-plug-${id}-`));
  const manifest = {
    schemaVersion: 1,
    id,
    version: "0.1.0",
    kind: "command",
    entry: { ts: "./entry.js" },
    ...extra,
  };
  fs.writeFileSync(path.join(dir, "mola-plugin.json"), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(dir, "entry.js"),
    entryJs ?? `export default { activate(ctx) { globalThis.__molaTestActivated ??= []; globalThis.__molaTestActivated.push(${JSON.stringify(id)}); } };`,
  );
  return dir;
}

test("resolvePlugin validates the manifest (bad manifest → error string)", () => {
  const dir = makePluginDir("mola-test-good");
  const r = resolvePlugin({ dir, tier: "builtin" });
  assert.notEqual(typeof r, "string");
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "mola-plug-bad-"));
  fs.writeFileSync(path.join(bad, "mola-plugin.json"), JSON.stringify({ id: "x" }));
  const r2 = resolvePlugin({ dir: bad, tier: "builtin" });
  assert.equal(typeof r2, "string");
  assert.match(r2 as string, /schemaVersion/);
  const missing = resolvePlugin({ dir: path.join(os.tmpdir(), "does-not-exist-mola"), tier: "builtin" });
  assert.match(missing as string, /missing mola-plugin.json/);
});

test("planLoad: topo sort over provides/requires; conflicts and cycles are errors", () => {
  const a = resolvePlugin({ dir: makePluginDir("mola-a", { provides: ["cap:a"] }), tier: "builtin" });
  const b = resolvePlugin({ dir: makePluginDir("mola-b", { requires: ["cap:a"] }), tier: "builtin" });
  assert.notEqual(typeof a, "string");
  assert.notEqual(typeof b, "string");
  const plan = planLoad([b as any, a as any]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.order.map((p) => p.manifest.id), ["mola-a", "mola-b"]);

  const missing = resolvePlugin({ dir: makePluginDir("mola-c", { requires: ["cap:nope"] }), tier: "builtin" });
  const plan2 = planLoad([missing as any]);
  assert.equal(plan2.ok, false);
  assert.match(plan2.errors[0], /requires "cap:nope"/);

  const d1 = resolvePlugin({ dir: makePluginDir("mola-d1", { provides: ["cap:d1"], requires: ["cap:d2"] }), tier: "builtin" });
  const d2 = resolvePlugin({ dir: makePluginDir("mola-d2", { provides: ["cap:d2"], requires: ["cap:d1"] }), tier: "builtin" });
  const plan3 = planLoad([d1 as any, d2 as any]);
  assert.equal(plan3.ok, false);
  assert.ok(plan3.errors.some((e) => e.includes("cycle")));

  const e1 = resolvePlugin({ dir: makePluginDir("mola-e1", { conflicts: ["mola-e2"] }), tier: "builtin" });
  const e2 = resolvePlugin({ dir: makePluginDir("mola-e2"), tier: "builtin" });
  const plan4 = planLoad([e1 as any, e2 as any]);
  assert.ok(plan4.errors.some((e) => e.includes("conflicts")));
});

test("resolvePlugins rejects duplicate ids", () => {
  const d1 = makePluginDir("mola-dup");
  const d2 = makePluginDir("mola-dup");
  const r = resolvePlugins([{ dir: d1, tier: "builtin" }, { dir: d2, tier: "builtin" }]);
  assert.equal(r.resolved.length, 1);
  assert.ok(r.errors.some((e) => e.includes("duplicate plugin id")));
});

test("activateAll: activates in order; a throwing plugin is quarantined, boot continues", async () => {
  (globalThis as any).__molaTestActivated = [];
  const good = resolvePlugin({ dir: makePluginDir("mola-good"), tier: "builtin" }) as any;
  const bad = resolvePlugin({
    dir: makePluginDir("mola-bad", {}, `export default { activate() { throw new Error("nope"); } };`),
    tier: "builtin",
  }) as any;
  const plan = planLoad([good, bad]);
  const activated: string[] = [];
  const quarantined: string[] = [];
  let disposed = 0;
  const result = await activateAll(plan, {
    makeContext: () =>
      ({
        dispose() {},
        async runDisposers() {
          disposed++;
        },
      }) as any,
    onActivated: (p) => activated.push(p.manifest.id),
    onQuarantined: (p) => quarantined.push(p.manifest.id),
    log: createNullLogger(),
  });
  assert.deepEqual(activated, ["mola-good"]);
  assert.deepEqual(quarantined, ["mola-bad"]);
  assert.deepEqual((globalThis as any).__molaTestActivated, ["mola-good"]);
  assert.equal(result.length, 1);
  assert.equal(disposed, 1); // the half-activated plugin's ctx was unwound
  await result[0].disposeAll();
});
