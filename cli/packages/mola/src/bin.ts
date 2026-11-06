#!/usr/bin/env node
/**
 * The `mola` bin — thin (core §1): parse global flags only, then @mola/core
 * boot(). Runs as `node cli/packages/mola/dist/bin.js` on Linux and Windows.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { boot, toMolaError, ExitCode, type GlobalFlags } from "@mola/core";

// node:sqlite is still experimental on Node 22: its one-time ExperimentalWarning on
// stderr would break the --json contract (stderr carries exactly one error line).
// Silence that one warning only; every other warning still prints.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (/SQLite is an experimental feature/i.test(String(text))) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const VERSION = "0.1.0";

/** Bundled first-party plugins (tier: builtin), resolved through this package's deps. */
const BUILTIN_PLUGIN_PACKAGES = [
  "@mola/plugin-cmd-doctor",
  "@mola/plugin-cmd-config",
  "@mola/plugin-cmd-plugin",
  "@mola/plugin-cmd-dispatch",
  "@mola/plugin-agent-dsh",
  "@mola/plugin-policy-approval",
  "@mola/plugin-cmd-model",
  "@mola/plugin-tool-magpie",
  "@mola/plugin-cmd-rtk",
  "@mola/plugin-tool-rtk",
  "@mola/plugin-tool-git",
  "@mola/plugin-agent-claude",
  "@mola/plugin-agent-codex",
  "@mola/plugin-rec-runs",
  "@mola/plugin-cmd-run",
  "@mola/plugin-tool-superagent",
  "@mola/plugin-cmd-dash",
];

function parseGlobalFlags(argv: string[]): { flags: GlobalFlags; rest: string[] } {
  const flags: GlobalFlags = {
    json: false,
    verbose: 0,
    quiet: false,
    yes: false,
    noColor: false,
    cwd: process.cwd(),
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--json") flags.json = true;
    else if (t === "-v" || t === "--verbose") flags.verbose++;
    else if (/^-vv+$/.test(t)) flags.verbose += t.length - 1;
    else if (t === "-q" || t === "--quiet") flags.quiet = true;
    else if (t === "--yes") flags.yes = true;
    else if (t === "--no-color") flags.noColor = true;
    else if (t === "--config") flags.configFile = argv[++i];
    else if (t === "--cwd") flags.cwd = path.resolve(argv[++i]);
    else rest.push(t);
  }
  if (process.env.MOLA_YES === "1") flags.yes = true;
  if (process.env.MOLA_NO_COLOR) flags.noColor = true;
  return { flags, rest };
}

function builtinPluginDirs(): string[] {
  const require = createRequire(import.meta.url);
  return BUILTIN_PLUGIN_PACKAGES.map((pkg) =>
    path.dirname(require.resolve(`${pkg}/package.json`)),
  );
}

async function main(): Promise<void> {
  const { flags, rest } = parseGlobalFlags(process.argv.slice(2));
  const traceId = randomUUID();

  if (rest[0] === "--version" || rest[0] === "version") {
    // full `mola version` (core + sidecar + skills versions) lands in B2
    process.stdout.write(`mola ${VERSION}\n`);
    process.exitCode = ExitCode.Ok;
    return;
  }

  try {
    process.exitCode = await boot({ argv: rest, flags, traceId, builtinPluginDirs: builtinPluginDirs() });
  } catch (err) {
    // boot() handles its own errors; this is the last-resort net (exit 70)
    const e = toMolaError(err, ExitCode.Software);
    if (flags.json) {
      process.stderr.write(
        JSON.stringify({ schemaVersion: 1, traceId, error: { code: e.code, message: e.message } }) + "\n",
      );
    } else {
      process.stderr.write(`mola: ${e.code}: ${e.message}\n`);
    }
    process.exitCode = e.exitCode;
  }
}

void main();
