/**
 * cmd-worktree:
 *   mola worktree new <name> [--base <ref>] [--keep-on-failure]   agent/<name>, then .mstack/worktree.json setup
 *   mola worktree gc [--days 14] [--yes]                          dry run without --yes
 */

import type { PluginContext } from "@mola/plugin-sdk";
import { ExitCode, MolaError, definePlugin } from "@mola/plugin-sdk";
import { applyGc, fmtBytes, newWorktree, planGc } from "./worktree.js";

export * from "./worktree.js";

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["worktree", "new"],
      description: "an agent/<name> worktree, set up with .mstack/worktree.json (rolled back if setup fails)",
      async handler(args, io) {
        const name = args.positionals[0];
        if (!name) throw new MolaError("USAGE_ERROR", "usage: mola worktree new <name> [--base <ref>] [--keep-on-failure]", ExitCode.Usage);
        let res;
        try {
          res = newWorktree(io.cwd, name, { ...(typeof args.flags.base === "string" ? { base: args.flags.base } : {}), keepOnFailure: args.flags["keep-on-failure"] === true });
        } catch (err) {
          throw new MolaError("USAGE_ERROR", err instanceof Error ? err.message : String(err), ExitCode.Usage);
        }
        io.data(res);
        if (res.setup && !res.setup.ok) {
          io.out(`setup failed (exit ${res.setup.code})${args.flags["keep-on-failure"] === true ? `; kept ${res.path}` : "; the worktree was rolled back"}:\n${res.setup.output}`);
          return ExitCode.Error;
        }
        io.out(`${res.path} on ${res.branch}${res.setup ? " (setup ok)" : ""}`);
        return ExitCode.Ok;
      },
    });
    ctx.commands.register({
      path: ["worktree", "gc"],
      description: "remove merged or inactive agent/* worktrees; keeps dirty, locked and busy ones (--yes applies)",
      async handler(args, io) {
        const days = args.flags.days === undefined ? undefined : Number(args.flags.days);
        if (days !== undefined && !(days >= 0)) throw new MolaError("USAGE_ERROR", "--days is a number ≥ 0", ExitCode.Usage);
        let plan;
        try {
          plan = planGc(io.cwd, days === undefined ? {} : { inactiveDays: days });
        } catch (err) {
          throw new MolaError("USAGE_ERROR", err instanceof Error ? err.message : String(err), ExitCode.Usage);
        }
        for (const it of plan.items) io.out(`${it.action === "remove" ? "remove" : "keep  "} ${it.path} (${it.branch}): ${it.reason}`);
        for (const o of plan.orphans) io.out(`not git's ${o.path} (${fmtBytes(o.bytes)}): left alone; delete it yourself if you want`);
        if (plan.items.length === 0) io.out("no agent/* worktrees");
        if (!(io.yes || args.flags.yes === true)) {
          io.data({ ...plan, applied: false });
          if (plan.items.some((i) => i.action === "remove")) io.out("dry run. Re-run with --yes to remove.");
          return ExitCode.Ok;
        }
        const res = applyGc(io.cwd, plan.items);
        io.data({ ...plan, applied: true, ...res });
        for (const f of res.failed) io.out(`FAIL ${f.path}: ${f.error}`);
        io.out(`removed ${res.removed.length}`);
        return res.failed.length ? ExitCode.Error : ExitCode.Ok;
      },
    });
  },
});
