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

export interface RoleGroupGap {
  role: string;
  group: string;
  /** the task kinds that name this role */
  kinds: string[];
  /** where those kinds go instead: the second pick of the first of them, if it has one */
  fallback?: string;
}

/**
 * The role groups (`roles.<name>.group`) that magpie does not list. A kind whose first pick is a missing group is
 * served by the next pick only after one request fails with an unknown model, so the gap is worth reporting up front.
 * `known` is the route ids `magpie models` printed.
 */
export function roleGroupGaps(table: RankTable, known: readonly string[]): RoleGroupGap[] {
  const have = new Set(known);
  const gaps: RoleGroupGap[] = [];
  for (const [role, row] of Object.entries(table.roles ?? {})) {
    if (have.has(row.group)) continue;
    const kinds = Object.entries(table.tasks).filter(([, t]) => t.role === role).map(([k]) => k);
    const first = kinds.length ? table.tasks[kinds[0]!]!.picks : [];
    gaps.push({ role, group: row.group, kinds, ...(first[1] ? { fallback: first[1] } : {}) });
  }
  return gaps;
}
