/**
 * Canonical event vocabulary — ADR-0004 `mola.<domain>.<verb>` is the single
 * canonical set (DESIGN §11 conflict 1). Bus, bridges and the sync backend all
 * speak these names.
 */
export declare const MolaEvents: {
    readonly CoreBoot: "mola.core.boot";
    readonly CoreShutdown: "mola.core.shutdown";
    readonly CommandStarted: "mola.command.started";
    readonly CommandEnded: "mola.command.ended";
    readonly PluginActivated: "mola.plugin.activated";
    readonly PluginQuarantined: "mola.plugin.quarantined";
    readonly ConfigChanged: "mola.config.changed";
    readonly ToolBefore: "mola.tool.before";
    readonly TaskPreDispatch: "mola.task.pre-dispatch";
    readonly ToolAfter: "mola.tool.after";
    readonly SessionStarted: "mola.session.started";
    readonly SessionEnded: "mola.session.ended";
    readonly TurnCompleted: "mola.turn.completed";
    readonly AgentMessage: "mola.agent.message";
    readonly AgentIdle: "mola.agent.idle";
    readonly PermissionRequested: "mola.permission.requested";
    readonly ErrorRaised: "mola.error.raised";
    readonly TaskDone: "mola.task.done";
    readonly ApprovalGranted: "mola.approval.granted";
    readonly ApprovalDenied: "mola.approval.denied";
    readonly CostReported: "mola.cost.reported";
    readonly SidecarCrash: "mola.sidecar.crash";
    readonly SidecarRespawned: "mola.sidecar.respawned";
};
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
