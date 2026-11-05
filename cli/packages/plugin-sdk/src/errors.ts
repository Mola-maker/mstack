/**
 * Exit-code contract (core-plugins §8.3, aligned with sysexits.h) and the error
 * registry agents consume. `code` is the stable machine-readable token; `message`
 * is for humans. Defined in the SDK so plugins can throw typed errors without
 * importing the host; @mola/core re-exports them.
 */

export const ExitCode = {
  Ok: 0,
  Error: 1,
  /** EX_USAGE — bad args, unknown command, flag conflict */
  Usage: 64,
  /** EX_DATAERR — invalid input data: bad manifest, bad config, unparseable --json input */
  DataErr: 65,
  /** EX_NOINPUT — required config/credential/file/agent missing */
  NoInput: 66,
  /** EX_UNAVAILABLE — upstream unavailable: gateway down, sidecar handshake failed, peer offline */
  Unavailable: 69,
  /** EX_SOFTWARE — internal error / plugin crash / boot failure */
  Software: 70,
  /** EX_NOPERM — policy denied or approval required; permission violation */
  NoPerm: 77,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** The small registry of machine-readable error codes (core §8.2). */
export type MolaErrorCode =
  | "USAGE_ERROR"
  | "COMMAND_NOT_FOUND"
  | "MANIFEST_INVALID"
  | "CONFIG_INVALID"
  | "CONFIG_KEY_NOT_FOUND"
  | "COMMAND_CONFLICT"
  | "NO_INPUT"
  | "AGENT_NOT_FOUND"
  | "UNSUPPORTED_CAPABILITY"
  | "PLUGIN_NOT_FOUND"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "PLUGIN_CRASHED"
  | "PLUGIN_QUARANTINED"
  | "POLICY_DENIED"
  | "PERMISSION_DENIED"
  | "ROUTE_BANNED"
  | "SECRET_REFUSED";

export class MolaError extends Error {
  readonly code: MolaErrorCode;
  readonly exitCode: ExitCode;
  readonly details?: unknown;

  constructor(code: MolaErrorCode, message: string, exitCode: ExitCode, details?: unknown) {
    super(message);
    this.name = "MolaError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

/**
 * Waterfall rejection (core §3, §11 conflict 12): a gate listener throws this to
 * deny. The router maps it to exit 77. `--yes` / `MOLA_YES=1` may skip when the
 * policy allows.
 */
export class PolicyDenial extends MolaError {
  constructor(message: string, details?: unknown) {
    super("POLICY_DENIED", message, ExitCode.NoPerm, details);
    this.name = "PolicyDenial";
  }
}

/** Runtime permission-handle denial (ctx.process/ctx.fs/ctx.config/…); exit 77. */
export class PermissionError extends MolaError {
  constructor(message: string, details?: unknown) {
    super("PERMISSION_DENIED", message, ExitCode.NoPerm, details);
    this.name = "PermissionError";
  }
}

/** Best-effort normalization of an unknown thrown value. */
export function toMolaError(err: unknown, fallbackExit: ExitCode = ExitCode.Software): {
  code: MolaErrorCode;
  message: string;
  exitCode: ExitCode;
  details?: unknown;
} {
  if (err instanceof MolaError) {
    return { code: err.code, message: err.message, exitCode: err.exitCode, details: err.details };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "INTERNAL_ERROR", message, exitCode: fallbackExit };
}
