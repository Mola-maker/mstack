/**
 * Usage history from the agents' own transcripts (after T3 Code's Usage page):
 *   - Claude Code: <CLAUDE_CONFIG_DIR|~/.claude>/projects/<project>/*.jsonl, assistant rows
 *     with message.usage; one row per message id (Claude writes a message several times).
 *   - Codex: <CODEX_HOME|~/.codex>/sessions/**\/*.jsonl, `token_count` events; the model
 *     comes from the latest turn_context.
 *
 * Each scan appends rows it has not seen to `$MOLA_HOME/usage/ledger.jsonl`, so the
 * history outlives Claude Code deleting its transcripts after 30 days. The ledger
 * keeps 92 days by default (`usage.retentionDays`, or "unlimited").
 *
 * Cost is an API-equivalent estimate from `$MOLA_HOME/usage/prices.json`
 * ({"<model id or prefix>": {"input": $/Mtok, "output": …, "cacheRead": …, "cacheWrite": …}}).
 * A model without a price still counts its tokens and shows as unpriced.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface UsageRow {
  id: string;
  ts: string;
  source: "claude" | "codex";
  model: string;
  project: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const usageHome = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.MOLA_HOME || path.join(os.homedir(), ".mola"), "usage");
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function* walk(dir: string, depth = 0): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 6) yield* walk(p, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}

function lines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

export function scanClaude(root: string, since: number): UsageRow[] {
  const out = new Map<string, UsageRow>();
  for (const file of walk(path.join(root, "projects"))) {
    try {
      if (fs.statSync(file).mtimeMs < since) continue;
    } catch {
      continue;
    }
    for (const l of lines(file)) {
      if (!l.includes('"usage"')) continue;
      let d: { type?: string; timestamp?: string; cwd?: string; requestId?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> } };
      try {
        d = JSON.parse(l);
      } catch {
        continue;
      }
      const u = d.message?.usage;
      if (d.type !== "assistant" || !u || !d.timestamp || d.message?.model === "<synthetic>") continue;
      const id = `claude:${d.message?.id ?? ""}:${d.requestId ?? ""}`;
      if (Date.parse(d.timestamp) < since) continue;
      out.set(id, {
        id,
        ts: d.timestamp,
        source: "claude",
        model: d.message?.model ?? "unknown",
        project: d.cwd ?? path.basename(path.dirname(file)),
        input: n(u.input_tokens),
        output: n(u.output_tokens),
        cacheRead: n(u.cache_read_input_tokens),
        cacheWrite: n(u.cache_creation_input_tokens),
      });
    }
  }
  return [...out.values()];
}

export function scanCodex(root: string, since: number): UsageRow[] {
  const out: UsageRow[] = [];
  for (const file of walk(path.join(root, "sessions"))) {
    try {
      if (fs.statSync(file).mtimeMs < since) continue;
    } catch {
      continue;
    }
    let model = "unknown";
    let project = "";
    let i = 0;
    for (const l of lines(file)) {
      i++;
      if (!l.trim()) continue;
      let d: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
      try {
        d = JSON.parse(l);
      } catch {
        continue;
      }
      const p = d.payload ?? {};
      if (d.type === "turn_context" || d.type === "session_meta") {
        if (typeof p.model === "string") model = p.model;
        if (typeof p.cwd === "string") project = p.cwd;
        continue;
      }
      if (d.type !== "event_msg" || p.type !== "token_count" || !d.timestamp) continue;
      const last = (p.info as { last_token_usage?: Record<string, unknown> } | undefined)?.last_token_usage;
      if (!last || Date.parse(d.timestamp) < since) continue;
      const cached = n(last.cached_input_tokens);
      out.push({
        id: `codex:${path.basename(file)}:${i}`,
        ts: d.timestamp,
        source: "codex",
        model,
        project: project || path.basename(file),
        // codex counts cached tokens inside input_tokens
        input: Math.max(0, n(last.input_tokens) - cached),
        output: n(last.output_tokens) + n(last.reasoning_output_tokens),
        cacheRead: cached,
        cacheWrite: 0,
      });
    }
  }
  return out;
}

export function readLedger(env?: NodeJS.ProcessEnv): UsageRow[] {
  return lines(path.join(usageHome(env), "ledger.jsonl")).flatMap((l) => {
    if (!l.trim()) return [];
    try {
      return [JSON.parse(l) as UsageRow];
    } catch {
      return [];
    }
  });
}

/** Add new rows to the ledger and prune past the retention. Returns how many rows were added. */
export function updateLedger(rows: UsageRow[], retentionDays: number | "unlimited", now: number, env?: NodeJS.ProcessEnv): { added: number; total: number } {
  const file = path.join(usageHome(env), "ledger.jsonl");
  const old = readLedger(env);
  const seen = new Set(old.map((r) => r.id));
  const fresh = rows.filter((r) => !seen.has(r.id));
  let all = [...old, ...fresh];
  if (retentionDays !== "unlimited") all = all.filter((r) => now - Date.parse(r.ts) <= retentionDays * 86400000);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join("\n") + (all.length ? "\n" : ""), "utf8");
  fs.renameSync(tmp, file);
  return { added: fresh.length, total: all.length };
}

export function readPrices(env?: NodeJS.ProcessEnv): Record<string, Price> {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(usageHome(env), "prices.json"), "utf8")) as Record<string, Price>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Exact model id first, then the longest matching prefix. */
export function priceOf(model: string, prices: Record<string, Price>): Price | undefined {
  if (prices[model]) return prices[model];
  const key = Object.keys(prices)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? prices[key] : undefined;
}

export function costOf(r: Pick<UsageRow, "input" | "output" | "cacheRead" | "cacheWrite">, p: Price): number {
  return (r.input * p.input + r.output * p.output + r.cacheRead * (p.cacheRead ?? p.input) + r.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6;
}

export interface Bucket {
  key: string;
  rows: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** share of prompt tokens served from cache */
  cacheHit: number;
  cost: number;
  unpriced: number;
}

export type GroupBy = "model" | "day" | "project" | "source";

export function aggregate(rows: UsageRow[], by: GroupBy, prices: Record<string, Price>): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const r of rows) {
    const key = by === "day" ? r.ts.slice(0, 10) : by === "project" ? r.project : by === "source" ? r.source : r.model;
    const b = m.get(key) ?? { key, rows: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHit: 0, cost: 0, unpriced: 0 };
    b.rows++;
    b.input += r.input;
    b.output += r.output;
    b.cacheRead += r.cacheRead;
    b.cacheWrite += r.cacheWrite;
    const p = priceOf(r.model, prices);
    if (p) b.cost += costOf(r, p);
    else b.unpriced++;
    m.set(key, b);
  }
  for (const b of m.values()) {
    const prompt = b.input + b.cacheRead + b.cacheWrite;
    b.cacheHit = prompt ? b.cacheRead / prompt : 0;
  }
  return [...m.values()].sort((a, b) => (by === "day" ? b.key.localeCompare(a.key) : b.cost - a.cost || b.output - a.output));
}

export const fmtTok = (v: number): string => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));
