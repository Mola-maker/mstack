#!/usr/bin/env node
// Check a project verify skill produced by m-qa.
//
// Usage:
//   node "<this skill dir>/scripts/check-verify-skill.mjs" <verify-dir>
// <verify-dir> is the project's `.claude/skills/verify` directory.
// Exit 0 and print `ok` when the shape is complete. Exit 1 and print one
// problem per line otherwise. Exit 2 when the directory argument is missing.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SECTIONS = ["## Launch", "## Doctor", "## Drive", "## Evidence", "## Cleanup"];
const FEATURE_H2 = [
  ["## Sub-features", false],
  ["## How to get to it (user POV)", false],
  ["## Driving it with ", true],
  ["## Gotchas", false],
];

function lineIndex(text, label, prefix) {
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const hit = prefix
      ? trimmed.startsWith(label) && trimmed.length > label.trim().length
      : trimmed === label;
    if (hit) return offset;
    offset += line.length + 1;
  }
  return -1;
}

// Non-fatal notes. A skill without a `Required level:` line still passes; receipt.mjs treats it as L1.
export function verifySkillWarnings(dir) {
  try {
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");
    if (!/^Required level:/m.test(text)) {
      return ["SKILL.md has no `Required level: L<0-5>` line under the title; it counts as L1. Add the line to declare the level this project requires"];
    }
  } catch { /* SKILL.md problems are reported as errors */ }
  return [];
}

export function checkVerifySkill(dir) {
  const problems = [];
  const skillPath = join(dir, "SKILL.md");
  if (!existsSync(skillPath)) return ["SKILL.md missing"];
  const text = readFileSync(skillPath, "utf8");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) problems.push("SKILL.md has no frontmatter");
  else {
    const repo = basename(resolve(dir, "..", "..", ".."));
    const expected = `${repo}-verify`;
    const name = fm[1].match(/^name:\s*["']?([\w-]+)/m)?.[1];
    if (name !== expected) problems.push(`frontmatter name is ${name ?? "missing"}, expected ${expected}`);
    if (!/^description:\s*\S/m.test(fm[1])) problems.push("description missing");
    if (/^disable-model-invocation:\s*["']?true/m.test(fm[1])) {
      problems.push("disable-model-invocation is set; the model then cannot call this skill");
    }
  }
  if (text.includes("{{")) problems.push("SKILL.md still has {{placeholders}}");
  if (/^Required level:/m.test(text) && !/^Required level:\s*L[0-5]\s*$/m.test(text)) {
    problems.push("`Required level:` must read L0 to L5 (e.g. `Required level: L3`)");
  }
  let last = -1;
  for (const heading of SECTIONS) {
    const at = lineIndex(text, heading, false);
    if (at < 0) problems.push(`missing heading ${heading}`);
    else if (at < last) problems.push(`heading ${heading} is out of order`);
    else last = at;
  }
  const features = join(dir, "features");
  if (!existsSync(features) || !statSync(features).isDirectory()) {
    problems.push("features/ missing");
    return problems;
  }
  const readme = join(features, "README.md");
  if (!existsSync(readme)) problems.push("features/README.md missing");
  else if (readFileSync(readme, "utf8").includes("{{")) problems.push("features/README.md still has {{placeholders}}");
  const files = readdirSync(features).filter((f) => f.endsWith(".md") && f !== "README.md");
  if (files.length === 0) problems.push("features/ has no feature file besides README.md");
  for (const file of files) {
    const body = readFileSync(join(features, file), "utf8");
    if (body.includes("{{")) problems.push(`${file} still has {{placeholders}}`);
    let prev = -1;
    for (const [label, prefix] of FEATURE_H2) {
      const at = lineIndex(body, label, prefix);
      if (at < 0) problems.push(`${file} missing heading ${label.trim()}`);
      else if (at < prev) problems.push(`${file} heading ${label.trim()} is out of order`);
      else prev = at;
    }
  }
  return problems;
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(join(process.cwd(), arg)).href
      || import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node \"<this skill dir>/scripts/check-verify-skill.mjs\" <verify-dir>");
    process.exit(2);
  }
  const problems = checkVerifySkill(dir);
  for (const w of verifySkillWarnings(dir)) console.error(`warning: ${w}`);
  if (problems.length) {
    console.log(problems.join("\n"));
    process.exit(1);
  }
  console.log("ok");
}
