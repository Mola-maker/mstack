/**
 * config.test.ts — instance resolution (defaults + ~/.mola/config.jsonc
 * override) and the setup fix hints from superagent-ops.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveInstances, setupHint, DEFAULT_INSTANCES, INSTANCES_CONFIG_KEY } from "../src/config.js";
import { errOf, makeFakeCtx } from "./fake.js";

test("defaults: layerfs 3082, cad2gis 3083 on 127.0.0.1", () => {
  assert.deepEqual(DEFAULT_INSTANCES, { layerfs: 3082, cad2gis: 3083 });
  const f = makeFakeCtx();
  const instances = resolveInstances(f.ctx.config);
  assert.deepEqual(instances, [
    { name: "layerfs", port: 3082, url: "http://127.0.0.1:3082" },
    { name: "cad2gis", port: 3083, url: "http://127.0.0.1:3083" },
  ]);
});

test("override with port numbers replaces the default set", () => {
  const f = makeFakeCtx({ config: { [INSTANCES_CONFIG_KEY]: { layerfs: 4000, staging: 4001 } } });
  const instances = resolveInstances(f.ctx.config);
  assert.deepEqual(instances, [
    { name: "layerfs", port: 4000, url: "http://127.0.0.1:4000" },
    { name: "staging", port: 4001, url: "http://127.0.0.1:4001" },
  ]);
});

test("override with {url} keeps a non-default host and derives the port", () => {
  const f = makeFakeCtx({
    config: { [INSTANCES_CONFIG_KEY]: { cad2gis: { url: "http://10.0.0.5:3083/" }, layerfs: 3082 } },
  });
  const instances = resolveInstances(f.ctx.config);
  assert.deepEqual(instances.find((i) => i.name === "cad2gis"), {
    name: "cad2gis",
    port: 3083,
    url: "http://10.0.0.5:3083",
  });
});

test("bad values → CONFIG_INVALID (exit 65)", () => {
  for (const bad of [
    { layerfs: "3082" },
    { layerfs: { port: "x" } },
    { cad2gis: { url: "ftp://nope" } },
  ]) {
    const f = makeFakeCtx({ config: { [INSTANCES_CONFIG_KEY]: bad } });
    const err = errOf(
      (() => {
        try {
          resolveInstances(f.ctx.config);
          return null;
        } catch (e) {
          return e;
        }
      })()!,
    );
    assert.equal(err.code, "CONFIG_INVALID");
    assert.equal(err.exitCode, 65);
  }
});

test("setupHint: the exact operator commands from superagent-ops.md", () => {
  assert.match(setupHint("agentCliSignedOut", 3082), /gh-agent auth login/);
  const repo = setupHint("repositoryUnset", 3083);
  assert.match(repo, /configure\.mjs/);
  assert.match(repo, /--port 3083/);
  assert.match(repo, /--allow Mola-maker/);
  assert.match(setupHint("somethingNew", 3082), /superagent-ops\.md/);
});
