/**
 * Skill-command tests: the six skill specs, the mstack repo lookup and the
 * prompt (it must name the skill and its .mstack/ state paths).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSkillPrompt,
  findMstackRoot,
  isMstackRoot,
  resolveStatePaths,
  skillFile,
  skillSpec,
  statePathsFromSkill,
  SKILL_COMMANDS,
} from "../src/skills.js";

test("skills: the six B2 skill commands exist with their mstack skill names", () => {
  assert.deepEqual(
    SKILL_COMMANDS.map((s) => s.command),
    ["think", "plan", "goal", "team", "review", "ship"],
  );
  assert.deepEqual(
    SKILL_COMMANDS.map((s) => s.skill),
    ["m-think", "m-plan", "m-goal", "m-team", "m-review", "m-ship"],
  );
  assert.equal(skillSpec("review")?.skill, "m-review");
  assert.equal(skillSpec("nope"), undefined);
});

test("skills: every skill spec declares the .mstack/ state paths it owns", () => {
  for (const spec of SKILL_COMMANDS) {
    for (const p of spec.statePaths) {
      assert.ok(p.startsWith(".mstack/"), `${spec.skill}: ${p} is not a .mstack path`);
    }
  }
  assert.ok(SKILL_COMMANDS.find((s) => s.command === "think")!.statePaths[0].includes(".mstack/specs/"));
  assert.ok(SKILL_COMMANDS.find((s) => s.command === "plan")!.statePaths[0].includes(".mstack/plans/"));
  assert.ok(SKILL_COMMANDS.find((s) => s.command === "goal")!.statePaths[0].includes(".mstack/goals/"));
  assert.ok(SKILL_COMMANDS.find((s) => s.command === "team")!.statePaths[0].includes(".mstack/team/"));
  assert.ok(SKILL_COMMANDS.find((s) => s.command === "review")!.statePaths[0].includes(".mstack/reviews/"));
});

test("skills: m-ship owns no state path — a PR is not a state file (no invention)", () => {
  const ship = SKILL_COMMANDS.find((s) => s.command === "ship")!;
  assert.deepEqual(ship.statePaths, []);
  // and the prompt of a skill with no state path names none
  const prompt = buildSkillPrompt(ship, "topic", {
    cwd: "/ws",
    skillPath: "/repo/skills/m-ship/SKILL.md",
    statePaths: [],
  });
  assert.doesNotMatch(prompt, /State paths this skill owns/);
});

test("skills: the state paths are read from the skill's own SKILL.md", () => {
  const md = [
    "Write the spec to `.mstack/specs/<YYYY-MM-DD>-<slug>.md`.",
    "State lives under `.mstack/goals/`.",
    "Also see `.mstack/reviews/<date>-<slug>.md`.",
  ].join("\n");
  const paths = statePathsFromSkill(md);
  assert.ok(paths.includes(".mstack/specs/<YYYY-MM-DD>-<slug>.md"));
  assert.ok(paths.includes(".mstack/reviews/<date>-<slug>.md"));
  // a bare directory is not a state path (the agent may not write "there")
  assert.ok(!paths.includes(".mstack/goals/"));
});

test("skills: a skill that names no .mstack path owns none", () => {
  assert.deepEqual(statePathsFromSkill("# m-ship\nPush the branch and open a PR.\n"), []);
});

test("skills: the prompt uses the skill's own paths when the file is readable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-skills-"));
  const skillDir = path.join(dir, "skills", "m-review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "Write to `.mstack/reviews/<date>-<slug>.md`.\n");
  try {
    const spec = skillSpec("review")!;
    const file = path.join(skillDir, "SKILL.md");
    const prompt = buildSkillPrompt(spec, "topic", {
      cwd: "/ws",
      skillPath: file,
      statePaths: resolveStatePaths(spec, file),
    });
    assert.match(prompt, /\.mstack\/reviews\/<date>-<slug>\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skills: the prompt names the skill, its file and its state paths", () => {
  const spec = skillSpec("goal")!;
  const prompt = buildSkillPrompt(spec, "ship the B2 CLI", {
    cwd: "/ws",
    skillPath: "/repo/skills/m-goal/SKILL.md",
  });
  assert.match(prompt, /m-goal/);
  assert.match(prompt, /\/repo\/skills\/m-goal\/SKILL\.md/);
  assert.match(prompt, /\.mstack\/goals\/<slug>\.md/);
  assert.match(prompt, /ship the B2 CLI/);
  assert.match(prompt, /\/ws/);
});

test("skills: without a readable skill file the prompt says so (no invention)", () => {
  const spec = skillSpec("think")!;
  const prompt = buildSkillPrompt(spec, "topic", { cwd: "/ws" });
  assert.match(prompt, /not readable on this machine/);
  assert.doesNotMatch(prompt, /Read and follow it:/);
});

test("skills: the mstack root is found through MOLA_MSTACK_DIR", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-skills-"));
  fs.mkdirSync(path.join(dir, "skills", "m-goal"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "{}");
  try {
    assert.equal(isMstackRoot(dir), true);
    const root = findMstackRoot({ cwd: "/nowhere", env: { MOLA_MSTACK_DIR: dir } as NodeJS.ProcessEnv });
    assert.equal(root, dir);
    assert.equal(skillFile(root, "m-goal"), null); // no SKILL.md written
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skills: the mstack root is found by walking up from the working directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-skills-"));
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "{}");
  const nested = path.join(dir, "cli", "packages");
  fs.mkdirSync(nested, { recursive: true });
  try {
    const root = findMstackRoot({ cwd: nested, env: {} as NodeJS.ProcessEnv });
    assert.equal(root, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skills: no mstack root on the machine ⇒ null (never a guess)", () => {
  const root = findMstackRoot({
    cwd: path.join(os.tmpdir(), "definitely-not-mstack-xyz"),
    env: {} as NodeJS.ProcessEnv,
    startDir: path.join(os.tmpdir(), "definitely-not-mstack-xyz"),
  });
  assert.equal(root, null);
});
