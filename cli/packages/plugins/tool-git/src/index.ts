/**
 * tool-git (B1): detect git + gh, register the `tool.git` / `tool.gh` doctor
 * checks, and publish the worktree API that B2's router uses to create an
 * isolated workspace per dispatched subtask (adapters-routing §3.1,
 * FRAMEWORK §6: "code-changing subtask → its own `git worktree`").
 *
 * Deliberately no command yet (task brief: "no command yet"): B1 only needs
 * the capability + the health surface; `mola worktree …` arrives with the
 * B2 command tree.
 *
 * How other plugins reach the API
 * -------------------------------
 * The SDK's `ToolAdapter` only carries `id` + `probe()`, but the registry is
 * structural, so this plugin registers a *richer* adapter (`GitToolAdapter`)
 * under the id `"git"`. A consumer does:
 *
 *   const git = ctx.tools.get("git") as unknown as GitToolAdapter | undefined;
 *
 * The types are exported from this package (`@mola/plugin-tool-git`) so a
 * consumer can `import type { GitToolAdapter } from "@mola/plugin-tool-git"`.
 * The manifest advertises the capability ids `tool:git`, `tool:gh` and
 * `tool:git.worktree` so the loader can order dependents.
 *
 * Stable porcelain only (no `git-help.txt` was captured — adapters-routing §3.1
 * gap): `git worktree add|remove|list --porcelain`, `git rev-parse`.
 */

import * as path from "node:path";
import type {
  CheckResult,
  DoctorCheck,
  ExecResult,
  PluginContext,
  ToolAdapter,
  ToolProbe,
} from "@mola/plugin-sdk";
import { definePlugin, ExitCode, MolaError } from "@mola/plugin-sdk";
import {
  absolutePath,
  firstLine,
  locateBinary,
  parseGhVersion,
  parseGitVersion,
  parseWorktreeList,
  taskBranchName,
  type BinaryInfo,
  type WorktreeInfo,
} from "./detect.js";

export type { WorktreeInfo, BinaryInfo } from "./detect.js";
// re-exported for consumers and the self-reference test import
export {
  absolutePath,
  firstLine,
  locateBinary,
  parseGhVersion,
  parseGitVersion,
  parseWorktreeList,
  taskBranchName,
} from "./detect.js";

export interface WorktreeAddOptions {
  /** where the worktree is created (relative paths resolve against `cwd`) */
  path: string;
  /** branch to create; defaults to `agent/<slug>` derived from `task` */
  branch?: string;
  /** task slug used to derive the default branch name */
  task?: string;
  /** commit-ish to start from (defaults to the current HEAD) */
  startPoint?: string;
  /** repository to operate on; defaults to the repo of `cwd` */
  cwd?: string;
}

export interface WorktreeRemoveOptions {
  /** worktree path to remove */
  path: string;
  /** `--force` — needed for worktrees with uncommitted changes */
  force?: boolean;
  cwd?: string;
}

export interface WorktreeListOptions {
  cwd?: string;
}

/**
 * The tool-git adapter. `worktree*` methods are the API B2 consumes; they run
 * git through the permission-checked exec service, so `process.exec` really is
 * the boundary (core §6).
 */
export interface GitToolAdapter extends ToolAdapter {
  /** detect git and gh (paths + versions) */
  detect(): Promise<{ git: BinaryInfo; gh: BinaryInfo }>;
  /** create a worktree; returns its parsed description */
  worktreeAdd(opts: WorktreeAddOptions): Promise<WorktreeInfo>;
  /** list the worktrees of the repository containing `cwd` */
  worktreeList(opts?: WorktreeListOptions): Promise<WorktreeInfo[]>;
  /** remove a worktree */
  worktreeRemove(opts: WorktreeRemoveOptions): Promise<void>;
}

class GitError extends MolaError {
  constructor(message: string, details?: unknown) {
    super("UPSTREAM_UNAVAILABLE", message, ExitCode.Unavailable, details);
    this.name = "GitError";
  }
}

function makeAdapter(ctx: PluginContext): GitToolAdapter {
  let cached: { git: BinaryInfo; gh: BinaryInfo } | null = null;

  async function versionOf(
    loc: { path: string | null; source: "path" | "none" },
    args: string[],
    parse: (raw: string) => string | null,
  ): Promise<BinaryInfo> {
    if (!loc.path) return { path: null, source: "none", version: null, raw: null };
    let raw: string | null = null;
    let version: string | null = null;
    try {
      const res = await ctx.process.exec([loc.path, ...args], { timeoutMs: 15_000 });
      if (res.code === 0) {
        raw = firstLine(res.stdout || res.stderr);
        version = raw ? parse(raw) : null;
      }
    } catch (err) {
      ctx.log.debug("version probe failed", { error: String(err) });
    }
    return { path: loc.path, source: loc.source, version, raw };
  }

  async function detect(): Promise<{ git: BinaryInfo; gh: BinaryInfo }> {
    const gitLoc = locateBinary("git");
    const ghLoc = locateBinary("gh");
    cached = {
      git: await versionOf(gitLoc, ["--version"], parseGitVersion),
      gh: await versionOf(ghLoc, ["--version"], parseGhVersion),
    };
    return cached;
  }

  /** Run git, mapping a non-zero exit into a GitError with git's own stderr. */
  async function git(args: string[], cwd: string): Promise<ExecResult> {
    const info = cached?.git ?? (await detect()).git;
    if (!info.path) {
      throw new GitError("git is not installed or not on PATH");
    }
    const res = await ctx.process.exec([info.path, ...args], { cwd, timeoutMs: 60_000 });
    if (res.code !== 0) {
      throw new GitError(`git ${args.join(" ")} failed with exit code ${res.code}`, {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.code,
      });
    }
    return res;
  }

  const adapter: GitToolAdapter = {
    id: "git",
    async probe(): Promise<ToolProbe> {
      const info = await detect();
      if (!info.git.path) return { ok: false, detail: "git not found on PATH" };
      if (!info.git.version) {
        return { ok: false, detail: `git found at ${info.git.path} but --version failed` };
      }
      return {
        ok: true,
        detail: `git ${info.git.version}${info.gh.version ? `, gh ${info.gh.version}` : ""}`,
      };
    },
    detect,
    async worktreeAdd(opts: WorktreeAddOptions): Promise<WorktreeInfo> {
      const cwd = opts.cwd ?? process.cwd();
      const target = absolutePath(cwd, opts.path);
      const branch = opts.branch ?? taskBranchName(opts.task ?? path.basename(target));
      const args = ["worktree", "add", target, "-b", branch];
      if (opts.startPoint) args.push(opts.startPoint);
      await git(args, cwd);
      const list = await adapter.worktreeList({ cwd });
      const found = list.find((w) => absolutePath(cwd, w.path) === target);
      if (!found) {
        throw new GitError(
          `worktree ${target} was created but did not appear in \`git worktree list\``,
        );
      }
      return found;
    },
    async worktreeList(opts: WorktreeListOptions = {}): Promise<WorktreeInfo[]> {
      const cwd = opts.cwd ?? process.cwd();
      const res = await git(["worktree", "list", "--porcelain"], cwd);
      // git prints forward slashes on Windows; report native absolute paths
      return parseWorktreeList(res.stdout).map((w) => ({ ...w, path: path.resolve(w.path) }));
    },
    async worktreeRemove(opts: WorktreeRemoveOptions): Promise<void> {
      const cwd = opts.cwd ?? process.cwd();
      const target = absolutePath(cwd, opts.path);
      const args = ["worktree", "remove", target];
      if (opts.force) args.push("--force");
      await git(args, cwd);
    },
  };
  return adapter;
}

// ------------------------------------------------------------- doctor checks

function gitCheck(adapter: GitToolAdapter): DoctorCheck {
  return {
    id: "tool.git",
    description: "git is installed and runnable",
    async run(): Promise<CheckResult> {
      const info = await adapter.detect();
      if (!info.git.path) {
        return {
          ok: false,
          message: "git not found on PATH — install git (Windows: winget install Git.Git)",
          exitCode: ExitCode.Unavailable,
        };
      }
      if (!info.git.version) {
        return {
          ok: false,
          message: `git found at ${info.git.path} but \`git --version\` failed`,
          exitCode: ExitCode.Unavailable,
        };
      }
      return { ok: true, message: `git ${info.git.version} (${info.git.path})` };
    },
  };
}

function ghCheck(ctx: PluginContext, adapter: GitToolAdapter): DoctorCheck {
  return {
    id: "tool.gh",
    description: "GitHub CLI is installed; the authentication state is reported (not fatal)",
    async run(): Promise<CheckResult> {
      const info = await adapter.detect();
      if (!info.gh.path) {
        // gh is optional in B1 — report, do not fail (same rule as rtk)
        return { ok: true, message: "gh not found on PATH (optional — PR workflows need it)" };
      }
      if (!info.gh.version) {
        return {
          ok: false,
          message: `gh found at ${info.gh.path} but \`gh --version\` failed`,
          exitCode: ExitCode.Unavailable,
        };
      }
      // `gh auth status` exits 1 when no host is authenticated: that is a
      // machine state, not a broken install, so it is reported, not failed.
      let authNote: string;
      try {
        const auth = await ghAuthStatus(ctx, info.gh.path);
        authNote = auth.authenticated
          ? `authenticated${auth.host ? ` (${auth.host})` : ""}`
          : "not authenticated — run `gh auth login` for PR workflows";
      } catch (err) {
        authNote = `auth state unavailable (${err instanceof Error ? err.message : String(err)})`;
      }
      return { ok: true, message: `gh ${info.gh.version} — ${authNote}` };
    },
  };
}

/** Run `gh auth status` and summarise the outcome. */
async function ghAuthStatus(
  ctx: PluginContext,
  ghPath: string,
): Promise<{ authenticated: boolean; host?: string }> {
  const res = await ctx.process.exec([ghPath, "auth", "status"], { timeoutMs: 30_000 });
  const text = `${res.stdout}\n${res.stderr}`;
  const host = text.match(/Logged in to ([^\s]+)/)?.[1];
  if (res.code === 0) return { authenticated: true, host };
  return { authenticated: false, host };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    const adapter = makeAdapter(ctx);
    ctx.tools.register(adapter);
    ctx.doctor.registerCheck(gitCheck(adapter));
    ctx.doctor.registerCheck(ghCheck(ctx, adapter));
  },
});
