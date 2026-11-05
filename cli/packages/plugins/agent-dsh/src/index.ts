/**
 * agent-dsh — the reference HeadlessAgentAdapter (B1 detection + B2 run
 * surface; DESIGN §11 conflict 8, adapters-routing §2.10). It wraps the tested
 * DSH headless flow (tasks/dispatch.sh): DSH lives in WSL, is booted with
 * `--profile mola-cli`, emits `--json` NDJSON run events and resumes with
 * `--session-id` (dsh-cli-help.md — no other flags are assumed).
 *
 * Surfaces:
 *  - the `dsh` agent adapter in ctx.agents — detection/health AND the B2 run
 *    surface (`run()`/`resume()`, see @mola/plugin-sdk agents.ts + AGENTS.md).
 *    Phase 2 (`mola run`, the routing engine) calls it through
 *    `isRunnableAgent`; `mola dispatch` keeps its own thin wrapper (cmd-dispatch).
 *  - the `agent.dsh` doctor check (acceptance: machine "wsl:Ubuntu").
 *
 * Every run emits the ADR-0004 canonical events on the bus (run.ts).
 */

import type {
  AgentCapabilities,
  CheckResult,
  DoctorCheck,
  HeadlessAgentAdapter,
  PluginContext,
  RunRequest,
  RunResult,
} from "@mola/plugin-sdk";
import { definePlugin, ExitCode, UnsupportedCapability } from "@mola/plugin-sdk";
import { probeDsh, type DshDetect } from "./detect.js";
import { runDsh } from "./run.js";

export const DSH_CAPABILITIES: AgentCapabilities = {
  headless: true,
  headlessJsonStream: true, // dsh --json (NDJSON run events)
  resume: true, // --session-id <id> (adopt the persisted Session)
  continueLatest: false, // no continue-latest flag in dsh-cli-help.md
  forkSession: false,
  listSessions: false, // session registry is mola's own (state store)
  acp: true, // dsh --profile acp
  nativeHooks: true, // Cordis bridge plugin via --patch (B3+ mount)
  backgroundSessions: false,
  worktree: false, // via the git tool instead (adapters-routing §3.1)
  budgetCap: false, // the router enforces budget (polling magpie usage)
  costReadout: "magpie",
};

export interface DshAdapter extends HeadlessAgentAdapter {
  detect(): Promise<DshDetect>;
}

export function makeDshAdapter(ctx: PluginContext): DshAdapter {
  return {
    id: "dsh",
    capabilities: DSH_CAPABILITIES,
    async detect() {
      const d = await probeDsh(ctx.process);
      // ground truth from magpie-agents.txt: magpie manages the WSL profile
      // (\\wsl.localhost\Ubuntu\root\.dsh\profiles\mola\cordis.patch.yml)
      return { ...d, managedByMagpie: d.available ? true : undefined };
    },
    run(req: RunRequest): Promise<RunResult> {
      return runDsh({ exec: ctx.process, events: ctx.events, fs: ctx.fs }, req);
    },
    async resume(sessionId, req) {
      if (sessionId === "latest") {
        // no continue-latest flag in dsh-cli-help.md — the router passes the
        // session id it recorded from the previous RunResult
        throw new UnsupportedCapability("dsh", 'resume("latest")', "pass the sessionId from the previous RunResult");
      }
      return runDsh({ exec: ctx.process, events: ctx.events, fs: ctx.fs }, { ...req, sessionId });
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
    const adapter = makeDshAdapter(ctx);
    ctx.agents.register(adapter);
    ctx.doctor.registerCheck(dshDoctorCheck(adapter));
  },
});
