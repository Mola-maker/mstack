import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  approvalPath,
  displayWidth,
  parseArgv,
  readApproval,
  runDir,
  writeApproval,
  writeProgress,
  type Approval,
  type Io,
  type RunProgress,
} from "@mola/plugin-sdk";
import plugin, {
  applyEffects,
  buildLaunch,
  cwdFlags,
  ENTER_SEQ,
  initialState,
  loadRuns,
  loadSnapshot,
  onceFrame,
  parseKeys,
  reduce,
  render,
  RESTORE_SEQ,
  runKey,
  runTui,
  trunc,
  type Event,
  type State,
  type TuiIO,
} from "@mola/plugin-cmd-tui";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mola-tui-"));
const iso = (msAgo = 0): string => new Date(Date.now() - msAgo).toISOString();

function run(cwd: string, id: string, extra: Partial<RunProgress> = {}): RunProgress {
  const p: RunProgress = {
    schemaVersion: 1,
    id,
    intent: "fix the bug",
    cwd,
    status: "running",
    startedAt: iso(120_000),
    updatedAt: iso(),
    stage: "implement",
    stages: [
      { name: "plan", status: "done", model: "opus", costUsd: 0.1, artifact: "plan.md" },
      { name: "implement", status: "running", model: "sonnet", costUsd: 0.2 },
      { name: "verify", status: "pending" },
      { name: "review", status: "skipped" },
    ],
    workers: [
      { id: "w1", stage: "implement", status: "working", model: "sonnet", startedAt: iso(90_000), costUsd: 0.2, lastLine: "editing src/a.ts" },
      { id: "w2", stage: "plan", status: "done", model: "opus", startedAt: iso(120_000), updatedAt: iso(60_000), costUsd: 0.1 },
    ],
    costUsd: 0,
    ...extra,
  };
  writeProgress(p);
  if (extra.updatedAt) {
    // writeProgress stamps "now"; put the requested time back so ordering tests are deterministic
    p.updatedAt = extra.updatedAt;
    fs.writeFileSync(path.join(runDir(cwd, id), "progress.json"), JSON.stringify(p));
  }
  return p;
}

function blockedRun(cwd: string, id: string, action = "git push origin feat/x and open a PR"): void {
  run(cwd, id, {
    status: "blocked",
    stage: "ship",
    blocked: { reason: "needs approval to push", approvalId: "ap1" },
  });
  const a: Approval = { id: "ap1", runId: id, stage: "ship", action, status: "pending", createdAt: iso() };
  writeApproval(cwd, a);
}

function stateFor(cwd: string, size = { cols: 120, rows: 40 }): State {
  const s = initialState([cwd], size, Date.now());
  return reduce(s, { type: "data", ...loadSnapshot([cwd]), now: Date.now() });
}

const keys = (s: State, ...ks: string[]): State => ks.reduce((acc, key) => reduce(acc, { type: "key", key }), s);
const widths = (lines: string[]): number[] => [...new Set(lines.map((l) => displayWidth(l)))];

// ------------------------------------------------------------------- render

test("render 120x40: wide layout with all panes, exact size, no escapes", () => {
  const cwd = tmp();
  run(cwd, "r-alpha", { intent: "add a login page" });
  run(cwd, "r-beta", { updatedAt: iso(5000), status: "done", stage: "ship" });
  fs.writeFileSync(path.join(runDir(cwd, "r-alpha"), "events.jsonl"), '{"t":1,"msg":"started"}\n{"t":2,"msg":"edited a.ts"}\n');
  const lines = render(stateFor(cwd), { cols: 120, rows: 40, color: false });
  assert.equal(lines.length, 40);
  assert.deepEqual(widths(lines), [120]);
  const text = lines.join("\n");
  assert.ok(!text.includes("\x1b"));
  for (const want of ["Runs (2)", "r-alpha", "add a login page", "r-beta", "Pipeline · r-alpha", "✔ plan", "Workers (2)", "editing src/a.ts", "Log · events.jsonl", "edited a.ts", "a approve", "q quit", "│"]) {
    assert.ok(text.includes(want), `missing ${want}\n${text}`);
  }
  // the first line carries the progress line of the run
  assert.ok(text.includes("go ▸ implement"));
  // side by side: the pipeline pane sits on the same row as the runs pane
  const row = lines.find((l) => l.includes("Pipeline"))!;
  assert.ok(row.indexOf("Runs") === 2 || lines.some((l) => l.includes("r-alpha") && l.includes("│")));
});

test("render 60x30: stacked panes, exact size", () => {
  const cwd = tmp();
  run(cwd, "r-alpha");
  const lines = render(stateFor(cwd, { cols: 60, rows: 30 }), { cols: 60, rows: 30, color: false });
  assert.equal(lines.length, 30);
  assert.deepEqual(widths(lines), [60]);
  const at = (needle: string): number => lines.findIndex((l) => l.includes(needle));
  const [runs, pipe, work, log] = [at("Runs ("), at("Pipeline"), at("Workers ("), at("Log")];
  assert.ok(runs >= 0 && runs < pipe && pipe < work && work < log, `order ${runs} ${pipe} ${work} ${log}`);
  assert.ok(!lines.some((l) => l.includes("│")), "stacked layout has no vertical separator");
});

test("render with color keeps width and adds escapes; selected row is reverse video", () => {
  const cwd = tmp();
  run(cwd, "r-alpha");
  const lines = render(stateFor(cwd), { cols: 100, rows: 30, color: true });
  assert.ok(lines.join("").includes("\x1b["));
  assert.ok(lines.join("").includes("\x1b[7m"));
  assert.deepEqual(widths(lines), [100]);
});

test("render truncates by display width with wide CJK characters", () => {
  assert.equal(trunc("你好世界", 5), "你好…");
  assert.equal(displayWidth(trunc("你好世界", 5)), 5);
  assert.equal(trunc("abc", 5), "abc");
  const cwd = tmp();
  run(cwd, "r-cjk", { intent: "修复登录页面的一个非常长的中文描述用来测试宽字符截断是否正确" });
  run(cwd, "r-cjk2", { intent: "所有字符都是全角：ＡＢＣ", updatedAt: iso(9000) });
  for (const size of [{ cols: 120, rows: 30 }, { cols: 60, rows: 24 }, { cols: 33, rows: 20 }]) {
    const lines = render(stateFor(cwd, size), { ...size, color: false });
    assert.deepEqual(widths(lines), [size.cols], `cols ${size.cols}`);
    assert.ok(lines.join("\n").includes("…"));
  }
});

test("render strips escape sequences that came from run files", () => {
  const cwd = tmp();
  run(cwd, "r-esc", { intent: "evil \x1b[2J\x1b]0;pwned\x07 intent" });
  const text = render(stateFor(cwd), { cols: 100, rows: 30, color: false }).join("\n");
  assert.ok(!text.includes("\x1b") && !text.includes("\x07"));
});

test("the bottom bar shows the blocked reason and the approval action", () => {
  const cwd = tmp();
  blockedRun(cwd, "r-blocked");
  const lines = render(stateFor(cwd), { cols: 120, rows: 40, color: false });
  const bar = lines[lines.length - 2];
  assert.ok(bar.includes("needs approval to push"), bar);
  assert.ok(bar.includes("git push origin feat/x and open a PR"), bar);
  assert.ok(bar.includes("[a] approve") && bar.includes("[d] deny"), bar);
  // confirm line replaces it while asking
  const asking = render(keys(stateFor(cwd), "a"), { cols: 120, rows: 40, color: false });
  assert.ok(asking[asking.length - 2].includes("Approve r-blocked: git push origin feat/x and open a PR? [y/n]"));
});

test("detail view shows the stage table and the artifacts", () => {
  const cwd = tmp();
  run(cwd, "r-alpha");
  fs.writeFileSync(path.join(runDir(cwd, "r-alpha"), "plan.md"), "# plan\n");
  const s = keys(stateFor(cwd), "enter");
  const text = render(s, { cols: 120, rows: 40, color: false }).join("\n");
  assert.ok(text.includes("Detail · r-alpha"));
  assert.ok(text.includes("stage") && text.includes("summary"));
  assert.ok(text.includes("Artifacts (") && text.includes("plan.md"));
  assert.ok(!text.includes("Workers ("));
});

test("help overlay and empty state", () => {
  const empty = initialState([tmp()], { cols: 100, rows: 24 });
  assert.ok(render(empty, { cols: 100, rows: 24, color: false }).join("\n").includes("no runs yet"));
  const help = render(keys(empty, "?"), { cols: 100, rows: 24, color: false }).join("\n");
  assert.ok(help.includes("Help") && help.includes("stop the run"));
});

test("tiny terminals do not throw and keep the exact size", () => {
  const cwd = tmp();
  run(cwd, "r-alpha");
  for (const [cols, rows] of [[20, 5], [1, 1], [200, 8], [79, 12]]) {
    const lines = render(stateFor(cwd, { cols, rows }), { cols, rows, color: false });
    assert.equal(lines.length, rows);
    assert.deepEqual(widths(lines), [cols]);
  }
});

// ------------------------------------------------------------------- reduce

test("reduce: navigation keeps selection by run key across data updates", () => {
  const cwd = tmp();
  run(cwd, "r1", { updatedAt: iso(1000) });
  run(cwd, "r2", { updatedAt: iso(2000) });
  run(cwd, "r3", { updatedAt: iso(3000) });
  let s = stateFor(cwd);
  assert.deepEqual(s.runs.map((r) => r.p.id), ["r1", "r2", "r3"]);
  assert.equal(selectedId(s), "r1");
  s = keys(s, "down", "j");
  assert.equal(selectedId(s), "r3");
  s = keys(s, "down");
  assert.equal(selectedId(s), "r3", "clamped at the end");
  s = keys(s, "up", "k", "k");
  assert.equal(selectedId(s), "r1");
  s = keys(s, "j");
  // a newer run appears at the top: the selection does not jump
  run(cwd, "r4", { updatedAt: iso(0) });
  s = reduce(s, { type: "data", ...loadSnapshot([cwd], s.selKey), now: Date.now() });
  assert.equal(s.runs[0].p.id, "r4");
  assert.equal(selectedId(s), "r2");
  // enter toggles detail, ? toggles help, q quits, resize resizes
  assert.equal(keys(s, "enter").detail, true);
  assert.equal(keys(s, "enter", "enter").detail, false);
  assert.equal(keys(s, "?").help, true);
  assert.equal(keys(s, "?", "x").help, false);
  assert.equal(keys(s, "q").quit, true);
  assert.equal(keys(s, "ctrl-c").quit, true);
  const r = reduce(s, { type: "resize", cols: 70, rows: 22 });
  assert.deepEqual([r.cols, r.rows], [70, 22]);
  assert.equal(s.cols, 120, "reduce does not mutate its input");
});

function selectedId(s: State): string | undefined {
  const i = s.selKey ? s.runs.findIndex((r) => runKey(r) === s.selKey) : 0;
  return s.runs[Math.max(0, i)]?.p.id;
}

test("reduce: approve flow asks first, then writes the approval file as 'tui'", () => {
  const cwd = tmp();
  blockedRun(cwd, "r-b");
  let s = keys(stateFor(cwd), "a");
  assert.equal(s.mode, "confirm");
  assert.equal(s.confirm?.kind, "approve");
  assert.deepEqual(s.effects, [], "nothing is written before y");
  assert.equal(readApproval(cwd, "r-b", "ap1")?.status, "pending");
  s = keys(s, "y");
  assert.equal(s.mode, "normal");
  assert.equal(s.effects.length, 1);
  assert.equal(readApproval(cwd, "r-b", "ap1")?.status, "pending", "reduce itself does no IO");
  s = applyEffects(s, { spawn: () => assert.fail("no spawn") });
  const a = readApproval(cwd, "r-b", "ap1")!;
  assert.equal(a.status, "approved");
  assert.equal(a.decidedBy, "tui");
  assert.ok(fs.existsSync(approvalPath(cwd, "r-b", "ap1")));
  assert.equal(s.effects.length, 0);
  assert.match(s.msg ?? "", /approved r-b/);
});

test("reduce: deny, n cancels, and a decided approval cannot be decided again", () => {
  const cwd = tmp();
  blockedRun(cwd, "r-b");
  let s = keys(stateFor(cwd), "d", "n");
  assert.equal(s.mode, "normal");
  assert.equal(s.msg, "cancelled");
  assert.deepEqual(s.effects, []);
  assert.equal(readApproval(cwd, "r-b", "ap1")?.status, "pending");
  s = applyEffects(keys(s, "d", "y"), { spawn: () => {} });
  assert.equal(readApproval(cwd, "r-b", "ap1")?.status, "denied");
  assert.equal(readApproval(cwd, "r-b", "ap1")?.decidedBy, "tui");
  // second decision loses, like the web 409
  const stale = keys(stateFor(cwd), "a");
  assert.equal(stale.mode, "normal");
  const forced = applyEffects({ ...stale, effects: [{ kind: "decide", cwd, runId: "r-b", approvalId: "ap1", approved: true }] }, { spawn: () => {} });
  assert.match(forced.msg ?? "", /already decided/);
  assert.equal(readApproval(cwd, "r-b", "ap1")?.status, "denied");
});

test("reduce: a/d on a run that is not blocked only reports", () => {
  const cwd = tmp();
  run(cwd, "r-run");
  const s = keys(stateFor(cwd), "a");
  assert.equal(s.mode, "normal");
  assert.match(s.msg ?? "", /no pending approval/);
});

test("reduce: stop asks, then writes the STOP flag", () => {
  const cwd = tmp();
  run(cwd, "r-run");
  let s = keys(stateFor(cwd), "s");
  assert.equal(s.mode, "confirm");
  assert.equal(s.confirm?.kind, "stop");
  assert.ok(!fs.existsSync(path.join(runDir(cwd, "r-run"), "STOP")));
  s = applyEffects(keys(s, "y"), { spawn: () => {} });
  assert.ok(fs.existsSync(path.join(runDir(cwd, "r-run"), "STOP")));
  assert.match(s.msg ?? "", /STOP written/);
  // n cancels and writes nothing
  const cwd2 = tmp();
  run(cwd2, "r-run");
  applyEffects(keys(stateFor(cwd2), "s", "n"), { spawn: () => {} });
  assert.ok(!fs.existsSync(path.join(runDir(cwd2, "r-run"), "STOP")));
  // finished runs cannot be stopped
  const cwd3 = tmp();
  run(cwd3, "r-done", { status: "done" });
  assert.match(keys(stateFor(cwd3), "s").msg ?? "", /not active/);
});

test("reduce: g prompt editing yields a spawn request; esc cancels", () => {
  const cwd = tmp();
  run(cwd, "r-old");
  let s = stateFor(cwd);
  s = keys(s, "g");
  assert.equal(s.mode, "prompt");
  for (const ch of "fix 登录x") s = reduce(s, { type: "key", key: ch });
  s = keys(s, "backspace");
  assert.equal(s.prompt, "fix 登录");
  s = keys(s, "q");
  assert.equal(s.quit, false, "q types while prompting");
  assert.equal(s.prompt, "fix 登录q");
  s = keys(s, "backspace", "enter");
  assert.equal(s.mode, "normal");
  assert.deepEqual(s.effects, [{ kind: "spawn", intent: "fix 登录", cwd }]);
  const spawned: unknown[] = [];
  s = applyEffects(s, { spawn: (req) => void spawned.push(req) });
  assert.deepEqual(spawned, [{ intent: "fix 登录", cwd }]);
  // the new run appears: it becomes the selection
  assert.equal(selectedId(s), "r-old");
  run(cwd, "r-new", { intent: "fix 登录", updatedAt: iso(0) });
  s = reduce(s, { type: "data", ...loadSnapshot([cwd]), now: Date.now() });
  assert.equal(selectedId(s), "r-new");
  assert.equal(s.launch, undefined);
  // esc cancels, an empty prompt launches nothing
  const c = keys(stateFor(cwd), "g", "x", "esc");
  assert.deepEqual([c.mode, c.prompt, c.effects.length], ["normal", "", 0]);
  assert.equal(keys(stateFor(cwd), "g", "enter").effects.length, 0);
  assert.equal(keys(stateFor(cwd), "g", " ", " ", "enter").effects.length, 0);
});

test("spawn failures are reported, not thrown", () => {
  const cwd = tmp();
  const s = applyEffects({ ...initialState([cwd]), effects: [{ kind: "spawn", intent: "x", cwd }] }, {
    spawn: () => {
      throw new Error("boom");
    },
  });
  assert.match(s.msg ?? "", /failed: boom/);
});

test("buildLaunch: node + mola bin + go <intent>, log under .mstack/runs", () => {
  const spec = buildLaunch({ intent: 'say "hi"', cwd: "/w" }, "/x/bin.js", "/usr/bin/node", 1700000000000);
  assert.equal(spec.command, "/usr/bin/node");
  assert.deepEqual(spec.args, ["/x/bin.js", "go", 'say "hi"']);
  assert.equal(spec.logFile, path.join("/w", ".mstack", "runs", "go-launch-1700000000000.log"));
});

test("parseKeys: arrows, enter, esc, backspace, ctrl-c, text", () => {
  assert.deepEqual(parseKeys("\x1b[A\x1b[B\x1bOA\x1bOB"), ["up", "down", "up", "down"]);
  assert.deepEqual(parseKeys("\r\n\x7f\x03\x1b"), ["enter", "enter", "backspace", "ctrl-c", "esc"]);
  assert.deepEqual(parseKeys("a登b"), ["a", "登", "b"]);
  assert.deepEqual(parseKeys("\x1b[5~\x1b[6~"), ["pgup", "pgdn"]);
  assert.deepEqual(parseKeys("\x1b[1;5C"), [], "unknown CSI is swallowed whole");
});

test("cwdFlags collects repeated --cwd from raw argv", () => {
  assert.deepEqual(cwdFlags("b", ["tui", "--cwd", "a", "--cwd=c", "--cwd", "b", "--once"]), ["a", "c", "b"]);
  assert.deepEqual(cwdFlags(true, ["--cwd"]), []);
});

test("loadRuns merges dirs newest first; the log falls back to the newest artifact", () => {
  const a = tmp();
  const b = tmp();
  run(a, "ra", { updatedAt: iso(5000) });
  run(b, "rb", { updatedAt: iso(0) });
  assert.deepEqual(loadRuns([a, b]).map((r) => r.p.id), ["rb", "ra"]);
  fs.writeFileSync(path.join(runDir(a, "ra"), "plan.md"), "one\ntwo\n");
  const snap = loadSnapshot([a, b], `${a}|ra`);
  assert.equal(snap.logSource, "plan.md");
  assert.deepEqual(snap.log, ["one", "two"]);
  assert.ok(snap.artifacts.includes("plan.md"));
});

// --------------------------------------------------------------------- once

test("--once frame on a temp cwd with two hand-written runs", () => {
  const cwd = tmp();
  const hand = (id: string, extra: Record<string, unknown>): void => {
    fs.mkdirSync(path.join(cwd, ".mstack", "runs", id), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".mstack", "runs", id, "progress.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        intent: "hand written",
        cwd,
        status: "running",
        startedAt: iso(60_000),
        updatedAt: iso(0),
        stage: "plan",
        stages: [{ name: "plan", status: "running", model: "opus" }],
        workers: [],
        costUsd: 0.5,
        ...extra,
      }),
    );
  };
  hand("hand-1", {});
  hand("hand-2", { intent: "second run", status: "done", stage: "ship", updatedAt: iso(9000) });
  const frame = onceFrame([cwd], 100, 24);
  assert.ok(!frame.includes("\x1b"));
  assert.ok(frame.endsWith("\n"));
  for (const want of ["hand-1", "hand-2", "hand written", "second run", "2 runs", "Pipeline"]) assert.ok(frame.includes(want), want);
  assert.ok(frame.split("\n").every((l) => l === l.trimEnd()), "no trailing spaces");
});

test("mola tui --once through the registered command handler (non-TTY path)", async () => {
  const cwd = tmp();
  run(cwd, "r-cli");
  let cmd: { handler(a: unknown, io: unknown): Promise<number> } | undefined;
  plugin.activate({
    commands: { register: (c: never) => void (cmd = c) },
    config: { get: (_k: string, f: unknown) => f },
  } as never);
  const out: string[] = [];
  const io = { cwd, json: false, out: (l: string) => out.push(l), data: () => {} } as unknown as Io;
  const code = await cmd!.handler(parseArgv(["--once"]), io);
  assert.equal(code, 0);
  assert.ok(out.join("\n").includes("r-cli"));
  await assert.rejects(cmd!.handler(parseArgv(["stray"]), io), /usage: mola tui/);
});

// -------------------------------------------------------------------- shell

function fakeIO(size = { cols: 100, rows: 30 }): { io: TuiIO; writes: string[]; keys: EventEmitter; proc: EventEmitter; resize: EventEmitter; raw: boolean[] } {
  const writes: string[] = [];
  const kb = new EventEmitter();
  const proc = new EventEmitter();
  const resize = new EventEmitter();
  const raw: boolean[] = [];
  const io: TuiIO = {
    write: (s) => void writes.push(s),
    size: () => size,
    onResize(fn) {
      resize.on("r", fn);
      return () => void resize.off("r", fn);
    },
    input: {
      setRaw: (on) => void raw.push(on),
      onData(fn) {
        kb.on("d", fn);
        return () => void kb.off("d", fn);
      },
      close: () => {},
    },
    proc: { on: (e, f) => void proc.on(e, f as never), off: (e, f) => void proc.off(e, f as never) },
  };
  return { io, writes, keys: kb, proc, resize, raw };
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const FAST = { pollMs: 20, tickMs: 20, minFrameMs: 0 };

test("runTui: enters the alternate screen, draws whole frames in one write, q restores", async () => {
  const cwd = tmp();
  run(cwd, "r-live");
  const f = fakeIO();
  const done = runTui({ cwds: [cwd], io: f.io, color: false, ...FAST });
  await until(() => f.writes.some((w) => w.includes("r-live")));
  assert.equal(f.writes[0], ENTER_SEQ);
  assert.ok(ENTER_SEQ.includes("\x1b[?1049h") && ENTER_SEQ.includes("\x1b[?25l"));
  const frame = f.writes.find((w) => w.includes("r-live"))!;
  assert.equal(frame.split("\x1b[H").length, 2, "home once per frame");
  assert.equal(frame.split("\r\n").length, 30, "all 30 rows in this single write");
  assert.deepEqual(f.raw, [true]);
  f.keys.emit("d", "q");
  const res = await done;
  assert.equal(res.reason, "quit");
  assert.equal(f.writes.filter((w) => w === RESTORE_SEQ).length, 1);
  assert.equal(f.writes[f.writes.length - 1], RESTORE_SEQ);
  assert.deepEqual(f.raw, [true, false]);
  assert.equal(f.proc.listenerCount("SIGTERM"), 0, "process hooks are removed");
});

test("runTui: unchanged data does not redraw", async () => {
  const cwd = tmp();
  run(cwd, "r-calm", { status: "done" });
  const f = fakeIO();
  const done = runTui({ cwds: [cwd], io: f.io, color: false, ...FAST });
  await until(() => f.writes.some((w) => w.includes("r-calm")));
  await new Promise((r) => setTimeout(r, 200));
  const frames = f.writes.filter((w) => w.includes("\x1b[H")).length;
  assert.equal(frames, 1, `got ${frames} frames for 10 polls of identical data`);
  f.keys.emit("d", "q");
  await done;
});

test("runTui: keys drive approve end to end and a resize redraws", async () => {
  const cwd = tmp();
  blockedRun(cwd, "r-b");
  const f = fakeIO();
  const done = runTui({ cwds: [cwd], io: f.io, color: false, ...FAST });
  await until(() => f.writes.some((w) => w.includes("git push origin")));
  f.keys.emit("d", "a");
  await until(() => f.writes.some((w) => w.includes("[y/n]")));
  f.keys.emit("d", "y");
  await until(() => readApproval(cwd, "r-b", "ap1")?.status === "approved");
  assert.equal(readApproval(cwd, "r-b", "ap1")?.decidedBy, "tui");
  const before = f.writes.length;
  f.resize.emit("r");
  await until(() => f.writes.length > before);
  assert.ok(f.writes.slice(before).some((w) => w === "\x1b[2J"));
  f.keys.emit("d", "\x03");
  assert.equal((await done).reason, "quit");
});

test("runTui: error path restores the terminal exactly once and reports", async () => {
  const f = fakeIO();
  const errs: string[] = [];
  const res = await runTui({
    cwds: [tmp()],
    io: f.io,
    color: false,
    err: (s) => void errs.push(s),
    load: () => {
      throw new Error("disk exploded");
    },
    ...FAST,
  });
  assert.equal(res.reason, "error");
  assert.match(String((res.error as Error).message), /disk exploded/);
  assert.equal(f.writes[0], ENTER_SEQ);
  assert.equal(f.writes.filter((w) => w === RESTORE_SEQ).length, 1);
  assert.equal(f.writes[f.writes.length - 1], RESTORE_SEQ);
  assert.match(errs.join(""), /disk exploded/);
  assert.deepEqual(f.raw, [true, false]);
});

test("runTui: error raised later (during a poll or a key) also restores", async () => {
  const cwd = tmp();
  run(cwd, "r1");
  let calls = 0;
  const f = fakeIO();
  const res = await runTui({
    cwds: [cwd],
    io: f.io,
    color: false,
    err: () => {},
    load: (c, k) => {
      if (++calls > 3) throw new Error("late failure");
      return loadSnapshot(c, k);
    },
    ...FAST,
  });
  assert.equal(res.reason, "error");
  assert.equal(f.writes.filter((w) => w === RESTORE_SEQ).length, 1);
});

test("runTui: SIGTERM, uncaughtException and process exit all restore", async () => {
  for (const how of ["SIGTERM", "SIGINT", "uncaughtException"] as const) {
    const f = fakeIO();
    const errs: string[] = [];
    const done = runTui({ cwds: [tmp()], io: f.io, color: false, err: (s) => void errs.push(s), ...FAST });
    await until(() => f.writes.length > 0);
    const saved = process.exitCode;
    if (how === "uncaughtException") f.proc.emit(how, new Error("kaboom"));
    else f.proc.emit(how);
    const res = await done;
    process.exitCode = saved;
    assert.equal(res.reason, how === "uncaughtException" ? "error" : "signal", how);
    assert.equal(f.writes.filter((w) => w === RESTORE_SEQ).length, 1, how);
    if (how === "uncaughtException") assert.match(errs.join(""), /kaboom/);
  }
  // a hard process.exit while running: the 'exit' hook restores synchronously
  const f = fakeIO();
  const done = runTui({ cwds: [tmp()], io: f.io, color: false, ...FAST });
  await until(() => f.writes.length > 0);
  f.proc.emit("exit");
  assert.equal(f.writes[f.writes.length - 1], RESTORE_SEQ);
  f.proc.emit("SIGTERM");
  await done;
  assert.equal(f.writes.filter((w) => w === RESTORE_SEQ).length, 1, "restore is idempotent");
});

test("runTui: g launches through the injected spawn and selects the new run", async () => {
  const cwd = tmp();
  run(cwd, "r-old");
  const f = fakeIO();
  const reqs: unknown[] = [];
  const done = runTui({
    cwds: [cwd],
    io: f.io,
    color: false,
    spawn: (req) => {
      reqs.push(req);
      run(cwd, "r-spawned", { intent: req.intent, updatedAt: iso(0) });
    },
    ...FAST,
  });
  await until(() => f.writes.some((w) => w.includes("r-old")));
  f.keys.emit("d", "g");
  f.keys.emit("d", "ship it");
  f.keys.emit("d", "\r");
  await until(() => reqs.length === 1);
  assert.deepEqual(reqs, [{ intent: "ship it", cwd }]);
  await until(() => f.writes.some((w) => w.includes("Pipeline · r-spawned")));
  f.keys.emit("d", "q");
  await done;
});

// keep the type import used even if the suite is trimmed
export type { Event };
