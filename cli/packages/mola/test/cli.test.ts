import { openStateStore } from "@mola/core";
/**
 * Golden-ish CLI integration tests (core §9): fixture HOME (MOLA_HOME points at
 * a tmp dir), run `node dist/bin.js <cmd> --json`, assert envelope stability,
 * exit codes, and stderr cleanliness.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin.js", import.meta.url));

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mola-home-"));
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], home: string, cwd?: string): Run {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: cwd ?? os.tmpdir(),
    env: { ...process.env, MOLA_HOME: home },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function envelope(r: Run): any {
  assert.notEqual(r.stdout.trim(), "", "expected a JSON envelope on stdout");
  return JSON.parse(r.stdout.trim());
}

test("plugin list --json: envelope with the B1 builtin plugins, exit 0", () => {
  const r = run(["plugin", "list", "--json"], tmpHome());
  assert.equal(r.status, 0, r.stderr);
  const env = envelope(r);
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.command, "plugin list");
  assert.ok(typeof env.traceId === "string" && env.traceId.length > 0);
  const ids = env.data.map((p: any) => p.id).sort();
  assert.deepEqual([...ids].sort(), ["mola-agent-dsh", "mola-cmd-config", "mola-cmd-dispatch", "mola-cmd-doctor", "mola-cmd-model", "mola-cmd-plugin", "mola-cmd-rtk", "mola-policy-approval", "mola-tool-git", "mola-tool-magpie", "mola-tool-rtk", "mola-agent-claude", "mola-agent-codex", "mola-rec-runs", "mola-cmd-run", "mola-tool-superagent", "mola-cmd-dash", "mola-cmd-go", "mola-cmd-web", "mola-policy-guard", "mola-cmd-scout", "mola-cmd-tui"].sort());
  for (const p of env.data) {
    assert.equal(p.tier, "builtin");
    assert.equal(p.state, "active");
    assert.ok(["command", "agent", "tool", "policy"].includes(p.kind));
  }
});

test("doctor --json: node>=22 and plugins.plan-ok pass (overall exit depends on the host's agents)", () => {
  const r = run(["doctor", "--json"], tmpHome());
  assert.ok(r.status === 0 || r.status === 69, r.stderr);
  const env = envelope(r);
  assert.equal(env.command, "doctor");
  const checks = Object.fromEntries(env.data.checks.map((c: any) => [c.id, c]));
  assert.equal(checks["node>=22"].ok, true);
  assert.equal(checks["plugins.plan-ok"].ok, true);
});

test("config set/get roundtrip against the fixture HOME", () => {
  const home = tmpHome();
  const set = run(["config", "set", "test.answer", "42"], home);
  assert.equal(set.status, 0, set.stderr);
  const get = run(["config", "get", "test.answer", "--json"], home);
  assert.equal(get.status, 0, get.stderr);
  assert.deepEqual(envelope(get).data, { key: "test.answer", value: 42 });
  assert.ok(fs.existsSync(path.join(home, "config.jsonc")));
});

test("config set refuses secret-shaped keys (exit 77)", () => {
  const r = run(["config", "set", "providers.api_key", "sk-xxx", "--json"], tmpHome());
  assert.equal(r.status, 77);
  assert.equal(r.stdout.trim(), "");
  const err = JSON.parse(r.stderr.trim());
  assert.equal(err.error.code, "SECRET_REFUSED");
});

test("config get of a missing key exits 66 with a clean stdout", () => {
  const r = run(["config", "get", "missing.key", "--json"], tmpHome());
  assert.equal(r.status, 66);
  assert.equal(r.stdout.trim(), "");
  assert.equal(JSON.parse(r.stderr.trim()).error.code, "CONFIG_KEY_NOT_FOUND");
});

test("plugin validate: bad manifest → 65, good manifest → 0, missing → 66", () => {
  const home = tmpHome();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mola-fixture-"));

  const badDir = path.join(base, "bad");
  fs.mkdirSync(badDir);
  fs.writeFileSync(path.join(badDir, "mola-plugin.json"), JSON.stringify({ id: "x" }));
  const bad = run(["plugin", "validate", badDir, "--json"], home);
  assert.equal(bad.status, 65);
  assert.equal(bad.stdout.trim(), "");
  assert.equal(JSON.parse(bad.stderr.trim()).error.code, "MANIFEST_INVALID");

  const goodDir = path.join(base, "good");
  fs.mkdirSync(goodDir);
  fs.writeFileSync(
    path.join(goodDir, "mola-plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "mola-fixture-good",
      version: "0.0.1",
      kind: "command",
      entry: { ts: "./dist/index.js" },
    }),
  );
  const good = run(["plugin", "validate", goodDir, "--json"], home);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(envelope(good).data.valid, true);

  const missing = run(["plugin", "validate", path.join(base, "nope"), "--json"], home);
  assert.equal(missing.status, 66);
});

test("unknown command exits 64; human mode prints help on empty argv", () => {
  const home = tmpHome();
  const unknown = run(["frobnicate", "--json"], home);
  assert.equal(unknown.status, 64);
  assert.equal(JSON.parse(unknown.stderr.trim()).error.code, "COMMAND_NOT_FOUND");

  const help = run([], home);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /doctor/);
  assert.match(help.stdout, /plugin list/);
});

test("human-mode plugin list prints id/version/kind/tier/state lines", () => {
  const r = run(["plugin", "list"], tmpHome());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mola-cmd-doctor\s+0\.1\.0\s+command\s+builtin\s+active/);
});

test("run history is recorded in the state store keyed by traceId", () => {
  const home = tmpHome();
  const r = run(["plugin", "list", "--json"], home);
  assert.equal(r.status, 0, r.stderr);
  const traceId = envelope(r).traceId;
  // the store is SQLite (state.db) since B2, JSON fallback otherwise: read it through core
  const store = openStateStore(home);
  const rec: any = store.runs(1000).find((x: any) => x.traceId === traceId);
  assert.ok(rec, "the state store records the run");
  assert.equal(rec.command, "plugin list");
  assert.equal(rec.exitCode, 0);
});

test("MOLA_LOG_LEVEL env maps into the log layer; log file carries traceId", () => {
  const home = tmpHome();
  const r = spawnSync(process.execPath, [BIN, "plugin", "list", "--json"], {
    encoding: "utf8",
    cwd: os.tmpdir(),
    env: { ...process.env, MOLA_HOME: home, MOLA_LOG_LEVEL: "debug" },
  });
  assert.equal(r.status ?? 1, 0, r.stderr);
  const traceId = JSON.parse((r.stdout ?? "").trim()).traceId;
  const log = fs.readFileSync(path.join(home, "logs", "mola.log"), "utf8");
  assert.match(log, new RegExp(`"traceId":"${traceId}"`));
});
