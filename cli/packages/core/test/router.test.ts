import test from "node:test";
import assert from "node:assert/strict";
import { CommandRouter, IoImpl, MolaError } from "@mola/core";

function makeRouter() {
  return new CommandRouter({ traceId: "t-test" });
}

function quietIo(): IoImpl {
  // json mode: human output is diverted to stderr; tests assert on exit codes
  const io = new IoImpl(true, true, "t-test", process.cwd(), false);
  return io;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: any) => (out.push(String(s)), true);
  process.stderr.write = (s: any) => (err.push(String(s)), true);
  try {
    const code = await fn();
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("longest registered path wins", async () => {
  const r = makeRouter();
  r.register({ path: ["plugin"], description: "short", handler: async (_a, io) => (io.data("short"), 0) }, "a");
  r.register({ path: ["plugin", "list"], description: "long", handler: async (_a, io) => (io.data("long"), 0) }, "b");
  const res = await capture(() => r.dispatch(["plugin", "list"], quietIo()));
  assert.equal(res.code, 0);
  const envelope = JSON.parse(res.stdout);
  assert.equal(envelope.command, "plugin list");
  assert.equal(envelope.data, "long");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.traceId, "t-test");
});

test("unknown command exits 64 with a stderr error", async () => {
  const r = makeRouter();
  r.register({ path: ["doctor"], description: "d", handler: async () => 0 }, "x");
  const res = await capture(() => r.dispatch(["nope"], quietIo()));
  assert.equal(res.code, 64);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /COMMAND_NOT_FOUND/);
});

test("duplicate path registration is a plan-time conflict (exit 65)", () => {
  const r = makeRouter();
  r.register({ path: ["doctor"], description: "d", handler: async () => 0 }, "a");
  assert.throws(
    () => r.register({ path: ["doctor"], description: "d2", handler: async () => 0 }, "b"),
    (err: any) => err instanceof MolaError && err.code === "COMMAND_CONFLICT" && err.exitCode === 65,
  );
});

test("aliases come from config, not code", async () => {
  const r = makeRouter();
  r.register({ path: ["plugin", "list"], description: "l", handler: async (_a, io) => (io.data("listed"), 0) }, "x");
  const res = await capture(() => r.dispatch(["pl"], quietIo(), { pl: "plugin list" }));
  assert.equal(res.code, 0);
  assert.equal(JSON.parse(res.stdout).data, "listed");
});

test("handler MolaError maps to its exit code; positionals and flags reach the handler", async () => {
  const r = makeRouter();
  let got: any;
  r.register(
    {
      path: ["plugin", "validate"],
      description: "v",
      handler: async (args) => {
        got = args;
        throw new MolaError("MANIFEST_INVALID", "bad", 65);
      },
    },
    "x",
  );
  const res = await capture(() => r.dispatch(["plugin", "validate", "/tmp/x", "--strict"], quietIo()));
  assert.equal(res.code, 65);
  assert.deepEqual(got.positionals, ["/tmp/x"]);
  assert.deepEqual(got.flags, { strict: true });
  assert.match(res.stderr, /MANIFEST_INVALID/);
});

test("help lists registered commands, grouped, with examples", async () => {
  const r = makeRouter();
  r.register({ path: ["doctor"], description: "health checks", handler: async () => 0 }, "x");
  r.register({ path: ["plugin", "list"], description: "installed plugins", handler: async () => 0 }, "y");
  const res = await capture(() => r.dispatch([], quietIo()));
  assert.equal(res.code, 0);
  assert.match(res.stdout, /doctor\s+health checks/);
  assert.match(res.stdout, /plugin list\s+installed plugins/);
  assert.match(res.stdout, /Overview/);
  assert.match(res.stdout, /mola dash/);
  assert.doesNotMatch(res.stdout, /\x1b\[/);
});

test("human mode prints data as a table only when the handler wrote nothing", async () => {
  const r = makeRouter();
  r.register(
    {
      path: ["show"],
      description: "s",
      handler: async (_a, io) => {
        io.data({ agent: "dsh", route: "group/smart-split" });
        return 0;
      },
    },
    "x",
  );
  const io = new IoImpl(false, false, "t-test", process.cwd(), false);
  const res = await capture(() => r.dispatch(["show"], io));
  assert.equal(res.code, 0);
  assert.match(res.stdout, /agent\s+dsh/);
  assert.match(res.stdout, /route\s+group\/smart-split/);
  assert.doesNotMatch(res.stdout, /\{/);
});

test("human mode does not repeat data when the handler already wrote", async () => {
  const r = makeRouter();
  r.register(
    {
      path: ["show"],
      description: "s",
      handler: async (_a, io) => {
        io.out("hello");
        io.data({ secret: 1 });
        return 0;
      },
    },
    "x",
  );
  const io = new IoImpl(false, false, "t-test", process.cwd(), false);
  const res = await capture(() => r.dispatch(["show"], io));
  assert.equal(res.code, 0);
  assert.equal(res.stdout, "hello\n");
});
