/**
 * The mstack skill commands (adapters-routing §5, BATCHES B2):
 *
 *   mola think|plan|goal|team|review|ship "<topic>"
 *
 * Each command wraps the matching mstack skill (m-think, m-plan, m-goal,
 * m-team, m-review, m-ship from the repo's `skills/` directory) and runs it
 * through the routed agent. The prompt names the skill, points at its
 * SKILL.md, and states the `.mstack/` state paths the skill owns — the skill
 * stays the source of truth for HOW to work; mola only supplies the routing,
 * the workspace and the record.
 *
 * The skill source is the mstack repo root — the directory that carries both
 * `skills/` and `.claude-plugin/plugin.json` (same rule as cmd-plugin's
 * findMstackRoot): $MOLA_MSTACK_DIR, the `skills.source` config value, then
 * an upward walk from the working directory and from this package.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskKind } from "./policy.js";

export interface SkillSpec {
  /** the mola command name ("think") */
  command: string;
  /** the mstack skill directory name ("m-think") */
  skill: string;
  /** the routing task kind (ADR-0003 §5) */
  taskKind: TaskKind;
  /** one line for `mola help` */
  description: string;
  /** the `.mstack/` paths the skill owns (relative to the workspace) */
  statePaths: string[];
  /** the default agent class the skill wants (a hint, not a pin) */
  prefersAgent?: string;
}

/**
 * The six skill commands of B2.
 *
 * The `statePaths` here are the FALLBACK list, used only when the skill's own
 * SKILL.md cannot be read (a machine without the mstack repo). When the file
 * IS readable, the paths are extracted from it — the skill is the source of
 * truth for the state it owns, so a path can never drift or be invented here.
 */
export const SKILL_COMMANDS: readonly SkillSpec[] = [
  {
    command: "think",
    skill: "m-think",
    taskKind: "plan",
    description: "m-think — attack the premise, ask ≤3 questions, write a design spec",
    statePaths: [".mstack/specs/<YYYY-MM-DD>-<slug>.md"],
  },
  {
    command: "plan",
    skill: "m-plan",
    taskKind: "plan",
    description: "m-plan — a plan a builder can execute, with the critic's verdict",
    statePaths: [".mstack/plans/<YYYY-MM-DD>-<slug>.md"],
  },
  {
    command: "goal",
    skill: "m-goal",
    taskKind: "implement",
    description: "m-goal — long-running goal loop with checkpoints and a mandatory closeout",
    statePaths: [".mstack/goals/<slug>.md"],
    prefersAgent: "dsh",
  },
  {
    command: "team",
    skill: "m-team",
    taskKind: "implement",
    description: "m-team — agent team rounds; state per round under .mstack/team/<slug>/",
    statePaths: [
      ".mstack/team/<slug>/v<N>.md",
      ".mstack/team/<slug>/LEARNINGS.md",
      ".mstack/team/<slug>/SYNTHESIS.md",
    ],
  },
  {
    command: "review",
    skill: "m-review",
    taskKind: "review",
    description: "m-review — multi-angle defect review by someone other than the author",
    statePaths: [".mstack/reviews/<date>-<slug>.md"],
  },
  {
    // m-ship owns no .mstack/ state file — it produces a PR. The list stays
    // empty; the skill file (when readable) is the only source of truth.
    command: "ship",
    skill: "m-ship",
    taskKind: "ship",
    description: "m-ship — branch to a clean PR: sync, real tests, independent review, push",
    statePaths: [],
  },
];

export function skillSpec(command: string): SkillSpec | undefined {
  return SKILL_COMMANDS.find((s) => s.command === command);
}

/** True when the directory looks like the mstack repo root. */
export function isMstackRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json")) &&
    fs.existsSync(path.join(dir, "skills"))
  );
}

/**
 * Find the mstack repo root: $MOLA_MSTACK_DIR → the `skills.source` config
 * value → an upward walk from the working directory → an upward walk from this
 * package (the workspace layout puts the repo root four levels up).
 */
export function findMstackRoot(opts: {
  cwd: string;
  configSource?: string;
  env?: NodeJS.ProcessEnv;
  startDir?: string;
}): string | null {
  const env = opts.env ?? process.env;
  const candidates: string[] = [];
  if (env.MOLA_MSTACK_DIR) candidates.push(path.resolve(env.MOLA_MSTACK_DIR));
  if (opts.configSource) candidates.push(path.resolve(opts.configSource));
  for (const dir of candidates) {
    if (isMstackRoot(dir)) return dir;
  }
  for (const start of [opts.cwd, opts.startDir ?? path.dirname(import.meta.url ?? ".")]) {
    if (!start) continue;
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i++) {
      if (isMstackRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** The SKILL.md path of a skill in the mstack repo, or null when it is absent. */
export function skillFile(root: string | null, skill: string): string | null {
  if (!root) return null;
  const file = path.join(root, "skills", skill, "SKILL.md");
  return fs.existsSync(file) ? file : null;
}

/**
 * The `.mstack/` state paths a skill names in its own SKILL.md.
 *
 * The skill is the source of truth for the state it owns (the skill commands
 * of adapters-routing §5), so the paths are READ from the skill file instead
 * of being listed in mola — a path mola invents is a path the agent may write
 * where it should not. A skill that names no `.mstack/` path (m-ship: it
 * produces a PR, not a state file) owns none, and the list stays empty.
 *
 * Only file-shaped paths are taken (`.mstack/<dir>/<name>`), so a prose
 * mention of a directory never becomes a "state path".
 */
export function statePathsFromSkill(skillMd: string): string[] {
  const out: string[] = [];
  const re = /\.mstack\/[A-Za-z0-9._<>{}-]+(?:\/[A-Za-z0-9._<>{}-]+)*/g;
  for (const match of skillMd.match(re) ?? []) {
    // a path must have a file part: `.mstack/team/` is a directory, not a file
    const trimmed = match.replace(/\/+$/, "");
    if (!trimmed.includes("/")) continue;
    const segments = trimmed.split("/");
    if (segments.length < 3) continue; // .mstack/<file> is not a state path
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * The state paths to put in the prompt: the skill's own, when its SKILL.md is
 * readable; the fallback list otherwise (a machine without the mstack repo).
 */
export function resolveStatePaths(spec: SkillSpec, skillPath?: string | null): string[] {
  if (!skillPath) return [...spec.statePaths];
  try {
    const fromSkill = statePathsFromSkill(fs.readFileSync(skillPath, "utf8"));
    return fromSkill.length ? fromSkill : [...spec.statePaths];
  } catch {
    return [...spec.statePaths];
  }
}

/**
 * The prompt for a skill command. It names the skill, points at its SKILL.md,
 * states the `.mstack/` state paths the skill owns, and gives the topic.
 *
 * The prompt is a plain text block (never a shell string) — the adapters pass
 * it to the agent CLI as an argument, and the SDK contract says the prompt is
 * never interpolated into a shell command.
 */
export function buildSkillPrompt(
  spec: SkillSpec,
  topic: string,
  opts: { cwd: string; skillPath?: string; statePaths?: string[] },
): string {
  const lines: string[] = [];
  lines.push(`Use the mstack skill \`${spec.skill}\` for this task.`);
  if (opts.skillPath) {
    lines.push(`Read and follow it: ${opts.skillPath}`);
  } else {
    lines.push(
      `The skill \`${spec.skill}\` is not readable on this machine — follow the procedure it describes as far as you can and say what you could not do.`,
    );
  }
  lines.push("");
  lines.push(`Topic: ${topic}`);
  lines.push("");
  lines.push(`Workspace: ${opts.cwd}`);
  lines.push("");
  const statePaths = opts.statePaths ?? resolveStatePaths(spec, opts.skillPath);
  if (statePaths.length) {
    lines.push("State paths this skill owns (write here, do not invent others):");
    for (const p of statePaths) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push(
    "Work the skill's procedure end to end, then report in the mstack format: one-line conclusion → what changed (file:line) → how it was verified (command + result) → what was not done, and the risks.",
  );
  return lines.join("\n");
}
