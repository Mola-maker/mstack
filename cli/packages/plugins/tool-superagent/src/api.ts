/**
 * The dsh-superagent Management API client (B2f).
 *
 * Two dsh-superagent bots run in WSL (layerfs :3082, cad2gis :3083); their
 * Management API is reachable from Windows at 127.0.0.1. Ground truth:
 * cli/design/inputs/superagent-ops.md — EVERY request needs the header
 * `x-orchestrator-request: 1` and the host must be 127.0.0.1:<port>. The
 * response shapes are the real samples superagent-api-state.sample.json /
 * superagent-api-sources.sample.json; unknown fields are carried, never
 * invented.
 *
 * Endpoints used (nothing beyond the captured surface):
 *   GET  /orchestrator/api/state             setup problem, health, load, paused
 *   GET  /orchestrator/api/sources           per-Source state, stats, dropped
 *   POST /orchestrator/api/executor/pause    body {"paused":true|false}
 *   POST /orchestrator/api/tickets/<id>/retry
 *   POST /orchestrator/api/tickets/<id>/stop
 *
 * The fetch implementation is injectable so tests never touch the network.
 * Every failure maps to MolaError("UPSTREAM_UNAVAILABLE", exit 69): the bot
 * being down or answering garbage is an upstream problem, not a usage error.
 */

import { MolaError, ExitCode } from "@mola/plugin-sdk";

/** One `health.<part>` row of the state response. */
export interface SuperagentHealthPart {
  name: string;
  state?: string;
  detail?: string;
  code?: string;
  at?: string;
}

/** `setup.problem` — an operator step that is still missing. */
export interface SuperagentProblem {
  place?: string;
  code?: string;
  values?: Record<string, unknown>;
  detail?: string;
}

/** The `/state` document (superagent-api-state.sample.json). */
export interface SuperagentState {
  setup?: {
    machine?: Record<string, unknown>;
    problem?: SuperagentProblem | null;
    feishuProblem?: unknown;
    accounts?: unknown;
  } | null;
  load?: { running?: number; queued?: number; maxWorkers?: number };
  masterId?: string;
  paused?: boolean;
  health?: Record<string, SuperagentHealthPart>;
}

/** One Source of the `/sources` response (superagent-api-sources.sample.json). */
export interface SuperagentSource {
  id: string;
  title?: { zh?: string; en?: string };
  installed?: boolean;
  enabled?: boolean;
  state?: string;
  health?: SuperagentHealthPart[];
  problem?: SuperagentProblem | null;
  stats?: { received?: number; filtered?: number; lastAt?: string };
  filtered?: unknown[];
  dropped?: unknown[];
  [key: string]: unknown;
}

/** Minimal subset of `fetch` this client needs (easy to fake in tests). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const ORCHESTRATOR_HEADER = "x-orchestrator-request";
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface SuperagentClientOptions {
  /** instance base URL, e.g. http://127.0.0.1:3082 (no trailing path) */
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class SuperagentApi {
  readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: SuperagentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async state(): Promise<SuperagentState> {
    return this.request<SuperagentState>("GET", "/state");
  }

  async sources(): Promise<SuperagentSource[]> {
    return this.request<SuperagentSource[]>("GET", "/sources");
  }

  /** POST /executor/pause — `{"paused":true}` pauses, false resumes. */
  async setPaused(paused: boolean): Promise<void> {
    await this.request("POST", "/executor/pause", { paused });
  }

  async retryTicket(ticketId: string): Promise<void> {
    await this.request("POST", `/tickets/${encodeURIComponent(ticketId)}/retry`);
  }

  async stopTicket(ticketId: string): Promise<void> {
    await this.request("POST", `/tickets/${encodeURIComponent(ticketId)}/stop`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/orchestrator/api${path}`;
    const init: Parameters<FetchLike>[1] = {
      method,
      headers: { [ORCHESTRATOR_HEADER]: "1" },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...init.headers, "content-type": "application/json" };
    }
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.doFetch(url, init);
    } catch (err) {
      throw new MolaError(
        "UPSTREAM_UNAVAILABLE",
        `superagent at ${this.baseUrl} is not reachable: ${err instanceof Error ? err.message : String(err)}`,
        ExitCode.Unavailable,
        { url },
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new MolaError(
        "UPSTREAM_UNAVAILABLE",
        `superagent at ${this.baseUrl}: ${method} ${path} failed with HTTP ${res.status}` +
          (text ? `: ${truncate(text, 200)}` : ""),
        ExitCode.Unavailable,
        { url, status: res.status },
      );
    }
    try {
      return text.length === 0 ? (undefined as T) : (JSON.parse(text) as T);
    } catch {
      throw new MolaError(
        "UPSTREAM_UNAVAILABLE",
        `superagent at ${this.baseUrl}: ${method} ${path} did not return JSON: ${truncate(text, 200)}`,
        ExitCode.Unavailable,
        { url },
      );
    }
  }
}

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
