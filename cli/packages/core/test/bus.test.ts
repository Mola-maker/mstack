import test from "node:test";
import assert from "node:assert/strict";
import { CoreEventBus, createNullLogger, PolicyDenial } from "@mola/core";

function makeBus(onQuarantine?: (owner: string, event: string, err: unknown) => void) {
  return new CoreEventBus({ log: createNullLogger(), traceId: "t-1", onQuarantine });
}

test("broadcast: a throwing handler is isolated and logged", async () => {
  const bus = makeBus();
  const seen: unknown[] = [];
  bus.on("mola.test", () => {
    throw new Error("boom");
  });
  bus.on("mola.test", (e) => {
    seen.push(e.data);
  });
  bus.emit("mola.test", { n: 1 });
  assert.deepEqual(seen, [{ n: 1 }]);
});

test("envelope shape follows ADR-0004", () => {
  const bus = makeBus();
  let got: any;
  bus.on("mola.core.boot", (e) => { got = e; });
  bus.emit("mola.core.boot", { plugins: [] });
  assert.equal(got.kind, "mola.core.boot");
  assert.equal(got.source.runId, "t-1");
  assert.ok(got.id && got.ts);
  assert.deepEqual(got.data, { plugins: [] });
});

test("waterfall: listeners rewrite in order; rejection propagates", async () => {
  const bus = makeBus();
  bus.hook("mola.tool.before", (v: any) => ({ ...v, argv: [...v.argv, "--safe"] }), "p1");
  bus.hook("mola.tool.before", (v: any) => v, "p2");
  const out = await bus.runWaterfall("mola.tool.before", { argv: ["git"] });
  assert.deepEqual(out, { argv: ["git", "--safe"] });

  bus.hook("mola.task.pre-dispatch", () => {
    throw new PolicyDenial("banned route");
  }, "policy");
  await assert.rejects(
    () => bus.runWaterfall("mola.task.pre-dispatch", { route: "deepseek/x" }),
    (err: any) => err.code === "POLICY_DENIED" && err.exitCode === 77,
  );
});

test("serial: observers run in registration order", async () => {
  const bus = makeBus();
  const order: number[] = [];
  bus.onSerial("mola.core.shutdown", async () => {
    order.push(1);
  });
  bus.onSerial("mola.core.shutdown", async () => {
    order.push(2);
  });
  await bus.runSerial("mola.core.shutdown", {});
  assert.deepEqual(order, [1, 2]);
});

test("death-loop brake: 3 consecutive failures quarantine the plugin, no 4th call", () => {
  const quarantined: string[] = [];
  const bus = makeBus((owner) => quarantined.push(owner));
  let calls = 0;
  bus.on("mola.test", () => {
    calls++;
    throw new Error("always");
  }, "bad-plugin");
  bus.emit("mola.test", {});
  bus.emit("mola.test", {});
  bus.emit("mola.test", {});
  assert.deepEqual(quarantined, ["bad-plugin"]);
  assert.equal(calls, 3);
});

test("a success resets the failure counter", () => {
  const quarantined: string[] = [];
  const bus = makeBus((owner) => quarantined.push(owner));
  let fail = true;
  bus.on("mola.test", () => {
    if (fail) throw new Error("x");
  }, "flaky");
  bus.emit("mola.test", {});
  bus.emit("mola.test", {});
  fail = false;
  bus.emit("mola.test", {});
  fail = true;
  bus.emit("mola.test", {});
  bus.emit("mola.test", {});
  assert.deepEqual(quarantined, []);
});

test("describe() inventories listeners with owners (mola hooks list data)", () => {
  const bus = makeBus();
  bus.on("mola.test", () => {}, "p1");
  bus.hook("mola.tool.before", (v) => v, "policy");
  const d = bus.describe();
  assert.deepEqual(
    d.map((x) => `${x.kind}:${x.event}:${x.owner}`).sort(),
    ["broadcast:mola.test:p1", "waterfall:mola.tool.before:policy"],
  );
});
