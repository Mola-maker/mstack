/**
 * The run-event stream (core §8.2, BATCHES B2 acceptance).
 *
 * `mola run` is a streaming command: in `--json` mode stdout carries exactly
 * ONE envelope (the routing decision + the outcome) and the run's events go to
 * stderr as NDJSON — "newline-delimited run events", the convention DSH
 * headless already uses (design/inputs/dsh-cli-help.md). The stream therefore
 * holds the run's event vocabulary:
 *
 *   mola.session.started   the routing decision (agent, machine, modelRoute)
 *   mola.agent.message     the agent's messages (adapter tap)
 *   mola.turn.completed    one turn finished (adapter tap)
 *   mola.task.done         the task finished (adapter tap)
 *   mola.error.raised      the run failed (adapter tap)
 *   mola.session.ended     the session closed (adapter tap)
 *
 * The sink is a plain function so a test can capture it instead of writing to
 * the real stderr; the production wiring writes to `process.stderr`.
 *
 * Why the router's own event goes through the sink too: the routing decision
 * IS the run's first event — it names the agent, the machine and the model
 * route, exactly the three fields `.mstack/runs/<runId>/decision.json` must
 * carry (ADR-0003 §3). The bus emission is what rec-runs records; the sink
 * write is what a human or an agent watching stderr sees.
 */

import { randomUUID } from "node:crypto";
import type { HookEvent } from "@mola/plugin-sdk";

/** The events the run stream carries (the ADR-0004 §1 run vocabulary). */
export const RUN_STREAM_EVENTS: readonly string[] = [
  "mola.session.started",
  "mola.agent.message",
  "mola.agent.idle",
  "mola.turn.completed",
  "mola.task.done",
  "mola.error.raised",
  "mola.session.ended",
];

/** A sink that accepts one event envelope. */
export type EventSink = (event: HookEvent) => void;

/**
 * Build a well-formed event envelope (ADR-0004 §1). `id`/`ts` are minted here
 * so every producer's envelope has the same shape.
 */
export function makeEnvelope(opts: {
  kind: string;
  agent: string;
  machine: string;
  runId: string;
  data: Record<string, unknown>;
  sessionId?: string;
}): HookEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    kind: opts.kind,
    source: {
      agent: opts.agent,
      machine: opts.machine,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      runId: opts.runId,
    },
    data: opts.data,
  };
}

/**
 * The stderr NDJSON sink. `write` defaults to stderr; a test passes its own
 * collector. A line that cannot be serialized must not kill the run — it is
 * skipped and the fact is reported through the `onError` callback.
 */
export function ndjsonSink(opts: {
  write?: (line: string) => void;
  onError?: (err: unknown) => void;
} = {}): EventSink {
  const write = opts.write ?? ((line: string) => process.stderr.write(line));
  return (event: HookEvent) => {
    let line: string;
    try {
      line = JSON.stringify(event);
    } catch (err) {
      opts.onError?.(err);
      return;
    }
    write(line + "\n");
  };
}

/**
 * A sink that keeps the last N envelopes in memory — used by the tests and by
 * the `--json` envelope (the run's event kinds are reported there, so a
 * consumer can assert the run produced the ADR-0004 vocabulary).
 */
export function recordingSink(limit = 256): EventSink & { events: HookEvent[] } {
  const events: HookEvent[] = [];
  const sink = ((event: HookEvent) => {
    events.push(event);
    if (events.length > limit) events.shift();
  }) as EventSink & { events: HookEvent[] };
  sink.events = events;
  return sink;
}

/** The event kinds of a list of envelopes, in order, de-duplicated. */
export function eventKinds(events: HookEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) if (!out.includes(e.kind)) out.push(e.kind);
  return out;
}
