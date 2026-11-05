/**
 * `mola skills install [--claude|--dsh|--codex]` (core §1 item 2, core §8.1).
 *
 * The mstack skills are one artifact consumed by three harnesses; mola does
 * not re-implement the installs, it points at them:
 *
 *  - **claude**: the mstack repo is a Claude Code plugin. The install is
 *    `claude plugin marketplace add Mola-maker/mstack` (FRAMEWORK.md §10) —
 *    mola prints that line instead of shelling out, because the marketplace
 *    add is a user-facing, outward action. When the marketplace is already
 *    registered (a `mstack` entry in ~/.claude/config.json's marketplace
 *    list) the plugin is present and nothing is printed.
 *  - **dsh**: ~/.dsh/skills/<name> — a symlink per skill, pointing at the
 *    repo's skills/<name> (this is how the machine is set up today).
 *  - **codex**: ~/.codex/skills/<name> — a copy (Codex does not follow
 *    symlinks for skills).
 *
 * The default target is dsh+codex; `--claude`/`--dsh`/`--codex` narrow it.
 * `--dry-run` prints the plan without touching the filesystem — the tests use
 * it, and it is the honest default for a command that writes outside the
 * project.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SkillTarget = "claude" | "dsh" | "codex";

export const SKILL_TARGETS: readonly SkillTarget[] = ["claude", "dsh", "codex"];

/** The marketplace line for the Claude Code install (FRAMEWORK.md §10). */
export const CLAUDE_MARKETPLACE_COMMAND =
  "claude plugin marketplace add Mola-maker/mstack";

export interface SkillEntry {
  /** directory name under skills/ (e.g. "m-start") */
  name: string;
  /** absolute path of the source skill directory */
  source: string;
}

export interface SkillPlanEntry {
  target: SkillTarget;
  name: string;
  source: string;
  /** the link/copy destination */
  destination: string;
  /** "symlink" (dsh) or "copy" (codex) */
  mode: "symlink" | "copy" | "print";
  action: "create" | "replace" | "keep" | "skip";
  detail?: string;
}

export interface SkillPlan {
  root: string;
  entries: SkillPlanEntry[];
  /** the human line for the claude target (marketplace add) */
  claudeHint?: string;
}

/** List the skill directories of the mstack repo (skills/<name>/SKILL.md). */
export function listSkills(root: string): SkillEntry[] {
  const dir = path.join(root, "skills");
  if (!fs.existsSync(dir)) return [];
  const out: SkillEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) continue;
    out.push({ name: entry.name, source });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The destination directory of one target. */
export function targetDir(target: SkillTarget, home: string): string {
  switch (target) {
    case "dsh":
      return path.join(home, ".dsh", "skills");
    case "codex":
      return path.join(home, ".codex", "skills");
    case "claude":
      return path.join(home, ".claude");
  }
}

/**
 * Is the mstack marketplace already registered with Claude Code? The
 * marketplace list lives in ~/.claude/plugins/config.json (a JSON file with a
 * `repositories`/`marketplaces` map) — read defensively: an unreadable file
 * means "not registered" and the hint is printed.
 */
export function claudeMarketplaceRegistered(home: string): boolean {
  const candidates = [
    path.join(home, ".claude", "plugins", "config.json"),
    path.join(home, ".claude", "config.json"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const text = JSON.stringify(parsed);
      if (/mstack/i.test(text)) return true;
    } catch {
      /* unreadable config: treat as not registered */
    }
  }
  return false;
}

/**
 * Build the plan for one or more targets. Nothing is written — the caller
 * executes the plan after the user confirmed.
 */
export function planSkills(opts: {
  root: string;
  targets: SkillTarget[];
  home: string;
  /** when true, the plan is only computed (dry run) */
  dryRun?: boolean;
}): SkillPlan {
  const skills = listSkills(opts.root);
  const entries: SkillPlanEntry[] = [];
  for (const target of opts.targets) {
    if (target === "claude") {
      // the claude install is the marketplace line; nothing is copied
      entries.push({
        target,
        name: "mstack",
        source: opts.root,
        destination: path.join(targetDir(target, opts.home), "plugins", "mstack"),
        mode: "print",
        action: claudeMarketplaceRegistered(opts.home) ? "keep" : "skip",
        detail: CLAUDE_MARKETPLACE_COMMAND,
      });
      continue;
    }
    const dir = targetDir(target, opts.home);
    const mode = target === "dsh" ? "symlink" : "copy";
    for (const skill of skills) {
      const destination = path.join(dir, skill.name);
      entries.push({
        target,
        name: skill.name,
        source: skill.source,
        destination,
        mode,
        action: classifyAction(destination, skill.source, mode),
      });
    }
  }
  const claudeTarget = opts.targets.includes("claude");
  return {
    root: opts.root,
    entries,
    claudeHint:
      claudeTarget && !claudeMarketplaceRegistered(opts.home)
        ? CLAUDE_MARKETPLACE_COMMAND
        : undefined,
  };
}

function classifyAction(
  destination: string,
  source: string,
  mode: "symlink" | "copy",
): SkillPlanEntry["action"] {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(destination);
  } catch {
    return "create";
  }
  if (stat.isSymbolicLink()) {
    try {
      if (fs.realpathSync(destination) === fs.realpathSync(source)) return "keep";
    } catch {
      /* dangling link: replace it */
    }
    return "replace";
  }
  if (stat.isDirectory()) return mode === "copy" ? "keep" : "replace";
  return "replace";
}

/** Execute one plan entry (create/replace only; "keep" is a no-op). */
export function applySkillEntry(entry: SkillPlanEntry): void {
  if (entry.action === "keep" || entry.action === "skip") return;
  fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
  if (entry.mode === "symlink") {
    try {
      fs.rmSync(entry.destination, { recursive: true, force: true });
    } catch {
      /* nothing to remove */
    }
    fs.symlinkSync(entry.source, entry.destination, "junction");
    return;
  }
  // copy: replace the destination directory with a fresh copy of the source
  try {
    fs.rmSync(entry.destination, { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
  copyDir(entry.source, entry.destination);
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

/** The default target set: dsh + codex (claude is a printed marketplace line). */
export function defaultTargets(): SkillTarget[] {
  return ["dsh", "codex"];
}

/** The user's home directory (for ~/.dsh/skills, ~/.codex/skills). */
export function userHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE || env.HOME || os.homedir();
}
