/**
 * cmd-ultramode (unit 1: skeleton). The mode from cli/design/ultramode.md:
 * one goal in, routing, review, interrogation, and shipping out, with
 * CLI-enforced gates and a recorded shipping grant, never --yes.
 *
 * This unit only registers the command and reports status. The run loop
 * lands in unit 2, the gates in unit 3, shipping in unit 4, and the RSI
 * search and interrogation loop in unit 5. A goal argument before then is
 * refused outright instead of pretending to run.
 */

import type { PluginContext } from "@mola/plugin-sdk";
import { definePlugin, MolaError, ExitCode } from "@mola/plugin-sdk";

const MODE_VERSION = "0.1.0";

const STATUS_USAGE = 'usage: mola ultramode ["<goal>"] [--json]';

export const ULTRAMODE_STAGES = [
  "route",
  "review",
  "interrogate",
  "ship",
] as const;

export function statusData(ctx: PluginContext): Record<string, unknown> {
  const activeGoal = ctx.state.get<string>("activeGoal");
  return {
    mode: "ultramode",
    version: MODE_VERSION,
    stages: [...ULTRAMODE_STAGES],
    activeGoal: activeGoal ?? null,
    shippingNeedsGrant: true,
    grantSource: "ultramode grant, recorded in the mode state (never --yes)",
  };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["ultramode"],
      description: "the long-run mode: route, review, interrogate, ship (gates + grant)",
      async handler(args, io) {
        const goal = args.positionals.join(" ").trim();
        if (goal) {
          throw new MolaError(
            "UNSUPPORTED_CAPABILITY",
            "ultramode run loop not ready: this build only registers the command and reports status (the loop lands in unit 2)",
            ExitCode.Unavailable,
            { goal },
          );
        }
        const data = statusData(ctx);
        io.data(data);
        if (!io.json) {
          io.out(`mola ultramode ${MODE_VERSION} — stages: ${ULTRAMODE_STAGES.join(" → ")}`);
          io.out("no goal active");
          io.out("shipping needs a recorded ultramode grant (never --yes)");
          io.out(STATUS_USAGE);
        }
        return ExitCode.Ok;
      },
    });
  },
});
