#!/usr/bin/env node
// Headed visual fallback for m-cua: pack a current window screenshot and
// metadata, then (only with --headed-visual) click a model-supplied PNG point
// and return an after image. This script does not locate the target and never
// treats delivered_unverified as task success.
// Usage:
//   node cua-visual.mjs observe --app <app> --out-dir <dir> [--window-id <id>] [--bin <agent-desktop>]
//   node cua-visual.mjs act --observe <observe.json> --png-x <n> --png-y <n> --headed-visual [--bin <agent-desktop>]
// Exit 0: the command finished and printed an envelope (observe packed, or act
// delivered a click and an after image). Exit 1: refused or the driver failed.
// Exit 2: bad arguments. Task success is decided by the model from the after image.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RUN_TIMEOUT_MS = 15000;
const EPS = 0.5;

const MAPPING_FORMULA = "screen = bounds.origin + png / scale_factor";
const FRESHNESS_KIND = "window_id_and_bounds";
const FRESHNESS_REASON =
  "Act re-reads list-windows for the observed window id and refuses if that window is gone or its bounds changed. There is no wall-clock TTL: model think time (an 80s gap was recorded between a still-unmoved window's screenshot and the click) does not stale the mapping by itself.";

export function pngToScreen(bounds, scaleFactor, pngX, pngY) {
  const scale = Number(scaleFactor);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("scale_factor must be a positive number");
  return {
    x: Math.round(Number(bounds.x) + Number(pngX) / scale),
    y: Math.round(Number(bounds.y) + Number(pngY) / scale),
  };
}

export function pngInImage(pngX, pngY, width, height) {
  return Number(pngX) >= 0 && Number(pngY) >= 0 && Number(pngX) < Number(width) && Number(pngY) < Number(height);
}

export function sizeMatchesBounds(bounds, width, height, scaleFactor, eps = EPS) {
  const scale = Number(scaleFactor);
  if (!Number.isFinite(scale) || scale <= 0) return false;
  return Math.abs(Number(width) / scale - Number(bounds.width)) <= eps
    && Math.abs(Number(height) / scale - Number(bounds.height)) <= eps;
}

export function boundsEqual(a, b, eps = EPS) {
  if (!a || !b) return false;
  return Math.abs(Number(a.x) - Number(b.x)) <= eps
    && Math.abs(Number(a.y) - Number(b.y)) <= eps
    && Math.abs(Number(a.width) - Number(b.width)) <= eps
    && Math.abs(Number(a.height) - Number(b.height)) <= eps;
}

export function selectWindow(windows, { app, windowId }) {
  const list = Array.isArray(windows) ? windows : [];
  if (windowId) {
    const hits = list.filter((w) => w && w.id === windowId);
    if (hits.length === 1) return { ok: true, window: hits[0] };
    if (hits.length === 0) return { ok: false, error: `window-id ${windowId} was not in list-windows`, candidates: list };
    return { ok: false, error: `window-id ${windowId} matched ${hits.length} list-windows entries`, candidates: hits };
  }
  const named = list.filter((w) => w && w.app_name === app);
  const pool = named.length ? named : list;
  const visible = pool.filter((w) => w && w.visible !== false && w.minimized !== true);
  const use = visible.length ? visible : pool;
  if (use.length === 1) return { ok: true, window: use[0] };
  if (use.length === 0) return { ok: false, error: `no window for app ${app}`, candidates: list };
  return { ok: false, error: `ambiguous windows for app ${app}`, candidates: use };
}

export function parseEnvelope(text) {
  const raw = String(text ?? "").trim();
  const start = raw.search(/\{/);
  if (start < 0) return { ok: false, error: { code: "NO_ENVELOPE", message: "driver produced no JSON envelope" }, raw };
  try {
    return JSON.parse(raw.slice(start));
  } catch (err) {
    return { ok: false, error: { code: "BAD_JSON", message: err.message }, raw: raw.slice(0, 200) };
  }
}

function run(bin, args, env = process.env) {
  const r = spawnSync(bin, args, { encoding: "utf8", env, timeout: RUN_TIMEOUT_MS, windowsHide: true });
  return {
    status: r.status,
    out: (r.stdout || "") + (r.stderr || ""),
    error: r.error?.message,
    code: r.error?.code,
    signal: r.signal,
    args,
  };
}

function fail(message, extra = {}, code = 1) {
  const body = { ok: false, error: { message, ...extra } };
  process.stdout.write(JSON.stringify(body) + "\n");
  process.exit(code);
}

function printOk(command, data) {
  process.stdout.write(JSON.stringify({ ok: true, command, data }) + "\n");
}

function requireBin(argv) {
  const bin = flag(argv, "--bin") || "agent-desktop";
  return bin;
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  return argv[i + 1] ?? null;
}

function callDriver(bin, args, label) {
  const r = run(bin, args);
  const env = parseEnvelope(r.out);
  if (r.error || r.status !== 0 || env.ok !== true) {
    return {
      ok: false,
      label,
      args,
      status: r.status,
      code: r.code,
      signal: r.signal,
      error: env.error || { message: r.error || r.out.slice(0, 200) || `${label} failed` },
      envelope: env.ok === true ? env : env,
    };
  }
  return { ok: true, label, args, envelope: env, data: env.data };
}

function listWindowsData(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.windows)) return data.windows;
  return [];
}

export function observeFromDriver({ bin, app, windowId, outDir, env, runner = callDriver }) {
  const listed = runner(bin, ["list-windows", "--app", app], "list-windows");
  if (!listed.ok) return listed;
  const windows = listWindowsData(listed.data);
  const picked = selectWindow(windows, { app, windowId });
  if (!picked.ok) return { ok: false, error: { message: picked.error, candidates: picked.candidates } };
  const window = picked.window;
  if (!window.bounds) return { ok: false, error: { message: "list-windows entry has no bounds" } };
  mkdirSync(outDir, { recursive: true });
  const beforePath = join(outDir, "before.png");
  const shotArgs = ["screenshot", "--app", app, "--window-id", window.id, beforePath];
  const shot = runner(bin, shotArgs, "screenshot");
  if (!shot.ok) return shot;
  const shotData = shot.data || {};
  if (!sizeMatchesBounds(window.bounds, shotData.width, shotData.height, shotData.scale_factor)) {
    return {
      ok: false,
      error: {
        message: "screenshot size does not match window bounds at this scale_factor; remapping would be unsafe",
        bounds: window.bounds,
        screenshot: { width: shotData.width, height: shotData.height, scale_factor: shotData.scale_factor },
      },
    };
  }
  const record = {
    app,
    window: {
      id: window.id,
      title: window.title,
      pid: window.pid,
      bounds: window.bounds,
      is_focused: window.is_focused,
      visible: window.visible,
      process_instance: window.process_instance,
    },
    screenshot: {
      path: shotData.path || beforePath,
      width: shotData.width,
      height: shotData.height,
      scale_factor: shotData.scale_factor,
      format: shotData.format,
    },
    mapping: {
      space: "window_png_to_screen",
      formula: MAPPING_FORMULA,
      bounds: window.bounds,
      scale_factor: shotData.scale_factor,
    },
    freshness: { kind: FRESHNESS_KIND, reason: FRESHNESS_REASON },
    model_must: "Locate the target in data.screenshot.path and pass those png-pixel coordinates to act --png-x --png-y. This observe step does not detect or click the target.",
    bin,
    out_dir: outDir,
    driver_calls: [listed.args, shot.args],
  };
  writeFileSync(join(outDir, "observe.json"), JSON.stringify({ ok: true, command: "observe", data: record }, null, 2));
  return { ok: true, data: record };
}

export function actFromDriver({ bin, observe, pngX, pngY, headedVisual, env, runner = callDriver }) {
  if (!headedVisual) {
    return {
      ok: false,
      error: {
        message: "act requires explicit --headed-visual; default remains semantic-only and will not move the pointer",
        code: "HEADED_VISUAL_REQUIRED",
      },
    };
  }
  const window = observe.window;
  const shot = observe.screenshot;
  const bounds = observe.mapping?.bounds || window.bounds;
  const scale = observe.mapping?.scale_factor ?? shot.scale_factor;
  if (!pngInImage(pngX, pngY, shot.width, shot.height)) {
    return {
      ok: false,
      error: {
        message: "png coordinates are outside the observed screenshot",
        png: { x: pngX, y: pngY },
        screenshot: { width: shot.width, height: shot.height },
      },
    };
  }
  const listed = runner(bin, ["list-windows", "--app", observe.app], "list-windows");
  if (!listed.ok) return listed;
  const picked = selectWindow(listWindowsData(listed.data), { app: observe.app, windowId: window.id });
  if (!picked.ok) return { ok: false, error: { message: `observed window is no longer uniquely present: ${picked.error}`, candidates: picked.candidates, code: "STALE_WINDOW" } };
  if (!boundsEqual(bounds, picked.window.bounds)) {
    return {
      ok: false,
      error: {
        message: "window bounds changed since observe; take a fresh observe and have the model locate the target again",
        code: "STALE_BOUNDS",
        observed: bounds,
        live: picked.window.bounds,
      },
    };
  }
  const screen = pngToScreen(bounds, scale, pngX, pngY);
  const focus = runner(bin, ["--headed", "focus-window", "--window-id", window.id], "focus-window");
  if (!focus.ok) return focus;
  const focusedBounds = focus.data?.focused?.bounds;
  if (focusedBounds && !boundsEqual(bounds, focusedBounds)) {
    return {
      ok: false,
      error: {
        message: "window bounds changed after focus-window; take a fresh observe and have the model locate the target again",
        code: "STALE_BOUNDS",
        observed: bounds,
        live: focusedBounds,
      },
    };
  }
  const click = runner(bin, ["--headed", "mouse-click", "--xy", `${screen.x},${screen.y}`], "mouse-click");
  if (!click.ok) return click;
  const outDir = observe.out_dir;
  mkdirSync(outDir, { recursive: true });
  const afterPath = join(outDir, "after.png");
  const after = runner(bin, ["screenshot", "--app", observe.app, "--window-id", window.id, afterPath], "screenshot");
  if (!after.ok) return after;
  const delivery = click.data?.disposition?.delivery || null;
  return {
    ok: true,
    data: {
      png: { x: Number(pngX), y: Number(pngY) },
      screen,
      headed_visual: true,
      focus_window: clickFocusSummary(focus.envelope),
      click: click.envelope,
      after_screenshot: {
        path: after.data?.path || afterPath,
        width: after.data?.width,
        height: after.data?.height,
        scale_factor: after.data?.scale_factor,
        format: after.data?.format,
      },
      delivery,
      task_succeeded: false,
      verification: {
        status: "needs_model_review",
        reason: "delivered_unverified is not task success. The model must confirm the intended change in data.after_screenshot.path.",
      },
      model_must: "Inspect data.after_screenshot.path and decide whether the task succeeded. Do not treat data.delivery or ok: true as confirmation.",
      driver_calls: [listed.args, focus.args, click.args, after.args],
    },
  };
}

function clickFocusSummary(envelope) {
  const focused = envelope?.data?.focused;
  if (!focused) return envelope;
  return { ok: envelope.ok, command: envelope.command, focused: { id: focused.id, bounds: focused.bounds, is_focused: focused.is_focused } };
}

function usage(exit = 2) {
  process.stderr.write(`Usage:
  node cua-visual.mjs observe --app <app> --out-dir <dir> [--window-id <id>] [--bin <agent-desktop>]
  node cua-visual.mjs act --observe <observe.json> --png-x <n> --png-y <n> --headed-visual [--bin <agent-desktop>]
`);
  process.exit(exit);
}

export function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") usage(cmd ? 0 : 2);
  const bin = requireBin(argv);
  if (cmd === "observe") {
    const app = flag(argv, "--app");
    const outDir = flag(argv, "--out-dir");
    const windowId = flag(argv, "--window-id");
    if (!app || !outDir) usage();
    const result = observeFromDriver({ bin, app, windowId, outDir });
    if (!result.ok) fail(result.error?.message || "observe failed", result.error, 1);
    printOk("observe", result.data);
    return 0;
  }
  if (cmd === "act") {
    const observePath = flag(argv, "--observe");
    const pngX = flag(argv, "--png-x");
    const pngY = flag(argv, "--png-y");
    const headedVisual = argv.includes("--headed-visual");
    if (!observePath || pngX == null || pngY == null) usage();
    let doc;
    try {
      doc = JSON.parse(readFileSync(observePath, "utf8"));
    } catch (err) {
      fail(`cannot read observe file: ${err.message}`, { path: observePath });
    }
    const observe = doc?.data;
    if (!observe?.window?.id || !observe?.screenshot || !observe?.app) {
      fail("observe file is missing window, screenshot, or app", { path: observePath });
    }
    const result = actFromDriver({
      bin: flag(argv, "--bin") || observe.bin || bin,
      observe,
      pngX: Number(pngX),
      pngY: Number(pngY),
      headedVisual,
    });
    if (!result.ok) fail(result.error?.message || "act failed", result.error, 1);
    printOk("act", result.data);
    return 0;
  }
  usage();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
