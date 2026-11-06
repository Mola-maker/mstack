/**
 * Reading a `/state` document the way superagent-ops.md prescribes (B2f):
 *
 * - `setup.problem` not null → setup is incomplete; its `code`/`detail` say
 *   what is missing. These are operator steps — report the exact fix hint,
 *   never ask for a secret.
 * - `health.<part>.state == "error"` → a restart will not fix it; report the
 *   part and its detail.
 * - `load.queued > 0` with `running == maxWorkers` → busy, not broken.
 * - `paused` is a deliberate state, reported but never a failure.
 *
 * Exit-code mapping mirrors the WSL `dsh-superagent status` contract
 * (superagent-ops.md): 0 running normally, 2 a part reports an error, 3
 * waiting for setup, 69 (EX_UNAVAILABLE) when the Management API is not
 * reachable. There is no 1 here: "not running" shows up as unreachable.
 */

import type { SuperagentHealthPart, SuperagentProblem, SuperagentState } from "./api.js";
import { setupHint } from "./config.js";

export interface SetupReport {
  ok: boolean;
  problem?: SuperagentProblem;
  /** the exact operator command, from superagent-ops.md */
  fixHint?: string;
}

export interface LoadReport {
  running?: number;
  queued?: number;
  maxWorkers?: number;
  /** queued > 0 with running == maxWorkers — busy, not broken */
  busy: boolean;
}

export interface InstanceReport {
  name: string;
  url: string;
  reachable: true;
  paused: boolean;
  masterId?: string;
  setup: SetupReport;
  load: LoadReport;
  /** every health part, in response order */
  health: SuperagentHealthPart[];
  /** the parts that need attention (state "error") */
  healthProblems: SuperagentHealthPart[];
}

export function interpretState(name: string, url: string, port: number, state: SuperagentState): InstanceReport {
  const problem = state.setup?.problem ?? null;
  const setup: SetupReport = problem
    ? { ok: false, problem, fixHint: setupHint(problem.code, port) }
    : { ok: true };
  const health: SuperagentHealthPart[] = Object.entries(state.health ?? {}).map(([part, h]) => ({
    name: part,
    state: h?.state,
    detail: h?.detail,
    code: h?.code,
    at: h?.at,
  }));
  // "error" is the state a restart will not fix (superagent-ops.md); a part
  // parked with a code while setup pends is setup noise, surfaced via `setup`.
  const healthProblems = health.filter((h) => h.state === "error");
  const running = state.load?.running;
  const queued = state.load?.queued;
  const maxWorkers = state.load?.maxWorkers;
  return {
    name,
    url,
    reachable: true,
    paused: state.paused ?? false,
    masterId: state.masterId,
    setup,
    load: {
      running,
      queued,
      maxWorkers,
      busy: typeof running === "number" && typeof maxWorkers === "number" && running === maxWorkers && (queued ?? 0) > 0,
    },
    health,
    healthProblems,
  };
}

/** A command-wide report: every configured instance, reachable or not. */
export type StatusReport = InstanceReport | UnreachableReport;

export interface UnreachableReport {
  name: string;
  url: string;
  reachable: false;
  error: string;
}

/** Status exit: 69 unreachable → 2 error part → 3 setup pending → 0. */
export function statusExitCode(reports: StatusReport[]): number {
  if (reports.some((r) => !r.reachable)) return 69;
  const up = reports as InstanceReport[];
  if (up.some((r) => r.healthProblems.length > 0)) return 2;
  if (up.some((r) => !r.setup.ok)) return 3;
  return 0;
}
