/**
 * tool-rtk (B1): detect rtk, read its version, and expose the `tool.rtk`
 * doctor check (BATCHES.md B1 acceptance #1 lists `tool.rtk` among the checks).
 *
 * Scope discipline (adapters-routing §3.3): rtk is an *output compactor* that
 * mola wraps — `rtk rewrite`, `rtk bypass`, `rtk gain`. This plugin only
 * detects it and reports health; the passthrough command lives in cmd-rtk, and
 * "which agents run their shells through RTK" is magpie's domain
 * (`magpie library rtk on|off <agent>`) — mola reads that state, never sets it.
 *
 * Honesty about absence: in WSL rtk may not be installed at all (it is a
 * Windows-first tool). An absent rtk is *reported*, not fatal — rtk is an
 * optimisation, not a dependency of the CLI.
 */

import type {
  CheckResult,
  DoctorCheck,
  PluginContext,
  ToolAdapter,
  ToolProbe,
} from "@mola/plugin-sdk";
import { definePlugin, ExitCode } from "@mola/plugin-sdk";
import { locateRtk, parseVersion, type RtkInfo } from "./detect.js";

// re-exported for consumers and the self-reference test import
export { findInWinget, findOnPath, locateRtk, parseVersion } from "./detect.js";
export type { RtkInfo, RtkLocation } from "./detect.js";

/** `rtk --version` is the documented flag (inputs/rtk-help.txt: `-V, --version`). */
const VERSION_ARGS = ["--version"];

export interface RtkToolAdapter extends ToolAdapter {
  /** detect (and cache) rtk: path + version */
  detect(): Promise<RtkInfo>;
}

function makeAdapter(ctx: PluginContext): RtkToolAdapter {
  let cached: RtkInfo | null = null;

  async function detect(): Promise<RtkInfo> {
    const loc = locateRtk(process.env, process.platform);
    let version: string | null = null;
    if (loc.path) {
      try {
        const res = await ctx.process.exec([loc.path, ...VERSION_ARGS], { timeoutMs: 10_000 });
        if (res.code === 0) version = parseVersion(res.stdout || res.stderr);
      } catch (err) {
        // a permission denial or a broken binary must not crash the plugin;
        // the doctor check reports "present but unusable" from path + null version
        ctx.log.debug("rtk version probe failed", { error: String(err) });
      }
    }
    cached = { ...loc, version, platform: process.platform };
    return cached;
  }

  const adapter: RtkToolAdapter = {
    id: "rtk",
    async probe(): Promise<ToolProbe> {
      const info = await detect();
      if (!info.path) {
        return { ok: true, detail: "rtk not found (optional on this machine)" };
      }
      if (!info.version) {
        return { ok: false, detail: `rtk found at ${info.path} but --version failed` };
      }
      return { ok: true, detail: `rtk ${info.version} (${info.source})` };
    },
    detect,
  };
  Object.defineProperty(adapter, "cached", { get: () => cached });
  return adapter;
}

function rtkCheck(adapter: RtkToolAdapter): DoctorCheck {
  return {
    id: "tool.rtk",
    description: "rtk output compactor is available (optional in WSL)",
    async run(): Promise<CheckResult> {
      const info = await adapter.detect();
      if (!info.path) {
        // absent rtk is reported, not failed (Windows-first tool; WSL may lack it)
        return {
          ok: true,
          message:
            "rtk not found on PATH or in %LOCALAPPDATA%\\Microsoft\\WinGet\\Packages — " +
            "optional: `mola rtk` needs it, everything else works without it",
        };
      }
      if (!info.version) {
        return {
          ok: false,
          message: `rtk found at ${info.path} (${info.source}) but \`rtk --version\` failed`,
          exitCode: ExitCode.Unavailable,
        };
      }
      return { ok: true, message: `rtk ${info.version} (${info.source}: ${info.path})` };
    },
  };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    const adapter = makeAdapter(ctx);
    ctx.tools.register(adapter);
    ctx.doctor.registerCheck(rtkCheck(adapter));
  },
});
