/**
 * Reader for `config/model-routing.json` (FRAMEWORK §12.3), used by
 * `mola models rank`. The loader lives in @mola/plugin-sdk (routing.ts) and is
 * shared with cmd-run, so the two cannot drift.
 */

import { loadRoutingFile, routingFilePath, type RoutingLoadOptions, type RoutingTable } from "@mola/plugin-sdk";

export type RankTable = RoutingTable;

/** The task table, or a reason string when it cannot be read. */
export function loadRankTable(opts: RoutingLoadOptions = {}): RankTable | string {
  const { table, warning } = loadRoutingFile(opts);
  return table ?? warning ?? "cannot load the routing file";
}

export { routingFilePath };
