/**
 * Event/hook bus (core §3, ADR-0004). Three delivery semantics:
 *
 * - broadcast (`emit`/`on`): facts; a throwing handler is logged and isolated,
 *   never breaks the producer (DESIGN §11 conflict 12).
 * - waterfall (`hook`/`runWaterfall`): policy gates (`mola.tool.before`,
 *   `mola.task.pre-dispatch`); each listener may rewrite the value or reject
 *   with PolicyDenial (router maps rejection to exit 77).
 * - serial (`onSerial`/`runSerial`): ordered observers (boot/shutdown).
 *
 * Death-loop brake (core §3, the mstack guard rule): the same listener throwing
 * / the same waterfall rejecting 3 consecutive times for the same event+plugin
 * quarantines the plugin. No fourth attempt.
 */

import { randomUUID } from "node:crypto";
import type {
  Disposer,
  EventBus,
  EventEnvelope,
  Listener,
  Logger,
  WaterfallFn,
} from "@mola/plugin-sdk";

export interface BusOptions {
  log: Logger;
  traceId: string;
  /** death-loop brake hook: quarantine the owning plugin */
  onQuarantine?: (owner: string, event: string, error: unknown) => void;
}

type Kind = "broadcast" | "waterfall" | "serial";

interface Entry {
  kind: Kind;
  event: string;
  owner: string;
  fn: Listener | WaterfallFn;
}

const BRAKE_LIMIT = 3;

export class CoreEventBus implements EventBus {
  private entries: Entry[] = [];
  private failures = new Map<string, number>();

  constructor(private readonly opts: BusOptions) {}

  private add(kind: Kind, event: string, fn: Listener | WaterfallFn, owner: string): Disposer {
    const entry: Entry = { kind, event, owner, fn };
    this.entries.push(entry);
    return () => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    };
  }

  /** Owner-scoped registration — plugin contexts tag every listener. */
  on(event: string, fn: Listener, owner = "core"): Disposer {
    return this.add("broadcast", event, fn, owner);
  }

  hook(event: string, fn: WaterfallFn, owner = "core"): Disposer {
    return this.add("waterfall", event, fn, owner);
  }

  onSerial(event: string, fn: Listener, owner = "core"): Disposer {
    return this.add("serial", event, fn, owner);
  }

  emit(event: string, payload: unknown, source?: EventEnvelope["source"]): void {
    const envelope: EventEnvelope = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      kind: event,
      source: { runId: this.opts.traceId, ...(source ?? {}) },
      data: payload,
    };
    for (const e of this.entries.filter((x) => x.kind === "broadcast" && x.event === event)) {
      try {
        const r = (e.fn as Listener)(envelope);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((err) => this.noteFailure(e, err));
        }
        this.noteSuccess(e);
      } catch (err) {
        this.noteFailure(e, err);
      }
    }
  }

  async runWaterfall<T>(event: string, value: T): Promise<T> {
    let current: unknown = value;
    for (const e of this.entries.filter((x) => x.kind === "waterfall" && x.event === event)) {
      try {
        current = await (e.fn as WaterfallFn)(current);
        this.noteSuccess(e);
      } catch (err) {
        this.noteFailure(e, err);
        throw err; // rejection IS the denial path (§11 conflict 12)
      }
    }
    return current as T;
  }

  async runSerial(event: string, payload: unknown): Promise<void> {
    const envelope: EventEnvelope = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      kind: event,
      source: { runId: this.opts.traceId },
      data: payload,
    };
    for (const e of this.entries.filter((x) => x.kind === "serial" && x.event === event)) {
      try {
        await (e.fn as Listener)(envelope);
        this.noteSuccess(e);
      } catch (err) {
        // serial observers are ordered but still isolated: shutdown must proceed
        this.noteFailure(e, err);
      }
    }
  }

  /** Listener inventory — the data behind `mola hooks list` (B2). */
  describe(): Array<{ event: string; kind: Kind; owner: string }> {
    return this.entries.map(({ event, kind, owner }) => ({ event, kind, owner }));
  }

  private key(e: Entry): string {
    return `${e.kind}:${e.event}:${e.owner}`;
  }

  private noteSuccess(e: Entry): void {
    this.failures.delete(this.key(e));
  }

  private noteFailure(e: Entry, err: unknown): void {
    const key = this.key(e);
    const count = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, count);
    this.opts.log.warn("bus listener failed", {
      event: e.event,
      kind: e.kind,
      owner: e.owner,
      consecutive: count,
      error: err instanceof Error ? err.message : String(err),
    });
    if (count >= BRAKE_LIMIT) {
      this.failures.delete(key);
      this.opts.log.error("death-loop brake: quarantining plugin", { owner: e.owner, event: e.event });
      this.opts.onQuarantine?.(e.owner, e.event, err);
    }
  }
}
