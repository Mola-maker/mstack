/**
 * rec-runs (B2, BATCHES B2 / ADR-0004): the run recording plugin.
 *
 *  - a bus listener that writes .mstack/runs/<runId>/events.jsonl and
 *    decision.json for every run — for `mola dispatch` today and for the
 *    `mola run` engine on the same canonical vocabulary (no producer edits);
 *  - `mola runs list|show <traceId>` over the run index it keeps in the
 *    per-plugin KV namespace of the shared state store;
 *  - `mola hooks list` from the core bus listener registry (read-only
 *    describeActiveBus() accessor — PluginContext exposes no bus handle).
 */

import * as path from "node:path";
import type { Plugin, PluginContext } from "@mola/plugin-sdk";
import { definePlugin } from "@mola/plugin-sdk";
import { describeActiveBus } from "@mola/core";
import { RunRecorder, RECORDER_EVENTS } from "./recorder.js";
import { hooksListCommand, runsListCommand, runsShowCommand } from "./commands.js";

export const plugin: Plugin = {
  activate(ctx: PluginContext) {
    const recorder = new RunRecorder({
      state: ctx.state,
      fs: ctx.fs,
      log: ctx.log,
      cwd: process.cwd(),
    });
    for (const event of RECORDER_EVENTS) {
      ctx.events.on(event, (envelope) => recorder.handle(envelope));
    }

    ctx.commands.register(runsListCommand(() => recorder.entries()));
    ctx.commands.register(
      runsShowCommand(
        (traceId) => recorder.get(traceId),
        (file) => {
          try {
            return ctx.fs.readFile(file);
          } catch {
            return undefined; // artifacts are best-effort (run recorded, files pruned)
          }
        },
        (traceId) => path.join(process.cwd(), ".mstack", "runs", traceId),
      ),
    );
    ctx.commands.register(hooksListCommand(() => describeActiveBus()));
  },
};

export default plugin;
