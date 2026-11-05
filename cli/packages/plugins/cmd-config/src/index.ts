/**
 * cmd-config (B1 minimal: get/set — core §8.1). Writes persist to the global
 * layer (~/.mola/config.jsonc) via the configWriter capability, which core
 * grants only because this plugin's manifest declares mola: ["config.write"].
 *
 * Secrets are never config (core §2.4): secret-shaped keys are refused here
 * (exit 77, SECRET_REFUSED); provider keys live in magpie / the user's vault.
 * Full configSchema-union validation arrives with the plugin config schemas in
 * step 2; unknown keys are kept and `mola doctor` will surface them.
 */

import type { PluginContext } from "@mola/plugin-sdk";
import { definePlugin, MolaError, MolaEvents, ExitCode } from "@mola/plugin-sdk";

const SECRET_KEY_RE = /(secret|token|password|api[-_.]?key|private[-_.]?key|credential)/i;

function requireKey(args: { positionals: string[] }, usage: string): string {
  const key = args.positionals[0];
  if (!key) throw new MolaError("USAGE_ERROR", usage, ExitCode.Usage);
  return key;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // plain string
  }
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["config", "get"],
      description: "read a config key (dotted path, e.g. log.level)",
      async handler(args, io) {
        const key = requireKey(args, "usage: mola config get <key>");
        if (!ctx.config.has(key)) {
          throw new MolaError("CONFIG_KEY_NOT_FOUND", `config key not set: ${key}`, ExitCode.NoInput);
        }
        const value = ctx.config.get(key);
        io.data({ key, value });
        if (!io.json) io.out(typeof value === "string" ? value : JSON.stringify(value));
        return ExitCode.Ok;
      },
    });

    ctx.commands.register({
      path: ["config", "set"],
      description: "write a config key to ~/.mola/config.jsonc (null deletes)",
      async handler(args, io) {
        const key = requireKey(args, "usage: mola config set <key> <value>");
        const raw = args.positionals[1];
        if (raw === undefined) {
          throw new MolaError("USAGE_ERROR", "usage: mola config set <key> <value>", ExitCode.Usage);
        }
        if (SECRET_KEY_RE.test(key)) {
          throw new MolaError(
            "SECRET_REFUSED",
            `refusing to store secret-shaped key "${key}" — secrets are never config; keep them in magpie or your vault`,
            ExitCode.NoPerm,
          );
        }
        if (!ctx.configWriter) {
          // unreachable for this manifest (declares config.write); defensive for forks
          throw new MolaError("PERMISSION_DENIED", "config.write not granted", ExitCode.NoPerm);
        }
        const value = parseValue(raw);
        ctx.configWriter.set(key, value);
        ctx.events.emit(MolaEvents.ConfigChanged, { layer: "global", keys: [key] });
        io.data({ key, value });
        if (!io.json) io.out(`${key} = ${JSON.stringify(value)}`);
        return ExitCode.Ok;
      },
    });
  },
});
