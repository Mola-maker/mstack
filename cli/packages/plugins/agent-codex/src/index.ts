/**
 * agent-codex (B2 — BATCHES.md, DESIGN §5, adapters-routing §2.2): the
 * HeadlessAgentAdapter for Codex CLI, grounded in cli/design/inputs/
 * codex-help.txt (`codex exec` headless, `--sandbox`/`-a never`, `codex
 * agents`, probe-gated `exec resume`). The plugin registers ONLY the adapter —
 * `agent.codex` health stays with tool-magpie's PATH probes. Phase 2
 * (`mola run`) calls it through `isRunnableAgent` (@mola/plugin-sdk AGENTS.md).
 */

import type {
  AgentCapabilities,
  HeadlessAgentAdapter,
  PluginContext,
  RunRequest,
  RunResult,
  SessionRef,
  Usage,
  UsageScope,
} from "@mola/plugin-sdk";
import { definePlugin } from "@mola/plugin-sdk";
import { probeCodex, type CodexDetect, type CodexExecSurface } from "./detect.js";
import {
  CODEX_CAPABILITIES,
  codexListSessions,
  codexSetModel,
  codexUsage,
  runCodex,
} from "./run.js";

// re-exported so tests and phase 2 can import the internals through the
// package root (the manifest entry is ./dist/index.js)
export { probeCodex, parseExecSurface, probeCodexExec, type CodexDetect } from "./detect.js";
export {
  CODEX_CAPABILITIES,
  buildCodexArgv,
  buildCodexResumeArgv,
  codexListSessions,
  parseCodexStream,
  runCodex,
  sandboxOf,
} from "./run.js";

export interface CodexAdapter extends HeadlessAgentAdapter {
  listSessions(filter?: { cwd?: string; since?: string }): Promise<SessionRef[]>;
  usage(scope?: UsageScope): Promise<Usage[]>;
  /** `magpie codex <route>` — magpie owns ~/.codex/config.toml */
  setModel(route: string): Promise<void>;
  /**
   * The `codex exec --help` surface, normally confirmed by detect(); tests and
   * phase 2 may pin it instead of re-probing.
   */
  execSurface?: CodexExecSurface;
}

export function makeCodexAdapter(ctx: PluginContext): CodexAdapter {
  const deps = { exec: ctx.process, events: ctx.events, fs: ctx.fs };
  const holder: { surface?: CodexExecSurface } = {};
  const runDeps = () => ({ ...deps, ...(holder.surface ? { surface: holder.surface } : {}) });
  return {
    id: "codex",
    /**
     * Probe-aware capabilities: the static CODEX_CAPABILITIES only claims what
     * the captured help guarantees; once detect() (or a pinned execSurface)
     * confirmed the `codex exec --help` surface, the probed flags are
     * reflected here so the router never reads a stale `resume: false`.
     */
    get capabilities(): AgentCapabilities {
      const s = holder.surface;
      if (!s) return CODEX_CAPABILITIES;
      return {
        ...CODEX_CAPABILITIES,
        headlessJsonStream: s.json,
        resume: s.resume,
        continueLatest: s.resumeLast,
        worktree: s.worktree,
      };
    },
    async detect(): Promise<CodexDetect> {
      const d = await probeCodex(ctx.process);
      holder.surface = d.exec; // detect() pins the probed surface for later runs
      return d;
    },
    run(req: RunRequest): Promise<RunResult> {
      return runCodex(runDeps(), req);
    },
    resume(sessionId, req) {
      return runCodex(runDeps(), { ...req, sessionId });
    },
    async listSessions(filter?: { cwd?: string }): Promise<SessionRef[]> {
      return codexListSessions({ exec: ctx.process }, filter);
    },
    usage(scope?: UsageScope): Promise<Usage[]> {
      return codexUsage({ exec: ctx.process }, scope);
    },
    setModel(route: string): Promise<void> {
      return codexSetModel({ exec: ctx.process }, route);
    },
    get execSurface(): CodexExecSurface | undefined {
      return holder.surface;
    },
    set execSurface(surface: CodexExecSurface | undefined) {
      holder.surface = surface;
    },
  };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.agents.register(makeCodexAdapter(ctx));
  },
});
