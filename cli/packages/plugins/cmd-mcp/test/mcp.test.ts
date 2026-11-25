import test from "node:test";
import assert from "node:assert/strict";
import { handle, TOOLS, type Grant, type Runner } from "../src/index.js";

function runner(): Runner & { calls: string[][]; spawned: string[][] } {
  const calls: string[][] = [];
  const spawned: string[][] = [];
  return {
    calls,
    spawned,
    async call(argv) {
      calls.push(argv);
      return { ok: true, data: { argv } };
    },
    spawn(argv) {
      spawned.push(argv);
    },
    async findRunByKey() {
      return "go-1";
    },
  };
}
const read: Grant = { operate: false, allowAuto: false };
const op: Grant = { operate: true, allowAuto: false };
const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name, arguments: args } });

test("initialize and tools/list: read-only hides operate tools", async () => {
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, read, runner());
  assert.equal((init!.result as { serverInfo: { name: string } }).serverInfo.name, "mstack");
  const list = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, read, runner()))!.result as { tools: { name: string }[] };
  assert.ok(list.tools.every((t) => TOOLS.find((x) => x.name === t.name)!.access === "read"));
  const all = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, op, runner()))!.result as { tools: unknown[] };
  assert.equal(all.tools.length, TOOLS.length);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, read, runner()), undefined);
});

test("an operate tool called on a read-only server is refused even if the caller knows its name", async () => {
  const r = runner();
  const res = (await handle(call("mstack_run_stop", { run: "go-1" }), read, r))!.result as { isError: boolean };
  assert.equal(res.isError, true);
  assert.equal(r.calls.length + r.spawned.length, 0);
});

test("run start: detached, keyed, no --auto unless the server allows it; flags cannot be smuggled in", async () => {
  const r = runner();
  const ok = (await handle(call("mstack_run_start", { intent: "fix the flaky test", until: "verify" }), op, r))!.result as { content: { text: string }[] };
  const sent = JSON.parse(ok.content[0].text);
  assert.equal(sent.run, "go-1");
  assert.deepEqual(r.spawned[0].slice(0, 2), ["go", "fix the flaky test"]);
  assert.ok(r.spawned[0].includes("--key"));
  assert.ok(!r.spawned[0].includes("--auto"));

  const denied = (await handle(call("mstack_run_start", { intent: "x", auto: true }), op, r))!.result as { isError: boolean; content: { text: string }[] };
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /allow-auto/);
  const allowed = runner();
  await handle(call("mstack_run_start", { intent: "x", auto: true }), { operate: true, allowAuto: true }, allowed);
  assert.ok(allowed.spawned[0].includes("--auto"));

  const flag = (await handle(call("mstack_run_start", { intent: "--yes rm" }), op, r))!.result as { isError: boolean };
  assert.equal(flag.isError, true);
  const badId = (await handle(call("mstack_run_status", { run: "../../etc" }), op, r))!.result as { isError: boolean };
  assert.equal(badId.isError, true);
});

test("read tools map to mola commands", async () => {
  const r = runner();
  await handle(call("mstack_run_diff", { run: "go-1", checkpoint: "implement", stat: true }), read, r);
  await handle(call("mstack_usage", { days: 30, by: "day" }), read, r);
  assert.deepEqual(r.calls, [["go", "diff", "go-1", "implement", "--stat"], ["usage", "--days", "30", "--by", "day"]]);
  const unknown = await handle(call("nope", {}), read, r);
  assert.equal((unknown!.error as { code: number }).code, -32602);
});
