/**
 * cmd-dispatch tests. Everything external (bash/wsl, dsh, the file system) is
 * mocked: exec is a scripted fake, files live in an in-memory map, and the
 * policy gates are fake waterfall listeners. No test runs dsh, wsl or magpie.
 */

import test from "node:test";
import assert from "node:assert/strict";
import plugin, {
  buildBashScript,
  dispatchArgv,
  extractFinalText,
  overlayYaml,
  winToWslPath,
  wslFileRef,
} from "../src/index.js";
import { DEFAULT_ROUTE } from "../src/platform.js";
import { makeFakeCtx, makeIo, errOf, type FakeExec } from "./fake.js";

// POSIX paths and WSL detection: these run on Linux (WSL, CI); skipped on a Windows host.
const linuxTest = process.platform === "win32" ? test.skip : test;

const NDJSON = [
  JSON.stringify({ type: "session", sessionId: "s-1" }),
  JSON.stringify({ type: "tool", name: "read", path: "tasks/b1-smoke.md" }),
  JSON.stringify({ type: "result", result: "mola-b1-ok" }),
  "",
].join("\n");

function activate() {
  const f = makeFakeCtx();
  plugin.activate(f.ctx);
  const cmd = f.commands.find((c) => c.path.join(" ") === "dispatch")!;
  return { ...f, cmd };
}

// ---------------------------------------------------------------- pure parts

linuxTest("overlay: the magpie model overlay, default route and override", () => {
  assert.equal(overlayYaml(DEFAULT_ROUTE), "- id: agent-default-model\n  config:\n    provider: magpie\n    model: group/smart-split\n");
  assert.match(overlayYaml("auto/kimi-k3"), /model: auto\/kimi-k3\n$/);
});

linuxTest("script: the tested headless invocation, stdin variant without `<`", () => {
  const s = buildBashScript({ cwdPosix: "/mnt/e/mstack", overlayPath: ".mstack/runs/r1/model-overlay.yml", taskPath: "tasks/b1-smoke.md" });
  assert.match(s, /^\[ -f ~\/src\/mola-dsh-stack\/scripts\/env\.sh \] && source ~\/src\/mola-dsh-stack\/scripts\/env\.sh; cd '\/mnt\/e\/mstack'; dsh --profile mola-cli --patch '\.mstack\/runs\/r1\/model-overlay\.yml' --json - < 'tasks\/b1-smoke\.md'$/);
  const stdin = buildBashScript({ cwdPosix: "/mnt/e/mstack", overlayPath: "o.yml" });
  assert.match(stdin, /--json -$/);
  assert.doesNotMatch(stdin, / < /);
});

linuxTest("argv: wsl -e bash -lc on Windows, bash -lc inside Linux/WSL", () => {
  assert.deepEqual(dispatchArgv("echo hi", true), ["wsl", "-u", "root", "-e", "bash", "-lc", "echo hi"]);
  assert.deepEqual(dispatchArgv("echo hi", false), ["bash", "-lc", "echo hi"]);
});

linuxTest("paths: E:\\ maps to /mnt/e/, cwd-relative refs stay relative", () => {
  assert.equal(winToWslPath("E:\\mstack"), "/mnt/e/mstack");
  assert.equal(winToWslPath("e:\\mstack\\tasks\\b1.md"), "/mnt/e/mstack/tasks/b1.md");
  assert.equal(winToWslPath("/not/a/drive"), null);
  assert.equal(wslFileRef("E:\\mstack", "E:\\mstack\\tasks\\b1.md", true), "tasks/b1.md");
  assert.equal(wslFileRef("E:\\mstack", "E:\\other\\x.md", true), "/mnt/e/other/x.md");
  assert.equal(wslFileRef("/mnt/e/mstack", "/mnt/e/mstack/tasks/b1.md", false), "tasks/b1.md");
});

linuxTest("ndjson: the final answer is the last result event; plain stdout falls through", () => {
  assert.equal(extractFinalText(NDJSON).finalText, "mola-b1-ok");
  assert.equal(extractFinalText(NDJSON).events.length, 3);
  assert.equal(extractFinalText("just the answer\n").finalText, "just the answer");
});

// ------------------------------------------------------------ command tests

const HAPPY_EXEC: FakeExec = async (argv) => {
  assert.equal(argv[0], "bash");
  assert.equal(argv[1], "-lc");
  assert.match(argv[argv.length - 1], /dsh --profile mola-cli --patch/);
  assert.match(argv[argv.length - 1], /--json/);
  return { code: 0, stdout: NDJSON, stderr: "" };
};

function happyCtx() {
  const f = activate();
  f.ctx.process.exec = ((argv: string[], opts: Record<string, unknown> = {}) => {
    f.calls.push({ argv, opts });
    return HAPPY_EXEC(argv, opts);
  }) as never;
  f.files.set("/fake/ws/tasks/b1-smoke.md", "Reply with exactly: mola-b1-ok\n");
  return f;
}

linuxTest("dispatch: happy path — overlay, log ending exit=0, state run, task.done, answer printed", async () => {
  const f = happyCtx();
  const io = makeIo();
  const code = (await f.cmd.handler({ positionals: ["tasks/b1-smoke.md"], flags: {} }, io)) as number;

  assert.equal(code, 0);
  // overlay written with the default route (provider magpie)
  const overlay = f.files.get("/fake/ws/.mstack/runs/trace-test-0000-0000/model-overlay.yml")!;
  assert.match(overlay, /provider: magpie\n/);
  assert.match(overlay, /model: group\/smart-split\n/);
  // log ends with exit=N
  const log = f.files.get("/fake/ws/logs/dispatch-trace-test-0000-0000.out")!;
  assert.match(log, /mola-b1-ok/);
  assert.ok(log.endsWith("exit=0\n"), log.slice(-40));
  // run recorded in state
  const run = f.kv["run:trace-test-0000-0000"] as Record<string, unknown>;
  assert.equal(run.exitCode, 0);
  assert.equal(run.modelRoute, "group/smart-split");
  assert.equal(run.logFile, "logs/dispatch-trace-test-0000-0000.out");
  // canonical events
  const kinds = f.emitted.map((e) => e.event);
  assert.ok(kinds.includes("mola.session.started"));
  assert.ok(kinds.includes("mola.task.done"));
  assert.ok(kinds.includes("mola.session.ended"));
  // the worker's final answer is printed; data carries the envelope fields
  assert.deepEqual(io.outLines, ["mola-b1-ok"]);
  assert.equal((io.dataValue as Record<string, unknown>).finalText, "mola-b1-ok");
});

linuxTest("dispatch: --route overrides the overlay model", async () => {
  const f = happyCtx();
  f.files.set("/fake/ws/tasks/b1-smoke.md", "task");
  const io = makeIo();
  await f.cmd.handler({ positionals: ["tasks/b1-smoke.md"], flags: { route: "auto/kimi-k3" } }, io);
  const overlay = f.files.get("/fake/ws/.mstack/runs/trace-test-0000-0000/model-overlay.yml")!;
  assert.match(overlay, /model: auto\/kimi-k3\n$/);
});

linuxTest("dispatch: missing task file → NO_INPUT, exit 66, no worker started", async () => {
  const f = activate();
  const io = makeIo();
  const err = errOf(await f.cmd.handler({ positionals: ["tasks/none.md"], flags: {} }, io).catch((e) => e));
  assert.equal(err.code, "NO_INPUT");
  assert.equal(err.exitCode, 66);
  assert.equal(f.calls.length, 0);
});

linuxTest("dispatch: empty stdin task → NO_INPUT", async () => {
  const f = activate();
  // simulate empty stdin by monkey-patching fs.readFileSync? simpler: empty file
  f.files.set("/fake/ws/tasks/empty.md", "");
  const err = errOf(
    await f.cmd.handler({ positionals: ["tasks/empty.md"], flags: {} }, makeIo()).catch((e) => e),
  );
  assert.equal(err.code, "NO_INPUT");
});

linuxTest("dispatch: banned route is rejected at task.pre-dispatch before any worker starts", async () => {
  const f = happyCtx();
  f.hooks.set("mola.task.pre-dispatch", [
    (value: { modelRoute: string }) => {
      if (value.modelRoute.startsWith("deepseek/")) {
        throw Object.assign(new Error("banned route: deepseek/*"), { code: "ROUTE_BANNED", exitCode: 77 });
      }
      return value;
    },
  ]);
  const err = errOf(
    await f.cmd
      .handler(
        { positionals: ["tasks/b1-smoke.md"], flags: { route: "deepseek/deepseek-chat" } },
        makeIo(),
      )
      .catch((e) => e),
  );
  assert.equal(err.code, "ROUTE_BANNED");
  assert.equal(err.exitCode, 77);
  assert.equal(f.calls.length, 0, "no worker may start");
  assert.equal(f.emitted.filter((e) => e.event === "mola.session.started").length, 0);
});

linuxTest("dispatch: the pre-dispatch gate can rewrite the route before the overlay is written", async () => {
  const f = happyCtx();
  f.files.set("/fake/ws/tasks/b1-smoke.md", "task");
  f.hooks.set("mola.task.pre-dispatch", [(v: { modelRoute: string }) => ({ ...v, modelRoute: "auto/kimi-k3" })]);
  await f.cmd.handler({ positionals: ["tasks/b1-smoke.md"], flags: {} }, makeIo());
  const overlay = f.files.get("/fake/ws/.mstack/runs/trace-test-0000-0000/model-overlay.yml")!;
  assert.match(overlay, /model: auto\/kimi-k3\n$/);
});

linuxTest("dispatch: tool.before gate runs before the worker spawn", async () => {
  const f = happyCtx();
  const seen: unknown[] = [];
  f.hooks.set("mola.tool.before", [(v: unknown) => (seen.push(v), v)]);
  f.files.set("/fake/ws/tasks/b1-smoke.md", "task");
  await f.cmd.handler({ positionals: ["tasks/b1-smoke.md"], flags: {} }, makeIo());
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { tool: string }).tool, "dsh");
});

linuxTest("dispatch: worker failure — log ends with exit=N, code propagates, error.raised", async () => {
  const f = activate();
  f.ctx.process.exec = (async () => ({ code: 3, stdout: "", stderr: "boom\n" })) as never;
  f.files.set("/fake/ws/tasks/b1-smoke.md", "task");
  const io = makeIo();
  const code = (await f.cmd.handler({ positionals: ["tasks/b1-smoke.md"], flags: {} }, io)) as number;
  assert.equal(code, 3);
  const log = f.files.get("/fake/ws/logs/dispatch-trace-test-0000-0000.out")!;
  assert.ok(log.endsWith("exit=3\n"), log.slice(-40));
  assert.ok(f.emitted.some((e) => e.event === "mola.error.raised"));
  assert.equal(f.emitted.filter((e) => e.event === "mola.task.done").length, 0);
});

linuxTest("dispatch: --agent other than dsh is a 66 in B1", async () => {
  const f = activate();
  const err = errOf(
    await f.cmd.handler({ positionals: ["tasks/x.md"], flags: { agent: "claude" } }, makeIo()).catch((e) => e),
  );
  assert.equal(err.code, "NO_INPUT");
  assert.equal(err.exitCode, 66);
});

linuxTest("dispatch: no positional → usage error 64", async () => {
  const f = activate();
  const err = errOf(await f.cmd.handler({ positionals: [], flags: {} }, makeIo()).catch((e) => e));
  assert.equal(err.code, "USAGE_ERROR");
  assert.equal(err.exitCode, 64);
});
