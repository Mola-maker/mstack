import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/**
 * agent-claude (B2 — BATCHES.md, DESIGN §5, adapters-routing §2.1): the
 * HeadlessAgentAdapter for Claude Code, grounded in cli/design/inputs/
 * claude-help.txt (headless `-p`, `--output-format stream-json`, `--resume`,
 * per-run `--settings` for the native hook bridge, `--max-budget-usd`).
 *
 * The plugin registers ONLY the adapter — `agent.claude` health stays owned by
 * tool-magpie's PATH probes (an absent claude must not fail the doctor), and
 * `mola agents list` merges it with `magpie ls`. Phase 2 (`mola run`) calls
 * the adapter through `isRunnableAgent` (@mola/plugin-sdk AGENTS.md).
 */

import type { HeadlessAgentAdapter, PluginContext, RunRequest, RunResult, SessionRef, Usage, UsageScope } from "@mola/plugin-sdk";
import { definePlugin } from "@mola/plugin-sdk";
import { probeClaude } from "./detect.js";
import {
  CLAUDE_CAPABILITIES,
  claudeListSessionsUnsupported,
  claudeSetModel,
  claudeUsage,
  claudeUsesMagpie,
  runClaude,
} from "./run.js";

// re-exported so tests and phase 2 can import the internals through the
// package root (the manifest entry is ./dist/index.js)
export { probeClaude } from "./detect.js";
export {
  CLAUDE_CAPABILITIES,
  buildClaudeArgv,
  buildHookSettings,
  hookSinkScript,
  parseClaudeStream,
  permissionModeOf,
  claudeUsesMagpie,
  runClaude,
} from "./run.js";

export interface ClaudeAdapter extends HeadlessAgentAdapter {
  /** UnsupportedCapability — background-only native list; historical via magpie */
  listSessions(filter?: { cwd?: string; since?: string }): Promise<SessionRef[]>;
  usage(scope?: UsageScope): Promise<Usage[]>;
  /** `magpie claude <route>` — magpie owns ~/.claude */
  setModel(route: string): Promise<void>;
}

export function makeClaudeAdapter(ctx: PluginContext): ClaudeAdapter {
  // official-login Claude Code ignores magpie routes; decide once per process
  let settingsText: string | undefined;
  try {
    settingsText = readFileSync(join(homedir(), ".claude", "settings.json"), "utf8");
  } catch {
    settingsText = undefined;
  }
  const deps = { exec: ctx.process, events: ctx.events, fs: ctx.fs, magpieRouted: claudeUsesMagpie(process.env, settingsText) };
  return {
    id: "claude",
    capabilities: CLAUDE_CAPABILITIES,
    async detect() {
      return probeClaude(ctx.process);
    },
    run(req: RunRequest): Promise<RunResult> {
      return runClaude({ ...deps, fs: ctx.fs }, req);
    },
    async resume(sessionId, req) {
      return runClaude(
        { ...deps, fs: ctx.fs },
        sessionId === "latest" ? { ...req, sessionId: "latest" } : { ...req, sessionId },
      );
    },
    async listSessions(filter?: { cwd?: string }): Promise<SessionRef[]> {
      void filter;
      return claudeListSessionsUnsupported();
    },
    usage(scope?: UsageScope): Promise<Usage[]> {
      return claudeUsage({ exec: ctx.process }, scope);
    },
    setModel(route: string): Promise<void> {
      return claudeSetModel({ exec: ctx.process }, route);
    },
  };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.agents.register(makeClaudeAdapter(ctx));
  },
});
