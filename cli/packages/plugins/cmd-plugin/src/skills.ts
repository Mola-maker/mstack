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

import { createHash } from "node:crypto";
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
  /** content hash of the source skill directory (copy mode only) */
  hash?: string;
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
  /** copy into ~/.dsh/skills instead of linking: the install then survives the checkout moving or changing branch */
  copy?: boolean;
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
    const mode = target === "dsh" && !opts.copy ? "symlink" : "copy";
    for (const skill of skills) {
      const destination = path.join(dir, skill.name);
      const hash = mode === "copy" ? hashDir(skill.source) : undefined;
      entries.push({
        target,
        name: skill.name,
        source: skill.source,
        destination,
        mode,
        action: classifyAction(destination, skill.source, mode, hash),
        hash,
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
  hash?: string,
): SkillPlanEntry["action"] {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(destination);
  } catch {
    return "create";
  }
  if (stat.isSymbolicLink()) {
    if (mode === "copy") return "replace";
    try {
      if (fs.realpathSync(destination) === fs.realpathSync(source)) return "keep";
    } catch {
      /* dangling link: replace it */
    }
    return "replace";
  }
  // A copy is current only when its stamp carries the source's content hash. A directory with no stamp
  // (an older install, or a hand-made one) is replaced: "keep" used to mean a copy was never updated.
  if (stat.isDirectory()) return mode === "copy" && hash !== undefined && readStamp(destination)?.hash === hash ? "keep" : "replace";
  return "replace";
}

/** The stamp written into a copied skill: what was installed, from where. */
export const STAMP_FILE = ".mstack-install.json";

export interface SkillStamp {
  name: string;
  hash: string;
  source: string;
  installedAt: string;
}

export function readStamp(dir: string): SkillStamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, STAMP_FILE), "utf8"));
    return typeof parsed?.hash === "string" ? (parsed as SkillStamp) : null;
  } catch {
    return null;
  }
}

/**
 * sha256 over the sorted relative paths and bytes of every file in a skill directory. Dotfiles are left
 * out (the stamp is one), and CRLF is folded to LF so a Windows checkout and a WSL one hash alike.
 */
export function hashDir(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string, rel: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), r);
      else if (entry.isFile()) {
        h.update(r + "\0");
        h.update(fs.readFileSync(path.join(d, entry.name)).toString("latin1").replace(/\r\n/g, "\n"), "latin1");
        h.update("\0");
      }
    }
  };
  walk(dir, "");
  return h.digest("hex");
}

export interface SkillsStatus {
  target: SkillTarget;
  dir: string;
  /** skills in the source repo */
  total: number;
  /** linked to this source, or a copy whose stamp matches it */
  current: string[];
  /** installed but different from the source (another checkout, an old copy, no stamp) */
  stale: string[];
  missing: string[];
}

/** Compare what a harness has installed with the source repo. Reads only. */
export function skillsStatus(opts: { root: string; target: "dsh" | "codex"; home: string }): SkillsStatus {
  const dir = targetDir(opts.target, opts.home);
  const out: SkillsStatus = { target: opts.target, dir, total: 0, current: [], stale: [], missing: [] };
  for (const skill of listSkills(opts.root)) {
    out.total++;
    const destination = path.join(dir, skill.name);
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(destination); } catch { /* not installed */ }
    if (!stat) { out.missing.push(skill.name); continue; }
    let same = false;
    if (stat.isSymbolicLink()) {
      try { same = fs.realpathSync(destination) === fs.realpathSync(skill.source); } catch { /* dangling link */ }
    } else if (stat.isDirectory()) {
      same = readStamp(destination)?.hash === hashDir(skill.source);
    }
    (same ? out.current : out.stale).push(skill.name);
  }
  return out;
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
  const stamp: SkillStamp = { name: entry.name, hash: entry.hash ?? hashDir(entry.source), source: entry.source, installedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(entry.destination, STAMP_FILE), JSON.stringify(stamp, null, 2) + "\n");
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.name === STAMP_FILE) continue;
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
