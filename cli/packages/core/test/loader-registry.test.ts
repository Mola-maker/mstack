/**
 * The B2 additions to the loader: the ~/.mola/plugins.json registry, the
 * permission diff and the SHA-512 integrity pin (ADR-0002 §2, core §5).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  diffPermissions,
  formatPermissionDiff,
  hashPluginFile,
  hashPluginTree,
  listPluginFiles,
  pluginsInstallDir,
  pluginsRegistryFile,
  readPluginRegistry,
  scanUserPlugins,
  writePluginRegistry,
  createNullLogger,
} from "@mola/core";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mola-core-home-"));
}

function makePluginDir(id: string, permissions?: Record<string, string[]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mola-core-${id}-`));
  fs.writeFileSync(
    path.join(dir, "mola-plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version: "0.1.0",
      kind: "command",
      entry: { ts: "./entry.js" },
      ...(permissions ? { permissions } : {}),
    }),
  );
  fs.writeFileSync(path.join(dir, "entry.js"), "export default { activate() {} };\n");
  return dir;
}

// ----------------------------------------------------------- permission diff

test("diffPermissions: a fresh install shows the full set as added", () => {
  const diff = diffPermissions(undefined, {
    "process.exec": ["claude"],
    "fs.read": ["~/.claude/**"],
    mola: ["events"],
  });
  assert.equal(diff.escalates, true);
  assert.deepEqual(diff.added, [
    { permission: "process.exec", added: ["claude"], removed: [] },
    { permission: "fs.read", added: ["~/.claude/**"], removed: [] },
    { permission: "mola", added: ["events"], removed: [] },
  ]);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(formatPermissionDiff(diff), [
    "+ process.exec: claude",
    "+ fs.read: ~/.claude/**",
    "+ mola: events",
  ]);
});

test("diffPermissions: an update shows only what changed, in both directions", () => {
  const diff = diffPermissions(
    { "process.exec": ["claude"], mola: ["events", "config.read"] },
    { "process.exec": ["claude", "dsh"], mola: ["events"] },
  );
  assert.deepEqual(diff.added, [{ permission: "process.exec", added: ["dsh"], removed: [] }]);
  assert.deepEqual(diff.removed, [{ permission: "mola", added: [], removed: ["config.read"] }]);
  assert.deepEqual(formatPermissionDiff(diff), ["+ process.exec: dsh", "- mola: config.read"]);
});

test("diffPermissions: identical sets produce no diff at all", () => {
  const set = { mola: ["events"], "fs.read": ["**"] };
  const diff = diffPermissions(set, { ...set });
  assert.equal(diff.escalates, false);
  assert.deepEqual(formatPermissionDiff(diff), []);
});

// ----------------------------------------------------------------- the pin

test("hashPluginTree: the pin changes when a file changes, is added or removed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-hash-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "one");
  fs.writeFileSync(path.join(dir, "b.txt"), "two");
  const h1 = hashPluginTree(dir);
  assert.match(h1, /^[0-9a-f]{128}$/);

  // identical content, identical hash
  assert.equal(hashPluginTree(dir), h1);

  // an edited file changes the hash
  fs.writeFileSync(path.join(dir, "b.txt"), "two!");
  const h2 = hashPluginTree(dir);
  assert.notEqual(h2, h1);

  // an added file changes the hash
  fs.writeFileSync(path.join(dir, "c.txt"), "three");
  const h3 = hashPluginTree(dir);
  assert.notEqual(h3, h2);

  // a removed file changes the hash back
  fs.rmSync(path.join(dir, "c.txt"));
  assert.equal(hashPluginTree(dir), h2);
});

test("hashPluginTree: node_modules and dot-directories are not part of the pin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-hash2-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "one");
  const h1 = hashPluginTree(dir);
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "x");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref");
  assert.equal(hashPluginTree(dir), h1, "dependency state is not plugin content");
});

test("listPluginFiles: POSIX-relative, sorted, node_modules skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-list-"));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "b.txt"), "b");
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "x.js"), "x");
  assert.deepEqual(listPluginFiles(dir), ["a.txt", "sub/b.txt"]);
});

test("hashPluginFile: the sha512 of a single file (the tarball case)", () => {
  const file = path.join(tmpHome(), "plugin.tgz");
  fs.writeFileSync(file, "hello");
  const hash = hashPluginFile(file);
  assert.equal(hash.length, 128);
  assert.match(hash, /^[0-9a-f]{128}$/);
  // the well-known sha512 of "hello"
  assert.equal(
    hash,
    "9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca7" +
      "2323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043",
  );
});

// ------------------------------------------------------------- the registry

test("the registry round-trips through ~/.mola/plugins.json", () => {
  const home = tmpHome();
  assert.deepEqual(readPluginRegistry(home), {});
  writePluginRegistry(home, {
    "mola-x-0.1.0": {
      id: "mola-x",
      version: "0.1.0",
      kind: "command",
      tier: "untrusted",
      dir: "mola-x-0.1.0",
      source: "./x",
      sha512: "a".repeat(128),
      permissions: { mola: ["events"] },
      enabled: true,
      installedAt: "2026-11-05T00:00:00.000Z",
    },
  });
  const registry = readPluginRegistry(home);
  assert.equal(registry["mola-x-0.1.0"].tier, "untrusted");
  assert.equal(registry["mola-x-0.1.0"].sha512, "a".repeat(128));
  assert.equal(pluginsRegistryFile(home), path.join(home, "plugins.json"));
  assert.equal(pluginsInstallDir(home), path.join(home, "plugins"));
});

test("a broken plugins.json is ignored, not fatal", () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, "plugins.json"), "{not json");
  assert.deepEqual(readPluginRegistry(home, createNullLogger()), {});
});

test("scanUserPlugins honours the recorded tier, grant and the enabled flag", () => {
  const home = tmpHome();
  const pluginsDir = path.join(home, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  const dir = makePluginDir("mola-scanned", { mola: ["events"] });
  fs.cpSync(dir, path.join(pluginsDir, "mola-scanned-0.1.0"), { recursive: true });

  writePluginRegistry(home, {
    "mola-scanned-0.1.0": {
      id: "mola-scanned",
      version: "0.1.0",
      kind: "command",
      tier: "untrusted",
      dir: "mola-scanned-0.1.0",
      source: "./scanned",
      permissions: { mola: ["events"] },
      enabled: true,
      installedAt: "2026-11-05T00:00:00.000Z",
    },
  });

  const log = createNullLogger();
  const sources = scanUserPlugins(home, log);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].tier, "untrusted");
  assert.deepEqual(sources[0].granted, { mola: ["events"] });

  // disabled → not resolved any more, but the files stay
  const registry = readPluginRegistry(home);
  registry["mola-scanned-0.1.0"].enabled = false;
  writePluginRegistry(home, registry);
  assert.equal(scanUserPlugins(home, log).length, 0);
  assert.ok(fs.existsSync(path.join(pluginsDir, "mola-scanned-0.1.0", "mola-plugin.json")));
});
