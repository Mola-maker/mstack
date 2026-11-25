/**
 * cmd-go (mstack 1.0, FRAMEWORK §13): one sentence in, the whole pipeline out.
 *
 *   mola go "<intent>" [--until <stage>] [--agent claude|dsh] [--auto] [--dry-run] [--json]
 *   mola go status [id] | list | approve|deny <runId> [approvalId] | stop <runId>
 *   mola go --resume <runId>
 *   mola go say|checkpoints|diff|rewind|later <runId> …   (extras.ts)
 *   mola go "<intent>" --key <k>   (same key, same run)
 *   mola statusline [--wrap "<cmd>"]   mola statusline install|uninstall [--yes]
 *   mola notify "<text>" [--title t]
 */

import type { ParsedArgs, PluginContext } from "@mola/plugin-sdk";
import { definePlugin, ExitCode, MolaError } from "@mola/plugin-sdk";
import { planDryRun, renderDryRun } from "./dryrun.js";
import { describeEnd, loadRunContext, resumeRun, startRun, type GoEnv } from "./engine.js";
import { releaseHerdr, reportRunToHerdr } from "@mola/plugin-sdk";
import { cmdDecide, cmdList, cmdStatus, cmdStop } from "./manage.js";
import { sendNotify } from "./notify.js";
import { applyInstall, applyUninstall, fastBase, planInstall, planUninstall, readStdin, renderStatusline, settingsPath } from "./statusline.js";
import { isStageName } from "./stages.js";
import { cmdCheckpoints, cmdDiff, cmdLater, cmdRewind, cmdSay } from "./extras.js";

const GO_USAGE =
  'usage: mola go "<intent>" [--until think|plan|implement|verify|review|ship] [--agent claude|dsh] [--auto] [--dry-run] [--json] | mola go --resume <runId>';

/** `--auto "fix x"` parses as auto="fix x"; give the value back to the intent. */
export function normalizeGoArgs(args: ParsedArgs): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals = [...args.positionals];
  const flags = { ...args.flags };
  for (const f of ["auto", "dry-run"]) {
    const v = flags[f];
    if (typeof v === "string") {
      positionals.unshift(v);
      flags[f] = true;
    }
  }
  return { positionals, flags };
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export default definePlugin({
  activate(ctx: PluginContext) {
    const makeEnv = (io: GoEnv["io"], overrides: Partial<GoEnv> = {}): GoEnv => ({
      ctx,
      io,
      pollMs: 2000,
      stopPollMs: 500,
      detect: true,
      notify: async (text, title) => {
        await sendNotify(ctx, { text, title });
      },
      // a run inside a herdr pane shows its state in herdr's sidebar, and gives the pane back when it ends
      onProgress: (p) => {
        if (p.status === "running" || p.status === "blocked") reportRunToHerdr(p);
        else releaseHerdr();
      },
      ...overrides,
    });

    // ------------------------------------------------------------- mola go
    ctx.commands.register({
      path: ["go"],
      description: "one sentence in, the whole pipeline out (think → plan → implement → verify → review → ship)",
      async handler(args, io) {
        const { positionals, flags } = normalizeGoArgs(args);
        const intent = positionals.join(" ").trim();
        const until = str(flags.until);
        if (until !== undefined && !isStageName(until)) {
          throw new MolaError("USAGE_ERROR", `--until must be one of think|plan|implement|verify|review|ship (got "${until}")`, ExitCode.Usage);
        }
        const agent = str(flags.agent);
        const auto = flags.auto === true;

        if (flags.resume !== undefined) {
          const id = str(flags.resume);
          if (!id) throw new MolaError("USAGE_ERROR", "usage: mola go --resume <runId>", ExitCode.Usage);
          const res = await resumeRun(makeEnv(io), id, { auto, ...(agent ? { agent } : {}) });
          io.data(res.progress);
          if (!io.json) io.out(describeEnd(res.progress));
          return res.code;
        }

        if (!intent) throw new MolaError("USAGE_ERROR", GO_USAGE, ExitCode.Usage);
        const opts = {
          intent,
          ...(until ? { until } : {}),
          ...(agent ? { agent } : {}),
          auto,
          dryRun: flags["dry-run"] === true,
          ...(str(flags.key) ? { key: str(flags.key)! } : {}),
          ...(str(flags.origin) ? { origin: str(flags.origin)! } : {}),
        };

        if (opts.dryRun) {
          const env = makeEnv(io, { detect: false });
          const rows = await planDryRun(env, loadRunContext(env), opts);
          io.data({ intent, dryRun: true, stages: rows });
          if (!io.json) for (const l of renderDryRun(intent, rows)) io.out(l);
          return ExitCode.Ok;
        }

        const res = await startRun(makeEnv(io), opts);
        io.data(res.existing ? { ...res.progress, existing: true } : res.progress);
        if (!io.json) io.out(describeEnd(res.progress));
        return res.code;
      },
    });

    ctx.commands.register({
      path: ["go", "say"],
      description: "queue a note for a run; the next stage reads it",
      async handler(args, io) {
        return cmdSay(io, args.positionals[0], args.positionals.slice(1).join(" "));
      },
    });
    ctx.commands.register({
      path: ["go", "checkpoints"],
      description: "list a run's working-tree checkpoints (hidden git refs)",
      async handler(args, io) {
        return cmdCheckpoints(io, args.positionals[0]);
      },
    });
    ctx.commands.register({
      path: ["go", "diff"],
      description: "a stage's own changes from its checkpoints (default: base → last) [--stat]",
      async handler(args, io) {
        return cmdDiff(io, args.positionals[0], args.positionals[1], args.flags.stat === true);
      },
    });
    ctx.commands.register({
      path: ["go", "rewind"],
      description: "put the working tree back to a run checkpoint (undoable: saves pre-rewind) [--yes]",
      async handler(args, io) {
        return cmdRewind(io, args.positionals[0], args.positionals[1], args.flags.yes === true);
      },
    });
    ctx.commands.register({
      path: ["go", "later"],
      description: "resume a stopped/blocked run at a time (--at +2h | ISO), or --clear; mola serve runs it",
      async handler(args, io) {
        return cmdLater(io, args.positionals[0], str(args.flags.at), args.flags.clear === true);
      },
    });

    ctx.commands.register({
      path: ["go", "status"],
      description: "the newest (or given) go run: progress line + stage table",
      async handler(args, io) {
        return cmdStatus(io, args.positionals[0]);
      },
    });
    ctx.commands.register({
      path: ["go", "list"],
      description: "all go runs in this workspace, newest first",
      async handler(_args, io) {
        return cmdList(io);
      },
    });
    ctx.commands.register({
      path: ["go", "approve"],
      description: "approve a go run's pending approval",
      async handler(args, io) {
        return cmdDecide(io, true, args.positionals[0], args.positionals[1]);
      },
    });
    ctx.commands.register({
      path: ["go", "deny"],
      description: "deny a go run's pending approval (the run stops)",
      async handler(args, io) {
        return cmdDecide(io, false, args.positionals[0], args.positionals[1]);
      },
    });
    ctx.commands.register({
      path: ["go", "stop"],
      description: "ask a running go run to stop (writes the STOP flag)",
      async handler(args, io) {
        return cmdStop(io, args.positionals[0]);
      },
    });

    // ------------------------------------------------------ mola statusline
    ctx.commands.register({
      path: ["statusline"],
      description: "Claude Code statusLine command: one line for the active go run",
      async handler(args, io) {
        try {
          const stdin = await readStdin();
          const wrap = str(args.flags.wrap);
          const out = renderStatusline({ stdin, cwd: io.cwd, color: !process.env.NO_COLOR && !process.env.MOLA_NO_COLOR, ...(wrap ? { wrap } : {}) });
          if (out) process.stdout.write(out + "\n");
        } catch {
          // a statusline never fails the host
        }
        return ExitCode.Ok;
      },
    });
    ctx.commands.register({
      path: ["statusline", "install"],
      description: "show (and with --yes write) the settings.json statusLine that wraps your current one",
      async handler(args, io) {
        const file = str(args.flags.settings) ?? settingsPath();
        const plan = planInstall(file, fastBase());
        const show = (label: string, v: unknown): string => `${label}: ${v === null ? "(none)" : JSON.stringify(v)}`;
        io.out(`settings: ${file}${plan.exists ? "" : " (does not exist yet)"}`);
        io.out(show("before", plan.before));
        io.out(show("after ", plan.after));
        if (plan.already) {
          io.data({ file, before: plan.before, after: plan.after, already: true, written: false });
          io.out("already installed — nothing to change");
          return ExitCode.Ok;
        }
        if (!(io.yes || args.flags.yes === true)) {
          io.data({ file, before: plan.before, after: plan.after, already: false, written: false });
          io.out("not written. Re-run with --yes to apply (the old file is saved as settings.json.bak-mola first).");
          return ExitCode.Ok;
        }
        const { backup } = applyInstall(plan);
        io.data({ file, before: plan.before, after: plan.after, already: false, written: true, ...(backup ? { backup } : {}) });
        io.out(`written${backup ? `; backup: ${backup}` : ""}`);
        return ExitCode.Ok;
      },
    });

    ctx.commands.register({
      path: ["statusline", "uninstall"],
      description: "show (and with --yes write) settings.json with the wrapped statusLine put back",
      async handler(args, io) {
        const file = str(args.flags.settings) ?? settingsPath();
        const plan = planUninstall(file);
        io.out(`settings: ${file}`);
        io.out(`before: ${JSON.stringify(plan.before)}`);
        io.out(`after : ${plan.after === null ? "(no statusLine)" : JSON.stringify(plan.after)}`);
        if (!plan.installed) {
          io.data({ file, installed: false, written: false });
          io.out("not installed — nothing to change");
          return ExitCode.Ok;
        }
        if (!(io.yes || args.flags.yes === true)) {
          io.data({ file, before: plan.before, after: plan.after, written: false });
          io.out("not written. Re-run with --yes to apply (the old file is saved as settings.json.bak-mola first).");
          return ExitCode.Ok;
        }
        const { backup } = applyUninstall(plan);
        io.data({ file, before: plan.before, after: plan.after, written: true, backup });
        io.out(`written; backup: ${backup}`);
        return ExitCode.Ok;
      },
    });

    // ---------------------------------------------------------- mola notify
    ctx.commands.register({
      path: ["notify"],
      description: "tell the human: stderr, plus ntfy / webhook from config notify.*",
      async handler(args, io) {
        const text = args.positionals.join(" ").trim();
        if (!text) throw new MolaError("USAGE_ERROR", 'usage: mola notify "<text>" [--title t]', ExitCode.Usage);
        const title = str(args.flags.title);
        const result = await sendNotify(ctx, { text, ...(title ? { title } : {}) });
        io.data(result);
        return ExitCode.Ok;
      },
    });
  },
});

export { selectStages, isVague, asksToShip } from "./stages.js";
export { parseStatus } from "./prompts.js";
export { maskUrl, sendNotify } from "./notify.js";
export { renderStatusline } from "./statusline.js";
