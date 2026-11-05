/**
 * Exit-code contract (core-plugins §8.3, aligned with sysexits.h) and the error
 * registry agents consume. `code` is the stable machine-readable token; `message`
 * is for humans. Defined in the SDK so plugins can throw typed errors without
 * importing the host; @mola/core re-exports them.
 */
export declare const ExitCode: {
    readonly Ok: 0;
    readonly Error: 1;
    /** EX_USAGE — bad args, unknown command, flag conflict */
    readonly Usage: 64;
    /** EX_DATAERR — invalid input data: bad manifest, bad config, unparseable --json input */
    readonly DataErr: 65;
    /** EX_NOINPUT — required config/credential/file/agent missing */
    readonly NoInput: 66;
    /** EX_UNAVAILABLE — upstream unavailable: gateway down, sidecar handshake failed, peer offline */
    readonly Unavailable: 69;
    /** EX_SOFTWARE — internal error / plugin crash / boot failure */
    readonly Software: 70;
    /** EX_NOPERM — policy denied or approval required; permission violation */
    readonly NoPerm: 77;
};
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
/** The small registry of machine-readable error codes (core §8.2). */
export type MolaErrorCode = "USAGE_ERROR" | "COMMAND_NOT_FOUND" | "MANIFEST_INVALID" | "CONFIG_INVALID" | "CONFIG_KEY_NOT_FOUND" | "COMMAND_CONFLICT" | "NO_INPUT" | "AGENT_NOT_FOUND" | "PLUGIN_NOT_FOUND" | "UPSTREAM_UNAVAILABLE" | "INTERNAL_ERROR" | "PLUGIN_CRASHED" | "PLUGIN_QUARANTINED" | "POLICY_DENIED" | "PERMISSION_DENIED" | "ROUTE_BANNED" | "SECRET_REFUSED";
export declare class MolaError extends Error {
    readonly code: MolaErrorCode;
    readonly exitCode: ExitCode;
    readonly details?: unknown;
    constructor(code: MolaErrorCode, message: string, exitCode: ExitCode, details?: unknown);
}
/**
 * Waterfall rejection (core §3, §11 conflict 12): a gate listener throws this to
 * deny. The router maps it to exit 77. `--yes` / `MOLA_YES=1` may skip when the
 * policy allows.
 */
export declare class PolicyDenial extends MolaError {
    constructor(message: string, details?: unknown);
}
/** Runtime permission-handle denial (ctx.process/ctx.fs/ctx.config/…); exit 77. */
export declare class PermissionError extends MolaError {
    constructor(message: string, details?: unknown);
}
/** Best-effort normalization of an unknown thrown value. */
export declare function toMolaError(err: unknown, fallbackExit?: ExitCode): {
    code: MolaErrorCode;
    message: string;
    exitCode: ExitCode;
    details?: unknown;
};
