/**
 * `mola go --dry-run`: the stage plan with the model chosen per stage and the
 * size of each prompt. Routes through the same ladder as a real run but runs
 * no agent and writes nothing.
 */

import type { StageName } from "@mola/plugin-sdk";
import { STAGES } from "@mola/plugin-sdk";
import { adaptPrompt, familyOf } from "@mola/plugin-cmd-run";
import { prepareStage, type GoEnv, type GoOptions, type RunContext } from "./engine.js";
import { buildStagePrompt } from "./prompts.js";
import { STAGE_ARTIFACT, STAGE_KIND, selectStages } from "./stages.js";

export interface DryStage {
  stage: StageName;
  selected: boolean;
  kind: string;
  agent?: string;
  model?: string;
  family?: string | null;
  promptChars?: number;
  /** approval gate before this stage: "plan" (skipped by --auto) or "always" */
  gate?: "plan" | "always";
  error?: string;
}

export async function planDryRun(env: GoEnv, rc: RunContext, opts: GoOptions): Promise<DryStage[]> {
  const selected = selectStages(opts.intent, opts.until);
  const out: DryStage[] = [];
  const done: StageName[] = [];
  let implementModel: string | undefined;
  for (const stage of STAGES) {
    const row: DryStage = { stage, selected: selected.includes(stage), kind: STAGE_KIND[stage] };
    if (!row.selected) {
      out.push(row);
      continue;
    }
    if (stage === "ship") row.gate = "always";
    else if (stage === "implement" && !opts.auto) row.gate = "plan";
    const raw = buildStagePrompt({
      stage,
      intent: opts.intent,
      dir: ".mstack/runs/<run-id>",
      previous: done.map((d) => STAGE_ARTIFACT[d]),
    });
    try {
      const prepared = await prepareStage(env, rc, stage, raw, opts.agent, implementModel);
      const adapted = adaptPrompt(rc.table, prepared.route, raw);
      row.agent = prepared.decision.agent;
      row.model = prepared.route;
      row.family = rc.table ? familyOf(rc.table, prepared.route) : null;
      row.promptChars = adapted.prompt.length;
      if (stage === "implement") implementModel = prepared.route;
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
      row.promptChars = raw.length;
    }
    done.push(stage);
    out.push(row);
  }
  return out;
}

export function renderDryRun(intent: string, rows: DryStage[]): string[] {
  const chosen = rows.filter((r) => r.selected);
  const lines = [
    `mola go --dry-run: ${intent}`,
    `stages: ${chosen.map((r) => r.stage).join(" → ")}${rows.some((r) => !r.selected) ? `   (skipped: ${rows.filter((r) => !r.selected).map((r) => r.stage).join(", ")})` : ""}`,
    "",
  ];
  const cells = chosen.map((r) => [
    r.stage,
    r.kind,
    r.error ? `unroutable: ${r.error}` : `${r.agent ?? "?"} · ${r.model ?? "?"}${r.family ? ` (${r.family})` : ""}`,
    `${r.promptChars ?? 0} chars`,
    r.gate === "always" ? "approval: always" : r.gate === "plan" ? "approval: plan (skip with --auto)" : "",
  ]);
  const widths = [0, 1, 2, 3].map((i) => Math.max(...cells.map((c) => c[i].length)));
  for (const c of cells) {
    lines.push(("  " + [0, 1, 2, 3].map((i) => c[i].padEnd(widths[i])).join("  ") + (c[4] ? `  ${c[4]}` : "")).trimEnd());
  }
  lines.push("", "nothing was run or written.");
  return lines;
}
