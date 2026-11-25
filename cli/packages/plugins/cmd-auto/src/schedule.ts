/**
 * Schedules: one `mola go` prompt on a timer. Each due slot starts the run with
 * `--key sched:<id>:<slot>`, so a slot never starts two runs (a restart, a second
 * `mola serve`, a manual `run` on top of a timer).
 *
 * - every: an interval; the first slot is one interval after the schedule was added.
 * - daily: a local time of day; a slot missed by more than 10 minutes (the
 *   machine was off) is skipped, not run late.
 * - once: one time; run when due, also late (then the schedule turns itself off).
 */

export type When = { every: string } | { daily: string } | { once: string };

export interface Schedule {
  id: string;
  cwd: string;
  prompt: string;
  when: When;
  enabled: boolean;
  auto: boolean;
  until?: string;
  createdAt: string;
  lastSlot?: string;
  lastRunAt?: string;
  lastRunId?: string;
}

export const DAILY_GRACE_MS = 10 * 60 * 1000;

/** `30m`, `2h`, `1d`, `90s` → ms; minimum one minute. */
export function parseInterval(text: string): number | undefined {
  const m = /^(\d+)\s*(s|m|min|h|d)$/i.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  const ms = n * (u === "d" ? 86400000 : u === "h" ? 3600000 : u === "s" ? 1000 : 60000);
  return ms >= 60000 ? ms : undefined;
}

export function parseDaily(text: string): { h: number; m: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? { h, m: mi } : undefined;
}

export function validateWhen(w: When): string | undefined {
  if ("every" in w) return parseInterval(w.every) === undefined ? `bad --every "${w.every}" (like 30m, 2h, 1d; at least 1m)` : undefined;
  if ("daily" in w) return parseDaily(w.daily) === undefined ? `bad --daily "${w.daily}" (HH:MM, local time)` : undefined;
  return Number.isNaN(Date.parse(w.once)) ? `bad --once "${w.once}"` : undefined;
}

/**
 * The slot due now, if any: a stable string naming that occurrence. Undefined
 * when nothing is due, or when the due slot was already fired.
 */
export function dueSlot(s: Schedule, now: number): string | undefined {
  if (!s.enabled) return undefined;
  let slot: string | undefined;
  if ("every" in s.when) {
    const every = parseInterval(s.when.every)!;
    const start = Date.parse(s.createdAt);
    const n = Math.floor((now - start) / every);
    if (n >= 1) slot = `e${n}`;
  } else if ("daily" in s.when) {
    const t = parseDaily(s.when.daily)!;
    const d = new Date(now);
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.m, 0, 0).getTime();
    const added = Date.parse(s.createdAt);
    if (now >= at && now - at <= DAILY_GRACE_MS && at >= added) {
      slot = `d${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
  } else {
    if (now >= Date.parse(s.when.once)) slot = "once";
  }
  if (!slot || slot === s.lastSlot) return undefined;
  return slot;
}

/** When the next slot comes, for `schedule list`. */
export function nextRun(s: Schedule, now: number): string {
  if (!s.enabled) return "paused";
  if ("every" in s.when) {
    const every = parseInterval(s.when.every)!;
    const start = Date.parse(s.createdAt);
    const n = Math.max(1, Math.floor((now - start) / every) + 1);
    return new Date(start + n * every).toISOString();
  }
  if ("daily" in s.when) {
    const t = parseDaily(s.when.daily)!;
    const d = new Date(now);
    let at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.m).getTime();
    if (at <= now) at += 86400000;
    return new Date(at).toISOString();
  }
  return s.lastSlot === "once" ? "done" : s.when.once;
}

export function describeWhen(w: When): string {
  return "every" in w ? `every ${w.every}` : "daily" in w ? `daily ${w.daily}` : `once ${w.once}`;
}
