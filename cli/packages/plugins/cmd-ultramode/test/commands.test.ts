/**
 * Command tests for the ultramode skeleton (unit 1): the command registers,
 * status reports the mode with no goal active, and a goal argument is
 * refused outright until the run loop lands in unit 2.
 */

import test from "node:test";
import assert from "node:assert/strict";
import plugin, { ULTRAMODE_STAGES } from "../src/index.js";
import { errOf, makeFakeCtx, makeIo } from "./fake.js";

function activate() {
  const f = makeFakeCtx();
  plugin.activate(f.ctx);
  const cmd = f.commands.find((c) => c.path.join(" ") === "ultramode")!;
  assert.ok(cmd, "ultramode command is registered");
  return { ...f, cmd };
}

test("ultramode: registers with the mode description", () => {
  const { cmd } = activate();
  assert.match(cmd.description, /long-run mode/);
});

test("ultramode: status with no goal exits 0 and reports the stages", async () => {
  const { cmd } = activate();
  const io = makeIo();
  const code = await cmd.handler({ positionals: [], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.dataValue as Record<string, unknown>;
  assert.equal(data.mode, "ultramode");
  assert.deepEqual(data.stages, [...ULTRAMODE_STAGES]);
  assert.equal(data.activeGoal, null);
  assert.equal(data.shippingNeedsGrant, true);
  assert.match(io.outLines.join("\n"), /no goal active/);
});

test("ultramode: a goal argument is refused until the run loop lands", async () => {
  const { cmd } = activate();
  const io = makeIo();
  await assert.rejects(
    cmd.handler({ positionals: ["ship the fix"], flags: {} }, io),
    (e: unknown) => {
      const err = errOf(e);
      assert.equal(err.code, "UNSUPPORTED_CAPABILITY");
      assert.equal(err.exitCode, 69);
      assert.match(err.message, /loop lands in unit 2/);
      return true;
    },
  );
});

test("ultramode: --json status carries the same data, no human lines", async () => {
  const { cmd } = activate();
  const io = makeIo({ json: true });
  const code = await cmd.handler({ positionals: [], flags: {} }, io);
  assert.equal(code, 0);
  assert.equal(io.outLines.length, 0);
  assert.equal((io.dataValue as Record<string, unknown>).mode, "ultramode");
});
