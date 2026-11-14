import test from "node:test";
import assert from "node:assert/strict";
import { contrast, hexToRgb, SEMANTIC, THEME, themeCss, themePalette } from "@mola/plugin-sdk";

test("tokens are the UI kit's ramp, as #rrggbb", () => {
  assert.equal(THEME.blue[500], "#5d93dc");
  assert.equal(THEME.pink[300], "#f2a5c4");
  for (const ramp of [THEME.blue, THEME.pink, THEME.ink, THEME.night]) for (const c of Object.values(ramp) as string[]) assert.match(c, /^#[0-9a-f]{6}$/);
  assert.deepEqual(hexToRgb("#5d93dc"), [93, 147, 220]);
  assert.deepEqual(hexToRgb("blue"), [0, 0, 0]);
});

test("text is readable on both grounds; state colours are legible beside their glyph", () => {
  // body text: WCAG AA (4.5) at least, AAA (7) for the main ink
  assert.ok(contrast(THEME.ink[900], THEME.blue[50]) >= 7, "ink on the day ground");
  assert.ok(contrast(THEME.ink[600], "#ffffff") >= 4.5, "secondary ink on a card");
  assert.ok(contrast("#e8f0ff", THEME.night[900]) >= 7, "ink on the night ground");
  assert.ok(contrast(SEMANTIC.accent, "#ffffff") >= 4.5, "accent as text on a card");
  // state colours always sit next to a glyph or a word: 3:1 (large text / graphics) on the night ground and the terminal
  for (const tone of [SEMANTIC.ok, SEMANTIC.warn, SEMANTIC.fail]) assert.ok(contrast(tone, THEME.night[900]) >= 3, tone);
  assert.ok(contrast(SEMANTIC.fail, "#ffffff") >= 3, "fail on a card");
});

test("the terminal palette paints in 24-bit colour, and is the identity when colour is off", () => {
  const on = themePalette(true);
  assert.equal(on.ok("x"), "\x1b[38;2;93;147;220mx\x1b[39m");
  const off = themePalette(false);
  for (const tone of ["ok", "accent", "warn", "fail", "muted"] as const) assert.equal(off[tone]("x"), "x");
});

test("the CSS carries every token for day and night, and turns motion off on request", () => {
  const css = themeCss();
  for (const v of ["--m-blue-500: #5d93dc", "--m-pink-300: #f2a5c4", "--m-ground: #f7fbff", "--m-lift-2:", "--m-t-hover: 420ms", "--m-radius-md: 16px"]) assert.ok(css.includes(v), v);
  assert.match(css, /:root\[data-theme="night"\] \{[^}]*--m-ground: #0f1726/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /prefers-reduced-motion: reduce[^}]*--m-t-hover: 0ms/);
  // every var() the night block overrides exists in the day block
  const day = css.slice(0, css.indexOf(':root[data-theme="night"]'));
  for (const m of css.matchAll(/--m-[\w-]+(?=:)/g)) assert.ok(day.includes(m[0] + ":"), m[0]);
});
