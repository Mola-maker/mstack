/**
 * cmd-doctor (B1): `mola doctor` — the machine-readable health report and its
 * human form (core §2.6: this is the B1 acceptance command).
 *
 * This plugin ships the *framework* plus its own checks (node>=22,
 * plugins.plan-ok). Other plugins register more checks through the SDK —
 * `ctx.doctor.registerCheck()` — e.g. step 2 adds magpie.healthcheck
 * (tool-magpie), agent.dsh (agent-dsh), tool.rtk (tool-rtk), tool.git (tool-git).
 * `mola doctor` exits 0 only if all checks pass; a failing check maps to its
 * own sysexits code (core §8.3).
 */

import type { CheckResult, DoctorCheck, PluginContext } from "@mola/plugin-sdk";
import { definePlugin, detectColor, ExitCode, palette, statusGlyph } from "@mola/plugin-sdk";

function nodeCheck(): DoctorCheck {
  return {
    id: "node>=22",
    description: "Node.js runtime is >= 22",
    run(): CheckResult {
      const major = Number(process.version.slice(1).split(".")[0]);
      return major >= 22
        ? { ok: true, message: `node ${process.version}` }
        : { ok: false, message: `node ${process.version} — install Node >= 22`, exitCode: ExitCode.Unavailable };
    },
  };
}

function planOkCheck(ctx: PluginContext): DoctorCheck {
  return {
    id: "plugins.plan-ok",
    description: "plugin resolve→plan is clean and nothing is quarantined",
    run(): CheckResult {
      const plan = ctx.plugins.plan();
      if (plan.ok && plan.quarantined.length === 0) {
        return { ok: true, message: `${plan.order.length} plugins, plan clean` };
      }
      const problems = [...plan.errors];
      if (plan.quarantined.length > 0) {
        problems.push(`quarantined: ${plan.quarantined.join(", ")} (see mola plugin list)`);
      }
      // bad manifest / bad plan → EX_DATAERR per core §8.3
      return { ok: false, message: problems.join("; "), exitCode: ExitCode.DataErr };
    },
  };
}

interface ReportedCheck {
  id: string;
  description?: string;
  ok: boolean;
  message?: string;
  exitCode?: number;
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.doctor.registerCheck(nodeCheck());
    ctx.doctor.registerCheck(planOkCheck(ctx));

    ctx.commands.register({
      path: ["doctor"],
      description: "health: node, plugins, magpie, agents, tools (per-plugin checks)",
      async handler(args, io) {
        if (args.flags.envs) io.note("doctor --envs arrives with environment adapters in B3; skipped");
        if (args.flags.fix) io.note("doctor --fix: no auto-fixes exist in B1; reporting only");

        const checks: ReportedCheck[] = [];
        for (const check of ctx.doctor.list()) {
          let result: CheckResult;
          try {
            result = await check.run();
          } catch (err) {
            // a crashing check is a failing check (EX_SOFTWARE)
            result = {
              ok: false,
              message: `check crashed: ${err instanceof Error ? err.message : String(err)}`,
              exitCode: ExitCode.Software,
            };
          }
          checks.push({
            id: check.id,
            description: check.description,
            ok: result.ok,
            message: result.message,
            exitCode: result.ok ? undefined : (result.exitCode ?? ExitCode.Unavailable),
          });
        }

        if (!io.json) {
          // failures first, each with a glyph; the message is the fix when one exists
          const p = palette(detectColor());
          const ordered = [...checks.filter((c) => !c.ok), ...checks.filter((c) => c.ok)];
          for (const c of ordered) {
            const glyph = statusGlyph(c.ok ? "ok" : "fail", p);
            io.out(`${glyph}  ${c.id}${c.message ? `  ${c.message}` : ""}`);
          }
        }
        io.data({
          checks,
          summary: { total: checks.length, failed: checks.filter((c) => !c.ok).length },
        });

        const failing = checks.find((c) => !c.ok);
        return (failing?.exitCode ?? ExitCode.Ok) as ExitCode;
      },
    });
  },
});
