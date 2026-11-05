/**
 * cmd-plugin (B1: list + validate — core §8.1). `plugin list` shows the active
 * registry (id, version, kind, tier, state, quarantine info). `plugin validate
 * <dir>` checks a checkout's mola-plugin.json against the SDK contract without
 * installing (exit 65 on a bad manifest). install/update/remove/enable/disable/
 * doctor land in B2 with third-party plugin support.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginContext } from "@mola/plugin-sdk";
import { definePlugin, validateManifest, MolaError, ExitCode } from "@mola/plugin-sdk";

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["plugin", "list"],
      description: "installed plugins: id, version, kind, tier, state",
      async handler(_args, io) {
        const plugins = ctx.plugins.list();
        io.data(plugins);
        if (!io.json) {
          for (const p of plugins) {
            const suffix = p.state === "quarantined" ? ` (quarantined: ${p.error ?? "?"})` : "";
            io.out(`${p.id} ${p.version} ${p.kind} ${p.tier} ${p.state}${suffix}`);
          }
        }
        return ExitCode.Ok;
      },
    });

    ctx.commands.register({
      path: ["plugin", "validate"],
      description: "check a checkout's mola-plugin.json (no install)",
      async handler(args, io) {
        const dirArg = args.positionals[0];
        if (!dirArg) {
          throw new MolaError("USAGE_ERROR", "usage: mola plugin validate <dir>", ExitCode.Usage);
        }
        const dir = path.resolve(io.cwd, dirArg);
        const manifestPath = path.join(dir, "mola-plugin.json");
        if (!fs.existsSync(manifestPath)) {
          throw new MolaError("NO_INPUT", `no mola-plugin.json in ${dir}`, ExitCode.NoInput);
        }
        let parsed: unknown;
        try {
          // read through the permission-checked handle (manifest grants fs.read)
          parsed = JSON.parse(ctx.fs.readFile(manifestPath)); // manifests are strict JSON
        } catch (err) {
          if (err instanceof MolaError) throw err; // permission denials stay 77
          throw new MolaError(
            "MANIFEST_INVALID",
            `${manifestPath}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
            ExitCode.DataErr,
          );
        }
        const result = validateManifest(parsed);
        if (!result.ok) {
          if (!io.json) for (const e of result.errors) io.note(`  ✗ ${e}`);
          throw new MolaError("MANIFEST_INVALID", `${manifestPath}: ${result.errors.length} error(s)`, ExitCode.DataErr, {
            errors: result.errors,
          });
        }
        const m = result.manifest!;
        io.data({ valid: true, id: m.id, version: m.version, kind: m.kind });
        if (!io.json) io.out(`valid: ${m.id}@${m.version} (${m.kind})`);
        return ExitCode.Ok;
      },
    });
  },
});
