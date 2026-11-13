/**
 * cmd-tui (mstack 1.0, FRAMEWORK.md §13.6): `mola tui [--cwd <dir> ...] [--once]`.
 * A full-screen terminal UI over the shared progress contract. Zero
 * dependencies: ANSI escapes plus raw stdin. This file is the thin IO shell
 * (stdin, timers, writes, spawn); state lives in model.ts, drawing in render.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn as spawnChild } from "node:child_process";
import type { PluginContext } from "@mola/plugin-sdk";
import { definePlugin, detectColor, ExitCode, MolaError } from "@mola/plugin-sdk";
import {
  applyEffects,
  buildLaunch,
  cwdFlags,
  initialState,
  loadSnapshot,
  parseKeys,
  reduce,
  runKey,
  selectedRun,
  type Event,
  type LaunchRequest,
  type Snapshot,
  type State,
} from "./model.js";
import { render, renderPlain } from "./render.js";

export * from "./model.js";
export { render, renderPlain, trunc, fit, clean } from "./render.js";

const USAGE = "usage: mola tui [--cwd <dir> ...] [--once]";

// ---------------------------------------------------------------- terminal

export const ENTER_SEQ = "\x1b[?1049h\x1b[?25l\x1b[2J";
export const RESTORE_SEQ = "\x1b[0m\x1b[?25h\x1b[?1049l";

/** Alternate screen + hidden cursor; `restore` is idempotent and safe to call from anywhere. */
export class Terminal {
  private entered = false;
  constructor(private readonly write: (s: string) => void) {}
  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.write(ENTER_SEQ);
  }
  restore(): void {
    if (!this.entered) return;
    this.entered = false;
    try {
      this.write(RESTORE_SEQ);
    } catch {
      /* the terminal may already be gone */
    }
  }
}

export interface TuiIO {
  write(s: string): void;
  size(): { cols: number; rows: number };
  onResize(fn: () => void): () => void;
  /** raw keyboard input */
  input: {
    setRaw(on: boolean): void;
    onData(fn: (chunk: string) => void): () => void;
    close(): void;
  };
  /** process-level hooks (signals, exit, uncaughtException) */
  proc: {
    on(ev: string, fn: (...a: never[]) => void): void;
    off(ev: string, fn: (...a: never[]) => void): void;
  };
}

export interface TuiOptions {
  cwds: string[];
  io: TuiIO;
  /** start `mola go`; returns the log file. Default: detached child, see launchGo. */
  spawn?: (req: LaunchRequest) => string | void;
  load?: (cwds: string[], selKey?: string) => Snapshot;
  pollMs?: number;
  tickMs?: number;
  /** minimum ms between frames (default 100 = 10 fps) */
  minFrameMs?: number;
  color?: boolean;
  /** error text sink, called after the terminal is restored */
  err?: (s: string) => void;
  now?: () => number;
}

export interface TuiResult {
  reason: "quit" | "signal" | "error";
  error?: unknown;
}

/** Run the interactive loop. Resolves after the terminal has been restored. */
export function runTui(opts: TuiOptions): Promise<TuiResult> {
  const { io } = opts;
  const now = opts.now ?? Date.now;
  const load = opts.load ?? loadSnapshot;
  const launcher = opts.spawn ?? ((req: LaunchRequest) => launchGo(req, now()));
  const color = opts.color ?? true;
  const minFrame = opts.minFrameMs ?? 100;
  const term = new Terminal((s) => io.write(s));

  return new Promise<TuiResult>((resolve) => {
    let state: State = initialState(opts.cwds, io.size(), now());
    let finished = false;
    let lastFrame = "";
    let lastPaint = 0;
    let paintTimer: ReturnType<typeof setTimeout> | undefined;
    const disposers: Array<() => void> = [];

    const finish = (result: TuiResult): void => {
      if (finished) return;
      finished = true;
      if (paintTimer) clearTimeout(paintTimer);
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch {
          /* best effort */
        }
      }
      try {
        io.input.setRaw(false);
        io.input.close();
      } catch {
        /* ignore */
      }
      term.restore();
      if (result.error !== undefined) {
        const e = result.error;
        (opts.err ?? (() => {}))(`mola tui: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      }
      resolve(result);
    };
    const guard = (fn: () => void): void => {
      try {
        fn();
      } catch (e) {
        finish({ reason: "error", error: e });
      }
    };

    const paint = (force = false): void => {
      if (finished) return;
      paintTimer = undefined;
      const lines = render(state, { cols: state.cols, rows: state.rows, color });
      const frame = lines.join("\n");
      if (!force && frame === lastFrame) return;
      lastFrame = frame;
      lastPaint = Date.now();
      // one write per frame: home, then each line with erase-to-EOL; no trailing newline (no scroll)
      io.write("\x1b[?2026h\x1b[H" + lines.map((l) => l + "\x1b[0m\x1b[K").join("\r\n") + "\x1b[?2026l");
    };
    const schedule = (): void => {
      if (finished || paintTimer) return;
      const wait = Math.max(0, minFrame - (Date.now() - lastPaint));
      paintTimer = setTimeout(() => guard(() => paint()), wait);
    };

    const refresh = (): void => {
      const sel = selectedRun(state);
      const snap = load(state.cwds, sel ? runKey(sel) : undefined);
      state = reduce(state, { type: "data", ...snap, now: now() });
    };
    const dispatch = (e: Event): void => {
      state = reduce(state, e);
      if (state.quit) return finish({ reason: "quit" });
      if (state.effects.length > 0) {
        state = applyEffects(state, { spawn: launcher });
        refresh();
      } else if (e.type === "key") {
        // selection may have changed: load the log of the newly selected run
        refresh();
      }
      schedule();
    };
    const poll = (): void => {
      const before = state.selKey;
      refresh();
      // a launch may have re-targeted the selection: reload its log
      if (state.selKey !== before) refresh();
      schedule();
    };

    // signals / exit: restore the terminal in every way the process can end
    const onExit = (): void => term.restore();
    const onSignal = (): void => finish({ reason: "signal" });
    const onUncaught = (err: unknown): void => {
      finish({ reason: "error", error: err });
      process.exitCode = 1;
    };
    const hooks: Array<[string, (...a: never[]) => void]> = [
      ["exit", onExit],
      ["SIGINT", onSignal],
      ["SIGTERM", onSignal],
      ["SIGHUP", onSignal],
      ["uncaughtException", onUncaught as (...a: never[]) => void],
      ["unhandledRejection", onUncaught as (...a: never[]) => void],
    ];
    for (const [ev, fn] of hooks) {
      io.proc.on(ev, fn);
      disposers.push(() => io.proc.off(ev, fn));
    }

    try {
      term.enter();
      io.input.setRaw(true);
      disposers.push(
        io.input.onData((chunk) =>
          guard(() => {
            for (const key of parseKeys(chunk)) {
              if (finished) break;
              dispatch({ type: "key", key });
            }
          }),
        ),
      );
      disposers.push(
        io.onResize(() =>
          guard(() => {
            const { cols, rows } = io.size();
            state = reduce(state, { type: "resize", cols, rows });
            io.write("\x1b[2J");
            lastFrame = "";
            schedule();
          }),
        ),
      );
      const pollTimer = setInterval(() => guard(poll), opts.pollMs ?? 1000);
      const tickTimer = setInterval(
        () =>
          guard(() => {
            if (state.runs.some((r) => r.p.status === "running")) dispatch({ type: "tick" });
          }),
        opts.tickMs ?? 250,
      );
      disposers.push(() => clearInterval(pollTimer), () => clearInterval(tickTimer));
      refresh();
      paint(true);
    } catch (e) {
      finish({ reason: "error", error: e });
    }
  });
}

// ------------------------------------------------------------------- launch

/** The mola entry script running this process, if it exists on disk. */
export function molaBinPath(argv1: string | undefined = process.argv[1]): string | undefined {
  return argv1 && fs.existsSync(argv1) ? argv1 : undefined;
}

/** Start `mola go "<intent>"` detached, output to .mstack/runs/go-launch-<ts>.log. */
export function launchGo(req: LaunchRequest, ts: number): string {
  const bin = molaBinPath();
  if (!bin) throw new Error("cannot locate the mola bin (process.argv[1])");
  const spec = buildLaunch(req, bin, process.execPath, ts);
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
  const fd = fs.openSync(spec.logFile, "a");
  try {
    const child = spawnChild(spec.command, spec.args, { cwd: spec.cwd, detached: true, stdio: ["ignore", fd, fd] });
    child.on("error", () => {});
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
  return spec.logFile;
}

export function systemIO(): TuiIO {
  const out = process.stdout;
  const inp = process.stdin;
  return {
    write: (s) => void out.write(s),
    size: () => ({ cols: out.columns || 80, rows: out.rows || 24 }),
    onResize(fn) {
      out.on("resize", fn);
      return () => void out.off("resize", fn);
    },
    input: {
      setRaw: (on) => void inp.setRawMode?.(on),
      onData(fn) {
        inp.setEncoding("utf8");
        const h = (c: string | Buffer): void => fn(c.toString());
        inp.on("data", h);
        inp.resume();
        return () => void inp.off("data", h);
      },
      close: () => void inp.pause(),
    },
    proc: {
      on: (ev, fn) => void process.on(ev, fn as never),
      off: (ev, fn) => void process.off(ev, fn as never),
    },
  };
}

// ------------------------------------------------------------------ command

/** One plain-text frame of the given dirs (the `--once` / pipe path). */
export function onceFrame(cwds: string[], cols = 100, rows = 32, now = Date.now()): string {
  const snap = loadSnapshot(cwds);
  let s = initialState(cwds, { cols, rows }, now);
  s = reduce(s, { type: "data", ...snap, now });
  return renderPlain(s, cols, rows);
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["tui"],
      description: "full-screen live view of runs and workers: approve, deny, stop, start",
      async handler(args, io) {
        if (args.positionals.length > 0) throw new MolaError("USAGE_ERROR", USAGE, ExitCode.Usage);
        const configured = ctx.config.get<unknown>("web.cwds", []);
        const cfgCwds = Array.isArray(configured) ? configured.filter((c): c is string => typeof c === "string") : [];
        const cwds = [
          ...new Set([io.cwd, ...cwdFlags(args.flags.cwd, process.argv), ...cfgCwds, process.cwd()].map((c) => path.resolve(io.cwd, c))),
        ];
        const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;
        if (args.flags.once || !interactive || io.json) {
          const cols = process.stdout.columns || 100;
          const runs = loadSnapshot(cwds).runs;
          // size the frame to the content: 2 lines per run, bounded, so pipes do not get a screenful of blanks
          const rows = Math.max(16, Math.min(40, runs.length * 2 + 12));
          io.out(onceFrame(cwds, cols, rows).replace(/\n$/, ""));
          io.data({ cwds, runs: runs.map((r) => ({ id: r.p.id, cwd: r.cwd, status: r.p.status })) });
          return ExitCode.Ok;
        }
        const res = await runTui({
          cwds,
          io: systemIO(),
          color: detectColor(process.stdout),
          err: (s) => void process.stderr.write(s),
        });
        return res.reason === "error" ? ExitCode.Software : ExitCode.Ok;
      },
    });
  },
});
