import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatProgressLine, writeProgress } from "@mola/plugin-sdk";
import plugin from "../src/index.js";
import { initProgress } from "../src/engine.js";
import { applyInstall, buildCommand, fastBase, cwdFromStdin, planInstall, readStdin, renderStatusline } from "../src/statusline.js";
import { fakeAgent, makeCtx, makeIo, tempCwd } from "./helpers.js";
import { Readable } from "node:stream";

function activeRun(cwd: string) {
  const p = initProgress("go-20261108-1200-abcd", "fix the bug", cwd, ["plan", "implement"]);
  p.stages[1].status = "running";
  p.stage = "plan";
  writeProgress(p);
  return p;
}

const node = (js: string) => `"${process.execPath}" -e "${js}"`;

test("no active run: empty output, well under 300 ms", () => {
  const cwd = tempCwd();
  const t0 = performance.now();
  const out = renderStatusline({ stdin: JSON.stringify({ workspace: { current_dir: cwd } }), cwd });
  assert.equal(out, "");
  assert.ok(performance.now() - t0 < 300);
});

test("a finished run is not active", () => {
  const cwd = tempCwd();
  const p = activeRun(cwd);
  p.status = "done";
  writeProgress(p);
  assert.equal(renderStatusline({ stdin: "", cwd }), "");
});

test("active run: prints the progress line, reading cwd from stdin (workspace.current_dir, then cwd)", () => {
  const cwd = tempCwd();
  const p = activeRun(cwd);
  const now = Date.now();
  const expected = formatProgressLine(p, now);
  assert.match(expected, /^go ▸ plan \(1\/2\)/);
  const other = tempCwd();
  assert.equal(renderStatusline({ stdin: JSON.stringify({ workspace: { current_dir: cwd } }), cwd: other, now }), expected);
  assert.equal(renderStatusline({ stdin: JSON.stringify({ cwd }), cwd: other, now }), expected);
  assert.equal(renderStatusline({ stdin: "", cwd, now }), expected); // empty stdin: fall back to the process cwd
});

test("bad stdin never throws and falls back to cwd", () => {
  const cwd = tempCwd();
  activeRun(cwd);
  for (const bad of ["{not json", "null", "[]", '{"workspace":5}', "\u0000\u0001"]) {
    assert.doesNotThrow(() => renderStatusline({ stdin: bad, cwd }));
    assert.match(renderStatusline({ stdin: bad, cwd }), /^go ▸/);
  }
  assert.equal(cwdFromStdin("{bad", "/fb"), "/fb");
});

test("--wrap: the wrapped output comes first, ours below; the wrapped command gets the same stdin", () => {
  const cwd = tempCwd();
  activeRun(cwd);
  const stdin = JSON.stringify({ workspace: { current_dir: cwd }, marker: "same-stdin" });
  const out = renderStatusline({ stdin, cwd, wrap: node("process.stdin.pipe(process.stdout)") });
  const lines = out.split("\n");
  assert.equal(lines[0], stdin);
  assert.match(lines[1], /^go ▸/);
  const hud = renderStatusline({ stdin, cwd, wrap: node("process.stdout.write('HUD')") });
  assert.deepEqual(hud.split("\n").slice(0, 1), ["HUD"]);
});

test("--wrap with no active run prints only the wrapped output; a broken wrap prints only ours", () => {
  const empty = tempCwd();
  assert.equal(renderStatusline({ stdin: "", cwd: empty, wrap: node("process.stdout.write('HUD')") }), "HUD");
  const cwd = tempCwd();
  activeRun(cwd);
  assert.match(renderStatusline({ stdin: "", cwd, wrap: "definitely-not-a-command-xyz" }), /^go ▸/);
  assert.equal(renderStatusline({ stdin: "", cwd: empty, wrap: "definitely-not-a-command-xyz" }), "");
});

test("the command: garbage stdin → exit 0 and nothing of ours", async () => {
  const f = makeCtx([fakeAgent()]);
  plugin.activate(f.ctx);
  const cmd = f.commands.find((c) => c.path.join(" ") === "statusline")!;
  const cwd = tempCwd();
  const code = await cmd.handler({ positionals: [], flags: {} }, makeIo(cwd));
  assert.equal(code, 0);
});

test("readStdin: reads a pipe, returns '' for a TTY and for a silent stream", async () => {
  assert.equal(await readStdin(Readable.from(['{"a":', "1}"])), '{"a":1}');
  assert.equal(await readStdin(Object.assign(new Readable({ read() {} }), { isTTY: true })), "");
  assert.equal(await readStdin(new Readable({ read() {} }), 30), "");
});

test("install: wraps the existing command, shows before/after, writes only with --yes, backs up first", async () => {
  const dir = tempCwd();
  const file = path.join(dir, "settings.json");
  const old = { model: "opus", statusLine: { type: "command", command: "node C:/Users/22494/.claude/hud/omc-hud.mjs", padding: 0 }, hooks: { a: 1 } };
  fs.writeFileSync(file, JSON.stringify(old, null, 2));
  const before = fs.readFileSync(file, "utf8");

  const plan = planInstall(file);
  assert.equal(plan.after.command, 'mola statusline --wrap "node C:/Users/22494/.claude/hud/omc-hud.mjs"');
  assert.match(fastBase(), /^node ".*statusline-bin\.js"$/);
  assert.equal(plan.after.padding, 0);

  const f = makeCtx([fakeAgent()]);
  plugin.activate(f.ctx);
  const cmd = f.commands.find((c) => c.path.join(" ") === "statusline install")!;
  const dry = makeIo(dir);
  await cmd.handler({ positionals: [], flags: { settings: file } }, dry);
  assert.equal(fs.readFileSync(file, "utf8"), before); // untouched
  assert.ok(!fs.existsSync(file + ".bak-mola"));
  assert.match(dry.lines.join("\n"), /before: .*omc-hud\.mjs[\s\S]*after : .*statusline-bin.*--wrap[\s\S]*not written/);

  await cmd.handler({ positionals: [], flags: { settings: file, yes: true } }, makeIo(dir));
  assert.equal(fs.readFileSync(file + ".bak-mola", "utf8"), before);
  const now = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(now.model, "opus");
  assert.deepEqual(now.hooks, { a: 1 });
  assert.match(now.statusLine.command, /statusline-bin\.js" --wrap "node C:\/Users/);

  // idempotent: a second install changes nothing
  assert.equal(planInstall(file).already, true);
});

test("install: no existing statusLine, no settings file yet", () => {
  const dir = tempCwd();
  const file = path.join(dir, "settings.json");
  const plan = planInstall(file);
  assert.equal(plan.exists, false);
  assert.equal(plan.before, null);
  assert.equal(plan.after.command, "mola statusline");
  assert.deepEqual(applyInstall(plan), {});
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).statusLine.command, "mola statusline");
  assert.equal(buildCommand('say "hi"'), 'mola statusline --wrap "say \\"hi\\""');
});

test("install refuses to overwrite an unparseable settings.json", () => {
  const dir = tempCwd();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "{ nope");
  assert.throws(() => planInstall(file), /cannot parse/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ nope");
});
