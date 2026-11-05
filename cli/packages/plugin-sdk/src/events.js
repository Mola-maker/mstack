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
};
