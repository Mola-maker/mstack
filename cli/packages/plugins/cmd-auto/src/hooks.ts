/**
 * Webhook triggers, served by `mola serve` at POST /hooks/<id>/<secret>. The
 * secret is in the path, so only someone you gave the URL can start a run.
 *
 * Per hook: an optional HMAC signature check (GitHub's x-hub-signature-256), filters
 * on request values, a duplicate key ignored for 7 days, a coalescing window
 * (one run with the latest payload when the window from the first delivery
 * closes), at most 60 deliveries a minute (429 after), bodies up to 1 MiB.
 *
 * The prompt is a template: {{body.path}}, {{headers.name}}, {{query.name}},
 * {{body}}, {{request}}. Every value goes in wrapped as untrusted data, with
 * mentions like $skill, @file and /command broken so they cannot act.
 */

import * as crypto from "node:crypto";
import { wrapUntrusted } from "@mola/plugin-sdk";

export interface HookFilter {
  key: string;
  op: "equals" | "oneOf" | "exists";
  value?: string;
}

export interface Hook {
  id: string;
  secret: string;
  cwd: string;
  prompt: string;
  auto: boolean;
  enabled: boolean;
  createdAt: string;
  signature?: { header: string; secret: string };
  filters: HookFilter[];
  dedupeKey?: string;
  coalesceKey?: string;
  coalesceSec?: number;
  /** skip a delivery older than this when it arrives (held while offline) */
  maxAgeSec?: number;
}

export interface HookRequest {
  headers: Record<string, string>;
  query: Record<string, string>;
  rawBody: string;
}

export interface Delivery {
  hookId: string;
  at: string;
  outcome: "started" | "filtered" | "duplicate" | "coalesced" | "rejected" | "rate-limited";
  reason?: string;
  key?: string;
  runKey?: string;
  prompt?: string;
}

export const MAX_BODY = 1024 * 1024;
export const RATE_PER_MIN = 60;
export const DEDUPE_MS = 7 * 86400000;

export interface RequestView {
  body: unknown;
  rawBody: string;
  headers: Record<string, string>;
  query: Record<string, string>;
}

export function viewOf(req: HookRequest): RequestView {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  let body: unknown = req.rawBody;
  const ct = (headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (ct === "application/json" || (!ct && /^\s*[{[]/.test(req.rawBody))) {
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      body = req.rawBody;
    }
  } else if (ct === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams(req.rawBody);
    const o: Record<string, string> = {};
    for (const [k, v] of params) o[k] = v;
    // GitHub sends form-encoded JSON in `payload`
    if (typeof o.payload === "string") {
      try {
        body = JSON.parse(o.payload);
      } catch {
        body = o;
      }
    } else body = o;
  }
  return { body, rawBody: req.rawBody, headers, query: req.query };
}

/** `body.pull_request.html_url` → the value, or undefined. */
export function lookup(view: RequestView, key: string): unknown {
  const parts = key.split(".");
  const head = parts.shift();
  let cur: unknown;
  if (head === "body") cur = parts.length === 0 ? view.rawBody : view.body;
  else if (head === "headers") return parts.length ? view.headers[parts.join(".").toLowerCase()] : view.headers;
  else if (head === "query") return parts.length ? view.query[parts.join(".")] : view.query;
  else if (head === "request") return { headers: view.headers, query: view.query, body: view.body };
  else return undefined;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const asText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** Fill a template. With `wrap`, each value goes in as untrusted data. */
export function render(template: string, view: RequestView, wrap: boolean): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    const text = asText(lookup(view, key));
    if (!text) return "";
    return wrap ? wrapUntrusted(`webhook ${key}`, text) : text;
  });
}

export function checkFilters(filters: HookFilter[], view: RequestView): HookFilter | undefined {
  for (const f of filters) {
    const v = lookup(view, f.key);
    if (f.op === "exists") {
      if (v === undefined || v === null || v === "") return f;
      continue;
    }
    if (v !== null && typeof v === "object") return f;
    const text = asText(v);
    if (f.op === "equals" && text !== (f.value ?? "")) return f;
    if (f.op === "oneOf" && !(f.value ?? "").split(",").map((s) => s.trim()).includes(text)) return f;
  }
  return undefined;
}

/** `key=value`, `key in a,b`, `key exists`. */
export function parseFilter(text: string): HookFilter {
  const t = text.trim();
  let m = /^([\w.-]+)\s+exists$/.exec(t);
  if (m) return { key: m[1], op: "exists" };
  m = /^([\w.-]+)\s+in\s+(.+)$/.exec(t);
  if (m) return { key: m[1], op: "oneOf", value: m[2] };
  m = /^([\w.-]+)\s*=\s*(.*)$/.exec(t);
  if (m) return { key: m[1], op: "equals", value: m[2] };
  throw new Error(`bad filter "${text}" (key=value, "key in a,b" or "key exists")`);
}

export function verifySignature(hook: Hook, req: HookRequest): boolean {
  if (!hook.signature) return true;
  const header = Object.entries(req.headers).find(([k]) => k.toLowerCase() === hook.signature!.header.toLowerCase())?.[1] ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", hook.signature.secret).update(req.rawBody, "utf8").digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function secretMatches(hook: Hook, given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(hook.secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface HookState {
  /** dedupe key → first seen (ms) */
  seen: Record<string, number>;
  /** hookId:coalesceKey → window */
  pending: Record<string, { hookId: string; firstAt: number; fireAt: number; req: HookRequest; count: number }>;
  /** hookId → recent delivery times (ms) */
  recent: Record<string, number[]>;
}

export type Decision =
  | { action: "start"; prompt: string; runKey: string; delivery: Delivery }
  | { action: "hold"; delivery: Delivery }
  | { action: "drop"; status: number; delivery: Delivery };

/** What one delivery does. Mutates `state`; the caller persists it. */
export function decide(hook: Hook, req: HookRequest, state: HookState, now: number): Decision {
  const at = new Date(now).toISOString();
  const base = { hookId: hook.id, at };
  const recent = (state.recent[hook.id] ?? []).filter((t) => now - t < 60000);
  if (recent.length >= RATE_PER_MIN) {
    state.recent[hook.id] = recent;
    return { action: "drop", status: 429, delivery: { ...base, outcome: "rate-limited" } };
  }
  recent.push(now);
  state.recent[hook.id] = recent;
  if (!hook.enabled) return { action: "drop", status: 404, delivery: { ...base, outcome: "rejected", reason: "hook paused" } };
  if (req.rawBody.length > MAX_BODY) return { action: "drop", status: 413, delivery: { ...base, outcome: "rejected", reason: "body over 1 MiB" } };
  if (!verifySignature(hook, req)) return { action: "drop", status: 401, delivery: { ...base, outcome: "rejected", reason: "bad signature" } };
  const view = viewOf(req);
  const failed = checkFilters(hook.filters, view);
  if (failed) return { action: "drop", status: 202, delivery: { ...base, outcome: "filtered", reason: `${failed.key} ${failed.op} ${failed.value ?? ""}`.trim() } };

  for (const [k, t] of Object.entries(state.seen)) if (now - t > DEDUPE_MS) delete state.seen[k];
  let dedupe: string | undefined;
  if (hook.dedupeKey) {
    const k = render(hook.dedupeKey, view, false);
    if (k) {
      dedupe = `${hook.id}:${k}`;
      if (state.seen[dedupe] !== undefined) return { action: "drop", status: 202, delivery: { ...base, outcome: "duplicate", key: k } };
      state.seen[dedupe] = now;
    }
  }
  if (hook.coalesceKey) {
    const k = render(hook.coalesceKey, view, false);
    if (k) {
      const slot = `${hook.id}:${k}`;
      const win = state.pending[slot];
      if (win) {
        win.req = req;
        win.count++;
      } else {
        state.pending[slot] = { hookId: hook.id, firstAt: now, fireAt: now + (hook.coalesceSec ?? 120) * 1000, req, count: 1 };
      }
      return { action: "hold", delivery: { ...base, outcome: "coalesced", key: k } };
    }
  }
  const runKey = `hook:${hook.id}:${dedupe ? crypto.createHash("sha256").update(dedupe).digest("hex").slice(0, 12) : now.toString(36)}`;
  const prompt = render(hook.prompt, view, true);
  return { action: "start", prompt, runKey, delivery: { ...base, outcome: "started", runKey, prompt: prompt.slice(0, 300) } };
}

/** Windows whose time has come: removed from state, each with the prompt for its latest payload. */
export function closeWindows(hooks: Hook[], state: HookState, now: number): { hook: Hook; prompt: string; runKey: string; count: number }[] {
  const out: { hook: Hook; prompt: string; runKey: string; count: number }[] = [];
  for (const [slot, w] of Object.entries(state.pending)) {
    if (w.fireAt > now) continue;
    delete state.pending[slot];
    const hook = hooks.find((h) => h.id === w.hookId);
    if (!hook || !hook.enabled) continue;
    const runKey = `hook:${hook.id}:c${crypto.createHash("sha256").update(`${slot}:${w.firstAt}`).digest("hex").slice(0, 12)}`;
    out.push({ hook, prompt: render(hook.prompt, viewOf(w.req), true), runKey, count: w.count });
  }
  return out;
}
