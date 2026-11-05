import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, writeGlobalConfig, MolaError } from "@mola/core";

function setup(): { home: string; project: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mola-cfg-"));
  const home = path.join(base, "home");
  const project = path.join(base, "proj");
  fs.mkdirSync(path.join(project, ".mola"), { recursive: true });
  return { home, project };
}

test("config: layer order builtin < global < project < env", () => {
  const { home, project } = setup();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.jsonc"),
    `// user config\n{ "log": { "level": "warn" }, "x": 1, "gone": "yes" }`,
  );
  fs.writeFileSync(path.join(project, ".mola", "config.jsonc"), `{ "x": 2, "gone": null }`);
  const env: Record<string, string> = { MOLA_LOG_LEVEL: "debug" };
  const c = loadConfig({ homeDir: home, projectDir: project, env });
  assert.equal(c.get("log.level"), "debug"); // env wins
  assert.equal(c.get("x"), 2); // project over global
  assert.equal(c.get("gone"), undefined); // null deletes
  assert.equal(c.get("color"), true); // builtin default survives
  c.close();
});

test("config: all() is frozen; has() reflects the merged view", () => {
  const { home, project } = setup();
  const c = loadConfig({ homeDir: home, projectDir: project, env: {} });
  assert.ok(c.has("log.level"));
  assert.ok(Object.isFrozen(c.all()));
  assert.throws(() => {
    (c.all() as any).log = {};
  });
  c.close();
});

test("config: bad global file is fatal with CONFIG_INVALID/65", () => {
  const { home, project } = setup();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.jsonc"), "{ nope");
  assert.throws(
    () => loadConfig({ homeDir: home, projectDir: project, env: {} }),
    (err: any) => err instanceof MolaError && err.code === "CONFIG_INVALID" && err.exitCode === 65,
  );
});

test("writeGlobalConfig sets dotted keys and preserves siblings", () => {
  const { home } = setup();
  writeGlobalConfig(home, "aliases.d", "doctor");
  writeGlobalConfig(home, "log.level", "debug");
  const written = JSON.parse(fs.readFileSync(path.join(home, "config.jsonc"), "utf8"));
  assert.deepEqual(written, { aliases: { d: "doctor" }, log: { level: "debug" } });
});

test("config: --config extra file merges at the flags layer", () => {
  const { home, project } = setup();
  const extra = path.join(project, "extra.jsonc");
  fs.writeFileSync(extra, `{ "x": 99 }`);
  const c = loadConfig({ homeDir: home, projectDir: project, env: {}, extraFile: extra });
  assert.equal(c.get("x"), 99);
  c.close();
});
