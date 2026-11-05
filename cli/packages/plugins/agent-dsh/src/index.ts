/**
 * agent-dsh (B1 reference adapter — DESIGN §11 conflict 8). It wraps the tested
 * DSH headless flow (tasks/dispatch.sh): DSH lives in WSL, is booted with
 * `--profile mola-cli`, emits `--json` NDJSON run events and resumes with
 * `--session-id` (dsh-cli-help.md — no other flags are assumed).
 *
 * Surface in B1:
 *  - the `dsh` AgentAdapter (detection/health) in ctx.agents — the registry the
 *    discovery command (`mola agents list`, owned by tool-magpie together with
 *    the `magpie ls` merge) and the B2 routing engine read;
 *  - the `agent.dsh` doctor check (acceptance: machine "wsl:Ubuntu").
 *
 * The dispatch runner is cmd-dispatch's job; runHeadless/resume/bridge hooks
 * arrive with the B2 routing engine (they need the hook bus streams).
 */

import type { AgentAdapter, CheckResult, DoctorCheck, PluginContext } from "@mola/plugin-sdk";
import { definePlugin, ExitCode } from "@mola/plugin-sdk";
import { probeDsh, type DshDetect } from "./detect.js";

export interface DshAdapter extends AgentAdapter {
  detect(): Promise<DshDetect>;
}

export function makeDshAdapter(exec: PluginContext["process"]): DshAdapter {
  return {
    id: "dsh",
    async detect() {
      const d = await probeDsh(exec);
      // ground truth from magpie-agents.txt: magpie manages the WSL profile
      // (\\wsl.localhost\Ubuntu\root\.dsh\profiles\mola\cordis.patch.yml)
      return { ...d, managedByMagpie: d.available ? true : undefined };
    },
  };
}

export function dshDoctorCheck(adapter: DshAdapter): DoctorCheck {
  return {
    id: "agent.dsh",
    description: "DSH headless worker reachable in WSL (profile mola-cli)",
    async run(): Promise<CheckResult> {
      const d = await adapter.detect();
      if (d.available) {
        return { ok: true, message: `dsh ${d.version} on ${d.machine} (profile mola-cli)` };
      }
      return {
        ok: false,
        message: `dsh not reachable (${d.detail ?? "probe failed"}) — expected in WSL, profile mola-cli`,
        exitCode: ExitCode.Unavailable,
      };
    },
  };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    const adapter = makeDshAdapter(ctx.process);
    ctx.agents.register(adapter);
    ctx.doctor.registerCheck(dshDoctorCheck(adapter));
  },
});
