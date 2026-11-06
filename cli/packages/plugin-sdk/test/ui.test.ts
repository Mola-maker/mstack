/**
 * UI kit tests (B2e). No external processes, no TTY assumptions: colors are
 * forced through palette(true/false) and streams are plain objects, so the
 * suite runs the same on Windows, Linux and CI.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  banner,
  displayWidth,
  detectColor,
  formatDuration,
  formatValue,
  GLYPHS,
  ioSpinner,
  noColorRequested,
  palette,
  Spinner,
  type SpinnerStream,
  spinnerEnabled,
  statusGlyph,
  stripAnsi,
  table,
} from "@mola/plugin-sdk";

test("palette(false) never emits ANSI escapes", () => {
  const p = palette(false);
  for (const paint of [p.bold, p.dim, p.red, p.green, p.yellow, p.cyan]) {
    assert.equal(paint("hello"), "hello");
  }
  assert.equal(statusGlyph("ok", p), GLYPHS.ok);
  assert.match(stripAnsi(p.green("x")), /^x$/);
});

test("palette(true) wraps with ANSI and statusGlyph colors by status", () => {
  const p = palette(true);
  assert.equal(p.red("bad"), "\x1b[31mbad\x1b[0m");
  assert.equal(statusGlyph("ok", p), `${p.green(GLYPHS.ok)}`);
  assert.equal(statusGlyph("warn", p), `${p.yellow(GLYPHS.warn)}`);
  assert.equal(statusGlyph("fail", p), `${p.red(GLYPHS.fail)}`);
});

test("NO_COLOR / MOLA_NO_COLOR / --no-color all disable color", () => {
  const saved = { ...process.env };
  const savedArgv = process.argv;
  try {
    delete process.env.NO_COLOR;
    delete process.env.MOLA_NO_COLOR;
    process.argv = ["mola", "doctor"];
    assert.equal(noColorRequested(), false);

    process.env.NO_COLOR = "1";
    assert.equal(noColorRequested(), true);
    delete process.env.NO_COLOR;

    process.env.MOLA_NO_COLOR = "1";
    assert.equal(noColorRequested(), true);
    delete process.env.MOLA_NO_COLOR;

    process.argv = ["mola", "--no-color", "doctor"];
    assert.equal(noColorRequested(), true);

    // a non-TTY stream never gets color even without the env vars
    process.argv = ["mola", "doctor"];
    assert.equal(detectColor({ isTTY: undefined }), false);
    assert.equal(detectColor({ isTTY: true }), true);
  } finally {
    process.env = saved;
    process.argv = savedArgv;
  }
});

test("displayWidth: CJK counts as 2, combining marks as 0, ANSI stripped", () => {
  assert.equal(displayWidth("mola"), 4);
  assert.equal(displayWidth("模型路由"), 8);
  assert.equal(displayWidth("路由 group/smart-split"), 4 + 1 + 17);
  assert.equal(displayWidth("café"), 4); // é as a single code point
  assert.equal(displayWidth("e\u0301"), 1); // e + combining acute
  assert.equal(displayWidth("\x1b[1mbold\x1b[0m"), 4);
});

test("table aligns columns with CJK characters and pads no trailing space", () => {
  const lines = table({
    header: ["command", "说明"],
    rows: [
      ["doctor", "健康检查"],
      ["dispatch", "run one task"],
    ],
  });
  assert.equal(lines.length, 3);
  const [h, r1, r2] = lines;
  // first column is as wide as "dispatch" (8), gap is 2; last column is not padded
  assert.equal(h, "command   说明");
  assert.equal(r1.indexOf("健康检查"), h.indexOf("说明"));
  assert.equal(r2.indexOf("run one task"), h.indexOf("说明"));
  assert.ok(!lines.some((l) => l !== l.trimEnd()), "no trailing whitespace");
});

test("table measures ANSI-colored cells by their visible width", () => {
  const p = palette(true);
  const lines = table({
    header: ["state", "id"],
    rows: [[p.green(GLYPHS.ok), "dsh"]],
  });
  // string indexes differ (the ANSI lives in the cell); the visible column does not
  const col = (line: string, needle: string) => displayWidth(line.slice(0, line.indexOf(needle)));
  assert.equal(col(lines[1], "dsh"), col(lines[0], "id"));
});

test("spinner writes frames to the stream and stop() cleans up", async () => {
  const written: string[] = [];
  const stream: SpinnerStream = { write: (s: string) => { written.push(s); }, isTTY: true };
  const spin = new Spinner({ text: "working", stream, enabled: true, palette: palette(false) });
  spin.start();
  assert.ok(spin.running);
  await new Promise((r) => setTimeout(r, 300));
  spin.succeed("done");
  assert.ok(!spin.running);
  assert.ok(written.length >= 2, `expected frames, got ${written.length}`);
  assert.ok(written.some((w) => w.includes("working")));
  const afterStop = written.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(written.length, afterStop, "no writes after stop()");
  assert.ok(written.at(-1)!.includes(GLYPHS.ok));
  assert.ok(written.at(-1)!.includes("done"));
});

test("spinner is disabled without a TTY and ioSpinner honors --json/--quiet", () => {
  const written: string[] = [];
  const stream: SpinnerStream = { write: (s: string) => { written.push(s); }, isTTY: undefined };
  assert.equal(spinnerEnabled(stream), false);
  const spin = new Spinner({ text: "x", stream, enabled: spinnerEnabled(stream) });
  spin.start();
  spin.succeed("nope");
  assert.equal(written.length, 0, "a disabled spinner writes nothing");
  assert.ok(!spin.running);

  const fakeStream: SpinnerStream = { write: (s: string) => { written.push(s); }, isTTY: true };
  const jsonIo = { json: true, quiet: false } as Parameters<typeof ioSpinner>[0];
  const spinJson = ioSpinner(jsonIo, "t", fakeStream);
  spinJson.start();
  assert.ok(!spinJson.running, "no spinner in --json mode");

  const quietIo = { json: false, quiet: true } as Parameters<typeof ioSpinner>[0];
  const quiet = ioSpinner(quietIo, "t", fakeStream);
  quiet.start();
  assert.ok(!quiet.running, "no spinner in --quiet mode");

  // NO_COLOR in the ambient environment (CI, this sandbox) must not leak in:
  // the assertion is "a human TTY that did not opt out gets a spinner".
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  delete process.env.NO_COLOR;
  delete process.env.MOLA_NO_COLOR;
  process.argv = ["mola", "doctor"];
  try {
    const humanIo = { json: false, quiet: false } as Parameters<typeof ioSpinner>[0];
    const human = ioSpinner(humanIo, "t", fakeStream);
    human.start();
    assert.ok(human.running, "spinner in human TTY mode");
    human.stop();
  } finally {
    process.env = savedEnv;
    process.argv = savedArgv;
  }
});

test("formatValue is a table or a list, never raw JSON", () => {
  const obj = formatValue({ agent: "dsh", route: "group/smart-split" });
  assert.match(obj, /agent\s+dsh/);
  assert.match(obj, /route\s+group\/smart-split/);
  assert.doesNotMatch(obj, /\{/);
  const rows = formatValue([
    { id: "dsh", ok: true },
    { id: "codex", ok: false },
  ]);
  assert.match(rows.split("\n")[0], /^id\s+ok$/);
  assert.match(rows, /codex\s+false/);
  assert.equal(formatValue([]), "(none)");
  assert.equal(formatValue(null), "");
  assert.equal(formatValue("plain"), "plain");
  // nested objects stay one cell, not a JSON blob
  assert.equal(formatValue({ load: { running: 1, max: 3 } }), "load  running=1 max=3");
});

test("formatDuration: ms, seconds, minutes", () => {
  assert.equal(formatDuration(undefined), "-");
  assert.equal(formatDuration(340), "340ms");
  assert.equal(formatDuration(1500), "1.5s");
  assert.equal(formatDuration(12_000), "12s");
  assert.equal(formatDuration(90_000), "1m30s");
});

test("banner is two short lines and plain without color", () => {
  const b = banner(palette(false));
  const lines = b.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^mola — plugin-based agent orchestration CLI$/);
  assert.match(lines[1], /mola help/);
  assert.equal(stripAnsi(banner(palette(true))), b);
});
