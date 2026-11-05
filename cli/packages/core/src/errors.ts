/**
 * Error/exit-code registry (core §8.2/§8.3). The classes live in
 * @mola/plugin-sdk so plugins can throw them without importing the host;
 * this module re-exports them and owns the code → sysexits mapping.
 */

import { ExitCode, type MolaErrorCode } from "@mola/plugin-sdk";

export { ExitCode, MolaError, PolicyDenial, PermissionError, toMolaError } from "@mola/plugin-sdk";
export type { MolaErrorCode } from "@mola/plugin-sdk";

/** Machine-readable code → sysexits mapping, for consumers and tests. */
export const ERROR_EXIT: Readonly<Record<MolaErrorCode, ExitCode>> = {
  USAGE_ERROR: ExitCode.Usage,
  COMMAND_NOT_FOUND: ExitCode.Usage,
  MANIFEST_INVALID: ExitCode.DataErr,
  CONFIG_INVALID: ExitCode.DataErr,
  CONFIG_KEY_NOT_FOUND: ExitCode.NoInput,
  COMMAND_CONFLICT: ExitCode.DataErr,
  NO_INPUT: ExitCode.NoInput,
  AGENT_NOT_FOUND: ExitCode.NoInput,
  PLUGIN_NOT_FOUND: ExitCode.NoInput,
  UPSTREAM_UNAVAILABLE: ExitCode.Unavailable,
  INTERNAL_ERROR: ExitCode.Software,
  PLUGIN_CRASHED: ExitCode.Software,
  PLUGIN_QUARANTINED: ExitCode.Software,
  POLICY_DENIED: ExitCode.NoPerm,
  PERMISSION_DENIED: ExitCode.NoPerm,
  ROUTE_BANNED: ExitCode.NoPerm,
  SECRET_REFUSED: ExitCode.NoPerm,
};
