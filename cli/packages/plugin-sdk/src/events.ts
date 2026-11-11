/**
 * Canonical event vocabulary — ADR-0004 `mola.<domain>.<verb>` is the single
 * canonical set (DESIGN §11 conflict 1). Bus, bridges and the sync backend all
 * speak these names.
 */

export const MolaEvents = {
  // core lifecycle (serial)
  CoreBoot: "mola.core.boot",
  CoreShutdown: "mola.core.shutdown",
  // router (broadcast)
  CommandStarted: "mola.command.started",
  CommandEnded: "mola.command.ended",
  // loader (broadcast)
  PluginActivated: "mola.plugin.activated",
  PluginQuarantined: "mola.plugin.quarantined",
  // config (broadcast)
  ConfigChanged: "mola.config.changed",
  // policy gates (waterfall)
  ToolBefore: "mola.tool.before",
  TaskPreDispatch: "mola.task.pre-dispatch",
  // ultramode gates (waterfall; design §5-6, unit 3): the mode registers both
  // in activate(); no other plugin listens to them yet
  UltramodeReview: "mola.ultramode.review",
  UltramodeShip: "mola.ultramode.ship",
  // facts (broadcast)
  ToolAfter: "mola.tool.after",
  SessionStarted: "mola.session.started",
  SessionEnded: "mola.session.ended",
  TurnCompleted: "mola.turn.completed",
  AgentMessage: "mola.agent.message",
  AgentIdle: "mola.agent.idle",
  PermissionRequested: "mola.permission.requested",
  ErrorRaised: "mola.error.raised",
  TaskDone: "mola.task.done",
  ApprovalGranted: "mola.approval.granted",
  ApprovalDenied: "mola.approval.denied",
  CostReported: "mola.cost.reported",
  SidecarCrash: "mola.sidecar.crash",
  SidecarRespawned: "mola.sidecar.respawned",
} as const;

export type MolaEventName = (typeof MolaEvents)[keyof typeof MolaEvents];

/** Event envelope (ADR-0004 §1). */
export interface EventEnvelope<T = unknown> {
  id: string;
  ts: string;
  kind: string;
  source: {
    agent?: string;
    machine?: string;
    sessionId?: string;
    runId?: string;
    plugin?: string;
  };
  data: T;
  raw?: unknown;
}

export type Listener = (event: EventEnvelope) => void | Promise<void>;
export type WaterfallFn<T = unknown> = (value: T) => T | Promise<T>;
export type Disposer = () => void;

/**
 * The bus has three delivery semantics (core §3):
 * - broadcast (emit/on): facts; a throwing handler is logged, never breaks the producer.
 * - waterfall (hook/runWaterfall): policy gates; listeners may rewrite or reject.
 * - serial (onSerial/runSerial): ordered observers (boot/shutdown).
 */
export interface EventBus {
  emit(event: string, payload: unknown, source?: EventEnvelope["source"]): void;
  on(event: string, fn: Listener): Disposer;
  hook(event: string, fn: WaterfallFn): Disposer;
  /** Throws PolicyDenial (exit 77) when a gate listener rejects. */
  runWaterfall<T>(event: string, value: T): Promise<T>;
  onSerial(event: string, fn: Listener): Disposer;
  runSerial(event: string, payload: unknown): Promise<void>;
}
