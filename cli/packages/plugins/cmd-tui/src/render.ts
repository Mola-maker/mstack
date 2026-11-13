/**
 * cmd-tui renderer: `render(state, {cols, rows, color}) -> string[]`.
 * Pure. Returns exactly `rows` lines, each exactly `cols` cells wide
 * (display width, so CJK counts 2), with ANSI only when `color` is true.
 */

import {
  displayWidth,
  formatDuration,
  formatProgressLine,
  palette,
  table,
  type Palette,
  type StageStatus,
  type WorkerStatus,
} from "@mola/plugin-sdk";
import { selectedIndex, selectedRun, type RunView, type State } from "./model.js";

export interface RenderOptions {
  cols: number;
  rows: number;
  color: boolean;
}

type Paint = (s: string) => string;
type Seg = [text: string, paint?: Paint];
type Line = Seg[] & { rev?: boolean };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---------------------------------------------------------------- text utils

/** Strip control characters and escapes from text that came from files. */
export function clean(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[\s\S]?/g, "")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Truncate to at most `w` cells, ending in "…" when cut. */
export function trunc(s: string, w: number): string {
  if (w <= 0) return "";
  if (displayWidth(s) <= w) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return out + "…";
}

/** Truncate, then pad with spaces to exactly `w` cells. */
export function fit(s: string, w: number): string {
  const t = trunc(s, w);
  return t + " ".repeat(Math.max(0, w - displayWidth(t)));
}

/** Fit a segmented line to exactly `w` cells; `plain` ignores the paints. */
function fitLine(line: Line, w: number, plain = false): string {
  const total = line.reduce((n, [t]) => n + displayWidth(t), 0);
  const budget = total > w ? w - 1 : w;
  let out = "";
  let used = 0;
  let cut = false;
  for (const [text, paint] of line) {
    if (cut) break;
    let piece = "";
    for (const ch of text) {
      const cw = displayWidth(ch);
      if (used + cw > budget) {
        cut = true;
        break;
      }
      piece += ch;
      used += cw;
    }
    out += paint && !plain && piece ? paint(piece) : piece;
  }
  if (total > w) {
    out += "…";
    used += 1;
  }
  return out + " ".repeat(Math.max(0, w - used));
}

const blank = (w: number): string => " ".repeat(Math.max(0, w));

// --------------------------------------------------------------------- glyphs

function runIcon(status: RunView["p"]["status"], tick: number): string {
  switch (status) {
    case "running":
      return SPINNER[tick % SPINNER.length];
    case "blocked":
      return "⏸";
    case "done":
      return "✔";
    case "failed":
      return "✘";
    case "stopped":
      return "■";
  }
}

function runPaint(pal: Palette, status: RunView["p"]["status"]): Paint {
  return status === "running" ? pal.cyan : status === "blocked" ? pal.yellow : status === "done" ? pal.green : status === "failed" ? pal.red : pal.dim;
}

function stageIcon(status: StageStatus, tick: number): string {
  switch (status) {
    case "pending":
      return "·";
    case "running":
      return SPINNER[tick % SPINNER.length];
    case "done":
      return "✔";
    case "failed":
      return "✘";
    case "skipped":
      return "↷";
    case "blocked":
      return "⏸";
  }
}

function stagePaint(pal: Palette, status: StageStatus): Paint {
  return status === "running" ? pal.cyan : status === "done" ? pal.green : status === "failed" ? pal.red : status === "blocked" ? pal.yellow : pal.dim;
}

const WORKER_DOT: Record<WorkerStatus, string> = { working: "●", blocked: "◐", idle: "○", done: "✔", failed: "✘" };

function workerPaint(pal: Palette, status: WorkerStatus): Paint {
  return status === "working" ? pal.cyan : status === "blocked" ? pal.yellow : status === "done" ? pal.green : status === "failed" ? pal.red : pal.dim;
}

const money = (n: number | undefined): string => (n === undefined ? "-" : `$${n.toFixed(2)}`);

// ---------------------------------------------------------------------- panes

interface Pane {
  title: string;
  lines: Line[];
}

function drawPane(pane: Pane, w: number, h: number, pal: Palette): string[] {
  if (h <= 0) return [];
  const head = `─ ${pane.title} `;
  const rule = head + "─".repeat(Math.max(0, w - displayWidth(head)));
  const out = [fitLine([[rule, pal.bold]], w)];
  for (let i = 0; i < h - 1; i++) {
    const l = pane.lines[i];
    if (!l) out.push(blank(w));
    else if (l.rev) out.push(pal.color ? `\x1b[7m${fitLine(l, w, true)}\x1b[0m` : fitLine(l, w, true));
    else out.push(fitLine(l, w));
  }
  return out;
}

function runsPane(s: State, w: number, h: number, pal: Palette): Pane {
  const lines: Line[] = [];
  const n = s.runs.length;
  if (n === 0) {
    lines.push([[" no runs yet — press g to start one", pal.dim]]);
    lines.push([[` watching ${s.cwds.length} dir${s.cwds.length === 1 ? "" : "s"}`, pal.dim]]);
    return { title: "Runs (0)", lines };
  }
  const multi = new Set(s.runs.map((r) => r.cwd)).size > 1;
  const perPage = Math.max(1, Math.floor((h - 1) / 2));
  const sel = selectedIndex(s);
  const start = Math.max(0, Math.min(sel - Math.floor(perPage / 2), n - perPage));
  for (let i = start; i < Math.min(n, start + perPage); i++) {
    const r = s.runs[i];
    const on = i === sel;
    const base = (r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd);
    const prog = clean(formatProgressLine(r.p, s.now)) + (multi ? `  [${clean(base)}]` : "");
    const l1: Line = [
      [on ? "›" : " ", on ? pal.bold : undefined],
      [runIcon(r.p.status, s.tick), runPaint(pal, r.p.status)],
      [` ${clean(r.p.id)}`, pal.bold],
      [`  ${clean(r.p.intent)}`],
    ];
    const l2: Line = [["    "], [prog, pal.dim]];
    if (on) {
      // reverse video for the selected pair (drawPane renders it without inner paints)
      l1.rev = true;
      l2.rev = true;
    }
    lines.push(l1, l2);
  }
  const more = n > perPage ? ` · ${sel + 1}/${n}` : "";
  return { title: `Runs (${n})${more}`, lines };
}

function pipelinePane(s: State, r: RunView | undefined, w: number, pal: Palette): Pane {
  const lines: Line[] = [];
  if (!r) return { title: "Pipeline", lines: [[[" select a run", pal.dim]]] };
  const chips: Seg[][] = r.p.stages.map((st) => [
    [stageIcon(st.status, s.tick), stagePaint(pal, st.status)],
    [` ${st.name}`, st.status === "running" ? pal.bold : stagePaint(pal, st.status)],
  ]);
  let cur: Line = [[" "]];
  let curW = 1;
  for (const [i, chip] of chips.entries()) {
    const cw = chip.reduce((n, [t]) => n + displayWidth(t), 0);
    const sepW = i === 0 ? 0 : 3;
    if (curW + sepW + cw > w && curW > 1) {
      lines.push(cur);
      cur = [[" "]];
      curW = 1;
    } else if (i > 0) {
      cur.push([" → ", pal.dim]);
      curW += 3;
    }
    cur.push(...chip);
    curW += cw;
  }
  if (chips.length === 0) cur.push(["(no stages yet)", pal.dim]);
  lines.push(cur);
  for (const st of r.p.stages) {
    if (st.model === undefined && st.costUsd === undefined) continue;
    lines.push([
      [`   ${st.name.padEnd(9)}`, stagePaint(pal, st.status)],
      [` ${fit(clean(st.model ?? "-"), 16).trimEnd().padEnd(16)}`],
      [` ${money(st.costUsd)}`, pal.dim],
    ]);
  }
  return { title: `Pipeline · ${clean(r.p.id)}`, lines };
}

function workersPane(s: State, r: RunView | undefined, w: number, pal: Palette): Pane {
  if (!r) return { title: "Workers", lines: [[[" select a run", pal.dim]]] };
  const lines: Line[] = [];
  for (const wk of r.p.workers) {
    const started = wk.startedAt ? Date.parse(wk.startedAt) : NaN;
    const end = wk.status === "working" || wk.status === "blocked" ? s.now : Date.parse(wk.updatedAt ?? "") || s.now;
    const elapsed = Number.isNaN(started) ? "-" : formatDuration(end - started);
    const line: Line = [
      [` ${WORKER_DOT[wk.status]}`, workerPaint(pal, wk.status)],
      [` ${wk.status.padEnd(7)}`, workerPaint(pal, wk.status)],
      [` ${wk.stage.padEnd(9)}`],
    ];
    if (w >= 56) line.push([` ${fit(clean(wk.model ?? "-"), 12)}`]);
    line.push([` ${elapsed.padStart(6)}`], [` ${money(wk.costUsd).padStart(6)}`]);
    if (wk.lastLine) line.push([`  ${clean(wk.lastLine)}`, pal.dim]);
    lines.push(line);
  }
  if (lines.length === 0) lines.push([[" no workers", pal.dim]]);
  return { title: `Workers (${r.p.workers.length})`, lines };
}

function logPane(s: State, h: number, pal: Palette): Pane {
  const src = s.logSource ? ` · ${clean(s.logSource)}` : "";
  const room = Math.max(0, h - 1);
  const tail = s.log.slice(-room);
  const lines: Line[] = tail.map((l) => [[" " + clean(l)]]);
  if (lines.length === 0) lines.push([[" (no events.jsonl or artifacts yet)", pal.dim]]);
  return { title: `Log${src}`, lines };
}

function detailPane(s: State, r: RunView | undefined, pal: Palette): Pane {
  if (!r) return { title: "Detail", lines: [[[" select a run", pal.dim]]] };
  const p = r.p;
  const lines: Line[] = [
    [[" intent  ", pal.dim], [clean(p.intent)]],
    [[" status  ", pal.dim], [p.status, runPaint(pal, p.status)], [`  stage ${p.stage}  ${money(p.costUsd)}  ${p.origin ? "origin " + clean(p.origin) : ""}`]],
    [[" cwd     ", pal.dim], [clean(r.cwd)]],
  ];
  if (p.blocked) lines.push([[" blocked ", pal.dim], [clean(p.blocked.reason), pal.yellow]]);
  if (p.next) lines.push([[" next    ", pal.dim], [clean(p.next)]]);
  lines.push([[""]]);
  const rows = p.stages.map((st) => [
    `${stageIcon(st.status, s.tick)} ${st.name}`,
    st.status,
    clean(st.model ?? "-"),
    clean(st.agent ?? "-"),
    money(st.costUsd),
    st.startedAt && st.endedAt ? formatDuration(Date.parse(st.endedAt) - Date.parse(st.startedAt)) : "-",
    clean(st.summary ?? ""),
  ]);
  for (const t of table({ header: ["stage", "status", "model", "agent", "cost", "time", "summary"], rows, indent: " " })) {
    lines.push([[t]]);
  }
  lines.push([[""]], [[` Artifacts (${s.artifacts.length})`, pal.bold]]);
  for (const a of s.artifacts) lines.push([["   " + clean(a)]]);
  if (s.artifacts.length === 0) lines.push([["   none", pal.dim]]);
  return { title: `Detail · ${clean(p.id)}  (enter to close)`, lines };
}

const HELP = [
  "",
  "  ↑ ↓ / j k    select a run",
  "  PgUp PgDn    jump 5 runs",
  "  enter        toggle the detail view (stage table, artifacts)",
  "  a            approve the pending approval   (asks y/n)",
  "  d            deny the pending approval      (asks y/n)",
  "  s            stop the run: writes STOP      (asks y/n)",
  "  g            new intent: runs `mola go \"<intent>\"` detached",
  "  r            refresh now",
  "  ?            this help",
  "  q / Ctrl-C   quit (the terminal is restored)",
  "",
  "  Data is polled every second from <cwd>/.mstack/runs.",
  "  Press any key to close.",
];

// --------------------------------------------------------------------- layout

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Heights for stacked panes: `need` rows each, capped, with the last pane taking the rest. */
function heights(total: number, needs: number[], caps: number[]): number[] {
  const out = needs.map((n, i) => Math.max(3, Math.min(n, caps[i])));
  let used = out.slice(0, -1).reduce((a, b) => a + b, 0);
  // leave at least 3 rows for the last pane by shrinking the others
  for (let i = out.length - 2; i >= 0 && total - used < 3; i--) {
    const give = Math.min(out[i] - 1, 3 - (total - used));
    out[i] -= give;
    used -= give;
  }
  out[out.length - 1] = Math.max(0, total - used);
  return out;
}

export function render(s: State, o: RenderOptions): string[] {
  const { cols, rows } = o;
  const pal = palette(o.color);
  const out: string[] = [];
  const bodyH = Math.max(1, rows - 3);

  // title
  const running = s.runs.filter((r) => r.p.status === "running").length;
  const blocked = s.runs.filter((r) => r.p.status === "blocked").length;
  const cost = s.runs.reduce((n, r) => n + r.p.costUsd, 0);
  out.push(
    fitLine([[" mola tui", pal.bold], [`  ${s.runs.length} runs · ${running} running · ${blocked} blocked · $${cost.toFixed(2)}`, pal.dim]], cols),
  );

  // body
  let body: string[];
  const sel = selectedRun(s);
  if (s.help) {
    body = drawPane({ title: "Help", lines: HELP.map((l): Line => [[l]]) }, cols, bodyH, pal);
  } else if (cols >= 80) {
    const leftW = clamp(Math.round(cols * 0.4), 30, Math.min(56, cols - 30));
    const rightW = cols - leftW - 1;
    const left = drawPane(runsPane(s, leftW, bodyH, pal), leftW, bodyH, pal);
    let right: string[];
    if (s.detail) {
      right = drawPane(detailPane(s, sel, pal), rightW, bodyH, pal);
    } else {
      const pipe = pipelinePane(s, sel, rightW, pal);
      const work = workersPane(s, sel, rightW, pal);
      const [ph, wh, lh] = heights(bodyH, [pipe.lines.length + 1, work.lines.length + 1, bodyH], [Math.floor(bodyH * 0.4), Math.floor(bodyH * 0.35), bodyH]);
      right = [
        ...drawPane(pipe, rightW, ph, pal),
        ...drawPane(work, rightW, wh, pal),
        ...drawPane(logPane(s, lh, pal), rightW, lh, pal),
      ];
    }
    const sep = fitLine([["│", pal.dim]], 1);
    body = [];
    for (let i = 0; i < bodyH; i++) body.push(`${left[i] ?? blank(leftW)}${sep}${right[i] ?? blank(rightW)}`);
  } else {
    // stacked: everything full width, one above the other
    const runs = runsPane(s, cols, bodyH, pal);
    if (s.detail) {
      const [rh] = heights(bodyH, [Math.min(runs.lines.length + 1, 5), bodyH], [Math.max(3, Math.floor(bodyH * 0.25)), bodyH]);
      body = [...drawPane(runsPane(s, cols, rh, pal), cols, rh, pal), ...drawPane(detailPane(s, sel, pal), cols, bodyH - rh, pal)];
    } else {
      const pipe = pipelinePane(s, sel, cols, pal);
      const work = workersPane(s, sel, cols, pal);
      const [rh, ph, wh, lh] = heights(
        bodyH,
        [runs.lines.length + 1, pipe.lines.length + 1, work.lines.length + 1, bodyH],
        [Math.max(3, Math.floor(bodyH * 0.3)), Math.floor(bodyH * 0.25), Math.floor(bodyH * 0.25), bodyH],
      );
      body = [
        ...drawPane(runsPane(s, cols, rh, pal), cols, rh, pal),
        ...drawPane(pipe, cols, ph, pal),
        ...drawPane(work, cols, wh, pal),
        ...drawPane(logPane(s, lh, pal), cols, lh, pal),
      ];
    }
  }
  while (body.length < bodyH) body.push(blank(cols));
  out.push(...body.slice(0, bodyH));

  // bar A: prompt / confirmation / blocked reason + action / message
  out.push(barLine(s, sel, cols, pal));
  // bar B: keys
  const keys = cols >= 90
    ? " ↑↓/jk select · enter detail · a approve · d deny · s stop · g new · r refresh · ? help · q quit"
    : " ↑↓ select · enter · a/d · s · g · r · ? · q";
  out.push(fitLine([[keys, pal.dim]], cols));

  return out.slice(0, rows).concat(Array.from({ length: Math.max(0, rows - out.length) }, () => blank(cols)));
}

function barLine(s: State, sel: RunView | undefined, cols: number, pal: Palette): string {
  if (s.mode === "prompt") return fitLine([[" new intent ▸ ", pal.cyan], [clean(s.prompt)], ["▏", pal.cyan], ["   enter run · esc cancel", pal.dim]], cols);
  if (s.mode === "confirm" && s.confirm) return fitLine([[" " + clean(s.confirm.text), pal.yellow]], cols);
  if (sel && sel.p.status === "blocked") {
    const reason = clean(sel.p.blocked?.reason ?? "waiting");
    const a = sel.approval;
    const action = !sel.p.blocked?.approvalId
      ? "no approval attached"
      : !a
        ? "approval file not found"
        : a.status !== "pending"
          ? `${a.status} by ${clean(a.decidedBy ?? "?")}`
          : `action: ${clean(a.action)}  → [a] approve  [d] deny`;
    const line: Line = [[" ⏸ blocked: ", pal.yellow], [reason, pal.yellow], [" │ ", pal.dim], [action, pal.bold]];
    if (s.msg) line.push([`  · ${clean(s.msg)}`, pal.dim]);
    return fitLine(line, cols);
  }
  return fitLine([[s.msg ? " " + clean(s.msg) : "", pal.dim]], cols);
}

/** Plain-text frame for `--once` and pipes: no escapes, trailing blanks trimmed. */
export function renderPlain(s: State, cols: number, rows: number): string {
  const lines = render(s, { cols, rows, color: false }).map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

