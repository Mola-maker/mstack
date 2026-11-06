/**
 * The mola UI kit (B2e) — the small human-facing layer shared by core and the
 * command plugins. Rules it exists to enforce (core §8.2 / B1 lesson):
 *
 *   - `--json` stdout carries exactly one envelope, stderr one error line.
 *     Everything here is for human mode only; callers guard with `!io.json`.
 *   - Color is a decoration, never information: with NO_COLOR, MOLA_NO_COLOR,
 *     `--no-color` or a non-TTY stream every paint is the identity function,
 *     so tests and pipes see plain strings.
 *   - The spinner writes to stderr only and is disabled when the stream is not
 *     a TTY or when the command runs in --json / --quiet mode.
 *   - Tables align by display width, so CJK text (2 cells) keeps its columns.
 */

// ------------------------------------------------------------------- color

/** Anything paintable: identity when color is off. */
export type Paint = (s: string) => string;

export interface Palette {
  /** false ⇒ every paint is the identity function (no ANSI escapes) */
  readonly color: boolean;
  readonly bold: Paint;
  readonly dim: Paint;
  readonly red: Paint;
  readonly green: Paint;
  readonly yellow: Paint;
  readonly cyan: Paint;
}

const CODES = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 } as const;

function paint(code: number, color: boolean): Paint {
  return color ? (s: string) => `\x1b[${code}m${s}\x1b[0m` : (s: string) => s;
}

/** A palette; `palette(false)` is the plain-text one used by tests and pipes. */
export function palette(color: boolean): Palette {
  return {
    color,
    bold: paint(CODES.bold, color),
    dim: paint(CODES.dim, color),
    red: paint(CODES.red, color),
    green: paint(CODES.green, color),
    yellow: paint(CODES.yellow, color),
    cyan: paint(CODES.cyan, color),
  };
}

/**
 * True when the environment asked for no color: the no-color.org convention
 * (NO_COLOR), mola's own MOLA_NO_COLOR, or the `--no-color` flag. The bin
 * strips `--no-color` before handlers run, but it currently does not export
 * the decision, so the kit also scans process.argv — remove that scan when
 * boot() propagates the flag (see ux-notes.md).
 */
export function noColorRequested(argv: string[] = process.argv): boolean {
  if (process.env.NO_COLOR) return true;
  if (process.env.MOLA_NO_COLOR) return true;
  return argv.includes("--no-color");
}

/** Color is decoration: only on an interactive TTY that did not opt out. */
export function detectColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  return !noColorRequested() && stream.isTTY === true;
}

// ------------------------------------------------------------------ glyphs

export type Status = "ok" | "warn" | "fail";

export const GLYPHS: Record<Status, string> = { ok: "✔", warn: "▲", fail: "✘" };

/** The status glyph, colored when the palette allows it. */
export function statusGlyph(status: Status, p: Palette = palette(false)): string {
  const paintFor: Status = status;
  return p[paintFor === "ok" ? "green" : paintFor === "warn" ? "yellow" : "red"](GLYPHS[paintFor]);
}

// ------------------------------------------------------------------ tables

const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Zero-width code points (combining marks, variation selectors, ZWSP…). */
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  );
}

/** East-Asian wide code points (CJK, Hangul, Kana, fullwidth forms, emoji). */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  );
}

/** Terminal cells a string occupies: ANSI-free, CJK counts as 2. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1;
  }
  return w;
}

export interface TableOptions {
  /** optional header row (rendered by the caller — table() stays palette-free) */
  header?: string[];
  rows: string[][];
  /** column separator, default two spaces */
  gap?: string;
  /** prefix on every line, default "" (callers indent to taste) */
  indent?: string;
}

/**
 * Aligned left-only table lines. The last column is never padded, so lines
 * carry no trailing whitespace. Cells may contain ANSI — width uses
 * displayWidth().
 */
export function table(opts: TableOptions): string[] {
  const { header, rows, gap = "  ", indent = "" } = opts;
  const cols = Math.max(header?.length ?? 0, ...rows.map((r) => r.length));
  const widths = new Array<number>(cols).fill(0);
  const measure = (row: string[]) => {
    for (let i = 0; i < row.length && i < cols - 1; i++) {
      widths[i] = Math.max(widths[i], displayWidth(row[i]));
    }
  };
  if (header) measure(header);
  for (const r of rows) measure(r);

  const render = (row: string[]): string => {
    const cells: string[] = [];
    for (let i = 0; i < row.length; i++) {
      const cell = row[i] ?? "";
      cells.push(i < cols - 1 ? cell + " ".repeat(Math.max(0, widths[i] - displayWidth(cell))) : cell);
    }
    return indent + cells.join(gap);
  };
  const lines: string[] = [];
  if (header) lines.push(render(header));
  for (const r of rows) lines.push(render(r));
  return lines;
}

// ----------------------------------------------------------------- spinner

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 120;

/** Anything the spinner can write to (process.stderr in practice). */
export interface SpinnerStream {
  write(s: string): unknown;
  isTTY?: boolean;
}

/** The spinner is interactive decoration: a TTY on stderr that opted into color. */
export function spinnerEnabled(stream: SpinnerStream = process.stderr): boolean {
  return stream.isTTY === true && !noColorRequested();
}

export interface SpinnerOptions {
  text: string;
  stream?: SpinnerStream;
  /** default spinnerEnabled(stream) — pass false for --json / --quiet */
  enabled?: boolean;
  palette?: Palette;
}

/**
 * A one-line stderr spinner for long operations. When disabled it does
 * nothing at all (no writes, no timer), so --json stdout/stderr stay clean
 * and non-interactive runs stay quiet. Always stop() it — a stopped spinner
 * clears its own line and tears the timer down.
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  constructor(private readonly opts: SpinnerOptions) {}

  private get stream(): SpinnerStream {
    return this.opts.stream ?? process.stderr;
  }

  private get pal(): Palette {
    return this.opts.palette ?? palette(detectColor(this.stream));
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): this {
    if (!this.opts.enabled || this.timer) return this;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, INTERVAL_MS);
    // never keep the process alive for a spinner
    (this.timer as unknown as { unref?: () => void }).unref?.();
    return this;
  }

  /** Swap the text mid-flight (e.g. after a gate approved the route). */
  update(text: string): this {
    (this.opts as { text: string }).text = text;
    return this;
  }

  private render(): void {
    const p = this.pal;
    const line = `${p.cyan(FRAMES[this.frame])} ${p.dim(this.opts.text)}`;
    // \x1b[K erases to end of line — the text may have shrunk
    this.stream.write(`\r${line}\x1b[K`);
  }

  /** Erase the spinner line and (optionally) print a final line instead. */
  stop(final?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.opts.enabled) return;
    this.stream.write("\r\x1b[2K");
    if (final) this.stream.write(final + "\n");
  }

  succeed(message?: string): void {
    this.stop(`${statusGlyph("ok", this.pal)} ${message ?? this.opts.text}`);
  }

  fail(message?: string): void {
    this.stop(`${statusGlyph("fail", this.pal)} ${message ?? this.opts.text}`);
  }
}

/**
 * The one policy for command plugins: spinners only in human mode, only on a
 * TTY, never in --json or --quiet. `const spin = ioSpinner(io, "text")`.
 */
export function ioSpinner(
  io: { json: boolean; quiet: boolean },
  text: string,
  stream: SpinnerStream = process.stderr,
): Spinner {
  return new Spinner({
    text,
    stream,
    enabled: !io.json && !io.quiet && spinnerEnabled(stream),
  });
}

// ------------------------------------------------------------------ banner

/**
 * The short `mola` (no arguments) banner — two lines, honest, no box drawing.
 */
/** `-v` / `--verbose` (the bin strips it before handlers see their own argv). */
export function verboseRequested(argv: string[] = process.argv): boolean {
  return argv.some((a) => a === "-v" || a === "--verbose" || /^-vv+$/.test(a));
}

/** Compact duration for the one-line run summary. Missing values stay "-". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** One cell: never JSON. Nested values become `k=v` pairs or comma lists. */
function inline(v: unknown): string {
  if (v == null) return "-";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "-" : v.map((x) => inline(x)).join(", ");
  if (typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>).map(([k, val]) => `${k}=${inline(val)}`);
    return parts.length === 0 ? "-" : parts.join(" ");
  }
  return String(v);
}

/**
 * Human rendering of a handler's `io.data()` when the handler wrote nothing.
 * A table or a key/value list — never raw JSON (B2e).
 */
export function formatValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    if (value.every((v) => isPlain(v))) {
      const keys: string[] = [];
      for (const row of value as Array<Record<string, unknown>>) {
        for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);
      }
      return table({
        header: keys,
        rows: (value as Array<Record<string, unknown>>).map((row) => keys.map((k) => inline(row[k]))),
      }).join("\n");
    }
    return value.map((v) => inline(v)).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "(none)";
    return table({ rows: entries.map(([k, v]) => [k, inline(v)]) }).join("\n");
  }
  return String(value);
}

export function banner(p: Palette = palette(detectColor(process.stdout))): string {
  return [
    `${p.bold("mola")} ${p.dim("—")} plugin-based agent orchestration CLI`,
    p.dim('run "mola help" for the command list'),
  ].join("\n");
}
