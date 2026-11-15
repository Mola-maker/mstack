/**
 * The mola theme: one set of tokens for every surface a person looks at (status line, TUI, web console).
 *
 * Source: the MOLAMAKER OC UI component kit (`MolaButton.module.css`: --b50 … --b700, --pink, --danger) and its
 * motion spec (hover 420 ms, press 240 ms, explicit keyframes, reduced motion respected). The look is 2.5D:
 * flat pale-blue surfaces lifted by soft layered shadows, pink as the second voice. Depth comes from the
 * three elevation levels below, never from heavy 3D.
 *
 * Rules:
 *  - Colour is decoration. Every state also has a glyph or a word, so a plain terminal loses nothing.
 *  - Surfaces take colours through the semantic names (`ok`, `warn`, `fail`, `accent`, `muted`), not the raw ramp.
 *  - Web and terminal read the same object: `themeCss()` for the browser, `themePalette()` for ANSI.
 */

import type { Palette } from "./ui.js";

export const THEME = {
  blue: { 50: "#f7fbff", 100: "#eaf3ff", 300: "#b7d4ff", 500: "#5d93dc", 600: "#3f72bd", 700: "#2b5597" },
  pink: { 100: "#fde8f1", 300: "#f2a5c4", 500: "#dd668d" },
  /** 500 is the quiet text on the day ground (AA on every day surface); 400 is the quiet tone on dark terminals */
  ink: { 900: "#1f2c44", 600: "#4a5b78", 500: "#586884", 400: "#8496b3" },
  /** dark ground for terminals and the console's night mode: the same blues over a deep navy */
  night: { 900: "#0f1726", 800: "#172238", 700: "#22314e" },
  radius: { sm: "10px", md: "16px", lg: "24px", pill: "999px" },
  /** 2.5D: three steps of lift. Each is a top highlight plus a soft blue shadow. */
  elevation: {
    1: "inset 0 1px 0 rgba(255,255,255,.85), 0 4px 12px rgba(52,101,170,.08)",
    2: "inset 0 1px 0 rgba(255,255,255,.85), 0 10px 29px rgba(52,101,170,.14)",
    3: "inset 0 1px 0 rgba(255,255,255,.85), 0 15px 35px rgba(52,101,170,.19)",
  },
  motion: { press: "240ms", hover: "420ms", settle: "680ms", ease: "cubic-bezier(0.22, 1, 0.36, 1)" },
  font: {
    sans: "'DM Sans', 'Noto Sans JP', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    mono: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  },
} as const;

/** What a colour means. Surfaces use these names. */
export const SEMANTIC = {
  ok: THEME.blue[500],
  accent: THEME.blue[600],
  warn: THEME.pink[300],
  fail: THEME.pink[500],
  muted: THEME.ink[400],
} as const;

export type Tone = keyof typeof SEMANTIC;

/** "#rrggbb" → [r, g, b]. Anything else is black, so a bad token is visible, not a crash. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export type ThemePaint = (text: string) => string;

/**
 * ANSI painters in the theme's colours (24-bit). `color: false` makes every painter the identity function:
 * pipes, tests and NO_COLOR get plain text.
 */
export function themePalette(color: boolean): Record<Tone, ThemePaint> & { color: boolean } {
  const make = (hex: string): ThemePaint => {
    if (!color) return (s) => s;
    const [r, g, b] = hexToRgb(hex);
    return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
  };
  return { color, ok: make(SEMANTIC.ok), accent: make(SEMANTIC.accent), warn: make(SEMANTIC.warn), fail: make(SEMANTIC.fail), muted: make(SEMANTIC.muted) };
}

/**
 * The tokens as CSS custom properties, light ground by default and the night ground under
 * `[data-theme="night"]` or a dark system preference. One string, no build step: the web console inlines it.
 */
export function themeCss(): string {
  const t = THEME;
  const vars = (o: Record<string, string>): string => Object.entries(o).map(([k, v]) => `  --m-${k}: ${v};`).join("\n");
  const base = {
    "blue-50": t.blue[50], "blue-100": t.blue[100], "blue-300": t.blue[300], "blue-500": t.blue[500], "blue-600": t.blue[600], "blue-700": t.blue[700],
    "pink-100": t.pink[100], "pink-300": t.pink[300], "pink-500": t.pink[500],
    ok: SEMANTIC.ok, accent: SEMANTIC.accent, warn: SEMANTIC.warn, fail: SEMANTIC.fail,
    "radius-sm": t.radius.sm, "radius-md": t.radius.md, "radius-lg": t.radius.lg, "radius-pill": t.radius.pill,
    "lift-1": t.elevation[1], "lift-2": t.elevation[2], "lift-3": t.elevation[3],
    "t-press": t.motion.press, "t-hover": t.motion.hover, "t-settle": t.motion.settle, ease: t.motion.ease,
    "font-sans": t.font.sans, "font-mono": t.font.mono,
  };
  // `ok-text` is the ok tone as small text: the ramp's 500 is a fill colour and too light for 13 px type by day
  const light = { ground: t.blue[50], surface: "#ffffff", "surface-2": t.blue[100], line: t.blue[300], ink: t.ink[900], "ink-2": t.ink[600], muted: t.ink[500], "ok-text": t.blue[600] };
  const night = {
    ground: t.night[900], surface: t.night[800], "surface-2": t.night[700], line: "#33466b", ink: "#e8f0ff", "ink-2": "#b9c8e6", muted: "#8ea1c4", "ok-text": t.blue[300],
    "lift-1": "inset 0 1px 0 rgba(255,255,255,.06), 0 4px 12px rgba(0,0,0,.30)",
    "lift-2": "inset 0 1px 0 rgba(255,255,255,.06), 0 10px 29px rgba(0,0,0,.38)",
    "lift-3": "inset 0 1px 0 rgba(255,255,255,.06), 0 15px 35px rgba(0,0,0,.46)",
  };
  return [
    `:root {\n${vars({ ...base, ...light })}\n}`,
    `:root[data-theme="night"] {\n${vars(night)}\n}`,
    `@media (prefers-color-scheme:dark) {\n  :root:not([data-theme="day"]) {\n${vars(night).replace(/^/gm, "  ")}\n  }\n}`,
    `@media (prefers-reduced-motion: reduce) {\n  :root { --m-t-press: 0ms; --m-t-hover: 0ms; --m-t-settle: 0ms; }\n}`,
  ].join("\n\n") + "\n";
}

function luminance(hex: string): number {
  const lin = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio of two "#rrggbb" colours (1 to 21). The tests hold the theme's text pairs to it. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The classic `Palette` (bold, dim, red, green, yellow, cyan) in the theme's colours, for code written
 * against it: cyan is work in progress (blue), yellow is "needs a person" (pink), green is done (pale blue),
 * red is failure (deep pink), dim is the quiet tone. `color: false` is plain text, as with `palette(false)`.
 */
export function themedPalette(color: boolean): Palette {
  const t = themePalette(color);
  const done = color ? (text: string) => { const [r, g, b] = hexToRgb(THEME.blue[300]); return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`; } : (text: string) => text;
  return {
    color,
    bold: color ? (text: string) => `\x1b[1m${text}\x1b[22m` : (text: string) => text,
    dim: t.muted,
    red: t.fail,
    green: done,
    yellow: t.warn,
    cyan: t.ok,
  };
}
