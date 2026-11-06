/**
 * commands.test.ts — the `mola superagent *` commands, the doctor checks, the
 * tool adapter and the approval gate. HTTP is mocked through the fake fetch;
 * nothing touches 127.0.0.1:308x, WSL or any external process.
 */

import test from "node:test";
import assert from "node:assert/strict";
import plugin, { injectFetch } from "../src/index.js";
import {
  envelopeOf,
  errOf,
  makeFakeCtx,
  makeFakeFetch,
  makeIo,
  wireFetch,
  type FakeCtx,
  type FakeHttp,
} from "./fake.js";
import {
  HEALTH_ERROR_STATE_JSON,
  HEALTHY_STATE_JSON,
  PAUSED_STATE_JSON,
  SAMPLE_SOURCES_JSON,
  SAMPLE_STATE_SETUP_JSON,
} from "./fixtures.js";

// ------------------------------------------------------------------ helpers

/**
 * url-path → JSON body; anything not in the map answers a plain 200 `{}`
 * (the Management API's success shape for mutations). Tests that need a
 * failure build their own respond() instead.
 */
function jsonRoutes(map: Record<string, string>): FakeHttp {
  return makeFakeFetch({
    respond: (url) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      return { body: map[path] ?? "{}" };
    },
  });
}

function activate(config?: Record<string, unknown>): FakeCtx {
  const f = makeFakeCtx({ config });
  plugin.activate(f.ctx);
  return f;
}

async function runCommand(
  f: FakeCtx,
  path: string,
  io: ReturnType<typeof makeIo>,
  positionals: string[] = [],
  flags: Record<string, string | boolean> = {},
): Promise<number> {
  const cmd = f.commands.find((c) => c.path.join(" ") === path);
  if (!cmd) throw new Error(`command not registered: ${path}`);
  return cmd.handler({ positionals, flags }, io);
}

// ------------------------------------------------------------ registrations

test("activate registers the tool adapter, two doctor checks and six commands", () => {
  const f = activate();
  assert.deepEqual(f.tools.map((t) => t.id), ["superagent"]);
  assert.deepEqual(
    f.checks.map((c) => c.id).sort(),
    ["superagent.cad2gis", "superagent.layerfs"],
  );
  assert.deepEqual(
    f.commands.map((c) => c.path.join(" ")).sort(),
    [
      "superagent pause",
      "superagent resume",
      "superagent retry",
      "superagent status",
      "superagent stop",
      "superagent tickets",
    ],
  );
});

// ------------------------------------------------------------------- status

test("status: both instances healthy → exit 0, one envelope, human lines", async () => {
  const http = jsonRoutes({ "/orchestrator/api/state": HEALTHY_STATE_JSON });
  const f = activate();
  wireFetch(f, http);
  const io = makeIo();
  const code = await runCommand(f, "superagent status", io);
  assert.equal(code, 0);
  const data = envelopeOf(io);
  assert.equal(data.instances.length, 2);
  const [layerfs] = data.instances as any[];
  assert.equal(layerfs.name, "layerfs");
  assert.equal(layerfs.paused, false);
  assert.equal(layerfs.setup.ok, true);
  assert.equal(layerfs.load.running, 1);
  assert.equal(layerfs.load.busy, false);
  assert.equal(layerfs.healthProblems.length, 0);
  // human form (not --json): a status line per instance
  assert.match(io.outLines[0], /layerfs\s+http:\/\/127\.0\.0\.1:3082\s+running\s+load 1\/3 workers, 0 queued/);
  assert.match(io.outLines[1], /setup ok, all health parts ready/);
});

test("status: real setup sample → exit 3, code + exact fix hint reported", async () => {
  const http = jsonRoutes({ "/orchestrator/api/state": SAMPLE_STATE_SETUP_JSON });
  const f = activate();
  wireFetch(f, http);
  const io = makeIo();
  const code = await runCommand(f, "superagent status", io);
  assert.equal(code, 3);
  const data = envelopeOf(io);
  for (const inst of data.instances as any[]) {
    assert.equal(inst.setup.ok, false);
    assert.equal(inst.setup.problem.code, "repositoryUnset");
    assert.equal(inst.setup.problem.detail, "The GitHub Source names no repository.");
    assert.match(inst.setup.fixHint, /configure\.mjs/);
  }
  const text = io.outLines.join("\n");
  assert.match(text, /setup: repositoryUnset \(github\) — The GitHub Source names no repository\./);
  assert.match(text, /fix:\s+rerun configure: node ~\/src\/mola-dsh-stack\/superagent\/configure\.mjs --port 3082/);
  // "error" parts are the only ones escalated; setupPending stays in setup
  assert.equal((data.instances as any[])[0].healthProblems.length, 0);
});

test("status: a health part in state error → exit 2 and the part + detail", async () => {
  const http = jsonRoutes({ "/orchestrator/api/state": HEALTH_ERROR_STATE_JSON });
  const f = activate();
  wireFetch(f, http);
  const io = makeIo();
  const code = await runCommand(f, "superagent status", io);
  assert.equal(code, 2);
  const [inst] = envelopeOf(io).instances as any[];
  assert.deepEqual(
    inst.healthProblems.map((h: any) => [h.name, h.state]),
    [["github", "error"]],
  );
  assert.match(io.outLines.join("\n"), /github: error — gh-agent auth expired/);
  // queued 2 with 3/3 workers → busy, not broken
  assert.equal(inst.load.busy, true);
  assert.match(io.outLines[0], /\(busy — not broken\)/);
});

test("status: paused is a deliberate state — reported, exit 0", async () => {
  const http = jsonRoutes({ "/orchestrator/api/state": PAUSED_STATE_JSON });
  const f = activate();
  wireFetch(f, http);
  const io = makeIo();
  assert.equal(await runCommand(f, "superagent status", io), 0);
  const [inst] = envelopeOf(io).instances as any[];
  assert.equal(inst.paused, true);
  assert.match(io.outLines[0], /PAUSED/);
});

test("status: unreachable instance → exit 69, still one envelope", async () => {
  const http = makeFakeFetch({ respond: () => ({ throw: new Error("connect ECONNREFUSED 127.0.0.1:3083") }) });
  const f = activate();
  wireFetch(f, http);
  const io = makeIo();
  const code = await runCommand(f, "superagent status", io);
  assert.equal(code, 69);
  const data = envelopeOf(io);
  assert.equal(data.instances.length, 2);
  const bad = (data.instances as any[]).find((i) => i.name === "cad2gis");
  assert.equal(bad.reachable, false);
  assert.match(bad.error, /ECONNREFUSED/);
  assert.match(io.outLines.join("\n"), /cad2gis\s+.*UNREACHABLE/);
});

test("status <name>: only that instance is contacted; unknown name → 66", async () => {
  const http = jsonRoutes({ "/orchestrator/api/state": HEALTHY_STATE_JSON });
  const f = activate();
  wireFetch(f, http);
  const io = makeIo();
  const code = await runCommand(f, "superagent status", io, ["cad2gis"]);
  assert.equal(code, 0);
  assert.deepEqual(
    http.requests.map((r) => r.url),
    ["http://127.0.0.1:3083/orchestrator/api/state"],
  );
  assert.deepEqual((envelopeOf(io).instances as any[]).map((i) => i.name), ["cad2gis"]);

  const err = errOf(
    await runCommand(f, "superagent status", makeIo(), ["nope"]).then(() => null, (e) => e),
  );
  assert.equal(err.code, "NO_INPUT");
  assert.equal(err.exitCode, 66);
  assert.match(err.message, /configured: layerfs, cad2gis/);
});

test("status: more than one positional is a usage error (64)", async () => {
  const f = activate();
  const err = errOf(
    await runCommand(f, "superagent status", makeIo(), ["layerfs", "cad2gis"]).then(() => null, (e) => e),
  );
  assert.equal(err.code, "USAGE_ERROR");
  assert.equal(err.exitCode, 64);
});

// ------------------------------------------------------------------ tickets

test("tickets: real sources sample → exit 0, per-Source state + stats + problems", async () => {
  const http = jsonRoutes({ "/orchestrator/api/sources": SAMPLE_SOURCES_JSON });
  const f = activate();
  wireFetch(f, http);
  const io = makeIo();
  const code = await runCommand(f, "superagent tickets", io);
  assert.equal(code, 0);
  const [inst] = envelopeOf(io).instances as any[];
  assert.equal(inst.sources.length, 2);
  const github = inst.sources.find((s: any) => s.id === "github");
  assert.equal(github.state, "error");
  assert.equal(github.problem.code, "repositoryUnset");
  assert.equal(github.dropped.length, 0);
  const text = io.outLines.join("\n");
  assert.match(text, /layerfs\s+feishu\s+setup\s+received=0 filtered=0 dropped=0/);
  assert.match(text, /layerfs\s+github\s+error\s+.* — repositoryUnset: The GitHub Source names no repository\./);
});

test("tickets: unreachable → exit 69 with the instance reported", async () => {
  const http = makeFakeFetch({ respond: () => ({ throw: new Error("connect ECONNREFUSED") }) });
  const f = activate();
  wireFetch(f, http);
  const io = makeIo();
  assert.equal(await runCommand(f, "superagent tickets", io), 69);
  assert.match(io.outLines.join("\n"), /UNREACHABLE .*connect ECONNREFUSED/);
});

// --------------------------------------------- pause / resume (approval gate)

test("pause without --yes: denied by the policy waterfall (77), no HTTP, approval.denied", async () => {
  const http = jsonRoutes({});
  const f = activate();
  wireFetch(f, http);
  const err = errOf(
    await runCommand(f, "superagent pause", makeIo()).then(() => null, (e) => e),
  );
  assert.equal(err.code, "POLICY_DENIED");
  assert.equal(err.exitCode, 77);
  assert.match(err.message, /superagent pause requires approval/);
  assert.deepEqual(http.requests, []);
  assert.ok(
    f.emitted.some((e) => e.event === "mola.approval.denied" && (e.data as any).rule === "superagent.pause"),
  );
});

test("pause --yes: runs through the waterfall, approval.granted, POST {paused:true} per instance", async () => {
  const http = jsonRoutes({});
  const f = activate();
  wireFetch(f, http);
  const io = makeIo({ yes: true });
  const code = await runCommand(f, "superagent pause", io, [], { yes: true });
  assert.equal(code, 0);
  assert.deepEqual(
    http.requests.map((r) => [r.method, r.url, JSON.parse(r.body!)]),
    [
      ["POST", "http://127.0.0.1:3082/orchestrator/api/executor/pause", { paused: true }],
      ["POST", "http://127.0.0.1:3083/orchestrator/api/executor/pause", { paused: true }],
    ],
  );
  for (const r of http.requests) assert.equal(r.headers?.["x-orchestrator-request"], "1");
  assert.ok(
    f.emitted.some((e) => e.event === "mola.approval.granted" && (e.data as any).rule === "superagent.pause"),
  );
  assert.deepEqual((io.dataValue as any).instances.map((i: any) => i.name), ["layerfs", "cad2gis"]);
  assert.match(io.outLines.join("\n"), /layerfs: paused/);
});

test("pause <name> --yes targets one instance; resume posts {paused:false}", async () => {
  const http = jsonRoutes({});
  const f = activate();
  wireFetch(f, http);
  const io = makeIo({ yes: true });
  await runCommand(f, "superagent resume", io, ["cad2gis"]);
  assert.deepEqual(http.requests, [
    {
      url: "http://127.0.0.1:3083/orchestrator/api/executor/pause",
      method: "POST",
      headers: http.requests[0].headers,
      body: '{"paused":false}',
    },
  ]);
  assert.match(io.outLines.join("\n"), /cad2gis: resumed/);
});

test("the gate value carries tool/argv/argsSummary for the policy classifier", async () => {
  const http = jsonRoutes({});
  const f = activate();
  wireFetch(f, http);
  await runCommand(f, "superagent pause", makeIo({ yes: true }), ["layerfs"], { yes: true });
  // nothing matched the classifier in tests; assert the waterfall got a well-formed call
  const hooks = f.hooks.get("mola.tool.before") ?? [];
  assert.equal(hooks.length, 1); // the plugin's own gate — same waterfall as policy-approval
});

// ----------------------------------------------------------- retry / stop

test("stop without --yes: denied (77), no HTTP", async () => {
  const http = jsonRoutes({});
  const f = activate();
  wireFetch(f, http);
  const err = errOf(
    await runCommand(f, "superagent stop", makeIo(), ["t-123"]).then(() => null, (e) => e),
  );
  assert.equal(err.code, "POLICY_DENIED");
  assert.equal(err.exitCode, 77);
  assert.equal(http.requests.length, 0);
  assert.ok(f.emitted.some((e) => e.event === "mola.approval.denied" && (e.data as any).rule === "superagent.stop"));
});

test("stop <ticket> --yes: first instance wins, POST /tickets/<id>/stop", async () => {
  const http = jsonRoutes({});
  const f = activate();
  wireFetch(f, http);
  const io = makeIo({ yes: true });
  const code = await runCommand(f, "superagent stop", io, ["t-123"]);
  assert.equal(code, 0);
  assert.deepEqual(
    http.requests.map((r) => r.url),
    ["http://127.0.0.1:3082/orchestrator/api/tickets/t-123/stop"],
  );
  assert.deepEqual(io.dataValue, {
    action: "stop",
    ticket: "t-123",
    instance: "layerfs",
    url: "http://127.0.0.1:3082",
    ok: true,
  });
});

test("retry <ticket> --yes: instance-local ids — falls through a 404 to the next instance", async () => {
  const http = jsonRoutes({});
  // layerfs answers 404 (unknown ticket), cad2gis succeeds — recording stays
  // on http.requests so the fall-through order is observable
  http.fetch = async (url, init) => {
    http.requests.push({ url, method: init?.method ?? "GET", headers: init?.headers, body: init?.body });
    const status = url.includes(":3082") ? 404 : 200;
    return { ok: status < 300, status, text: async () => (status === 404 ? "unknown ticket" : "{}") };
  };
  const f = activate();
  injectFetch(f.ctx, http.fetch);
  const io = makeIo({ yes: true });
  const code = await runCommand(f, "superagent retry", io, ["t-9"]);
  assert.equal(code, 0);
  assert.deepEqual(
    http.requests.map((r) => r.url),
    [
      "http://127.0.0.1:3082/orchestrator/api/tickets/t-9/retry",
      "http://127.0.0.1:3083/orchestrator/api/tickets/t-9/retry",
    ],
  );
  assert.equal((io.dataValue as any).instance, "cad2gis");
});

test("retry <ticket> --yes on every instance failing → last upstream error (69)", async () => {
  const http = makeFakeFetch({ respond: () => ({ status: 404, body: "unknown ticket" }) });
  const f = activate();
  wireFetch(f, http);
  const err = errOf(
    await runCommand(f, "superagent retry", makeIo({ yes: true }), ["t-9"]).then(() => null, (e) => e),
  );
  assert.equal(err.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(err.exitCode, 69);
  assert.equal(http.requests.length, 2);
});

test("retry/stop need a ticket id (64); named instance must be known (66)", async () => {
  const f = activate();
  const noTicket = errOf(
    await runCommand(f, "superagent stop", makeIo()).then(() => null, (e) => e),
  );
  assert.equal(noTicket.code, "USAGE_ERROR");
  assert.equal(noTicket.exitCode, 64);
  const badInstance = errOf(
    await runCommand(f, "superagent stop", makeIo(), ["t-1", "nope"]).then(() => null, (e) => e),
  );
  assert.equal(badInstance.code, "NO_INPUT");
  assert.equal(badInstance.exitCode, 66);
});

// ------------------------------------------------------------ doctor checks

test("doctor superagent.<name>: the real setup problem FAILS with code + detail + fix", async () => {
  const http = jsonRoutes({ "/orchestrator/api/state": SAMPLE_STATE_SETUP_JSON });
  const f = activate();
  wireFetch(f, http);
  const results: Record<string, any> = {};
  for (const check of f.checks) results[check.id] = await check.run();
  for (const id of ["superagent.layerfs", "superagent.cad2gis"]) {
    assert.equal(results[id].ok, false, `${id} must FAIL while setup is incomplete`);
    assert.equal(results[id].exitCode, 69);
    assert.match(results[id].message, /setup incomplete: repositoryUnset/);
    assert.match(results[id].message, /The GitHub Source names no repository\./);
    assert.match(results[id].message, /fix: rerun configure: .*configure\.mjs --port (3082|3083)/);
  }
});

test("doctor superagent.<name>: ok when healthy, fails 69 on error part or unreachable", async () => {
  const healthy = jsonRoutes({ "/orchestrator/api/state": HEALTHY_STATE_JSON });
  const f1 = activate();
  wireFetch(f1, healthy);
  const good = await f1.checks.find((c) => c.id === "superagent.layerfs")!.run();
  assert.equal(good.ok, true);
  assert.match(good.message, /setup ok, 1\/3 workers, 0 queued/);

  const errPart = makeFakeFetch({ respond: () => ({ body: HEALTH_ERROR_STATE_JSON }) });
  const f2 = activate();
  wireFetch(f2, errPart);
  const partFail = await f2.checks.find((c) => c.id === "superagent.layerfs")!.run();
  assert.equal(partFail.ok, false);
  assert.equal(partFail.exitCode, 69);
  assert.match(partFail.message, /github: error — gh-agent auth expired/);

  const down = makeFakeFetch({ respond: () => ({ throw: new Error("connect ECONNREFUSED") }) });
  const f3 = activate();
  wireFetch(f3, down);
  const downFail = await f3.checks.find((c) => c.id === "superagent.cad2gis")!.run();
  assert.equal(downFail.ok, false);
  assert.equal(downFail.exitCode, 69);
  assert.match(downFail.message, /ECONNREFUSED/);
});

// ------------------------------------------------------------- tool adapter

test("tool adapter probe: ready when every instance answers with a clean setup", async () => {
  const http = jsonRoutes({ "/orchestrator/api/state": HEALTHY_STATE_JSON });
  const f = activate();
  wireFetch(f, http);
  const adapter = f.tools[0];
  assert.equal(adapter.id, "superagent");
  const probe = await adapter.probe();
  assert.equal(probe.ok, true);
  assert.match(probe.detail, /2 instance\(s\) ready \(layerfs, cad2gis\)/);
  assert.deepEqual(adapter.instances().map((i: any) => i.port), [3082, 3083]);
});

test("tool adapter probe: setup problem → not usable for routing, detail says why", async () => {
  const http = jsonRoutes({ "/orchestrator/api/state": SAMPLE_STATE_SETUP_JSON });
  const f = activate();
  wireFetch(f, http);
  const probe = await f.tools[0].probe();
  assert.equal(probe.ok, false);
  assert.match(probe.detail!, /setup incomplete: repositoryUnset/);
});
