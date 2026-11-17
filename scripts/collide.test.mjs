import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collisions, loadSkills, routingText, terms } from "./collide.mjs";

const skill = (dir, name, description, when) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: "${name}"\ndescription: "${description}"\nwhen_to_use: "${when ?? ""}"\n---\n\n# ${name}\n`);
};

test("routingText takes description and when_to_use, quotes stripped; no frontmatter gives nothing", () => {
  assert.equal(routingText('---\nname: "a"\ndescription: "Fix bugs"\nwhen_to_use: "A test fails"\n---\nbody'), "Fix bugs A test fails");
  assert.equal(routingText("# no frontmatter"), "");
  assert.equal(routingText('---\ndescription: "x"\nwhenToUse: "y"\n---\n'), "x y");
});

test("terms: words of 3+ letters without stop words, and CJK pairs", () => {
  assert.deepEqual(terms("Use the debug skill for a failing test"), ["debug", "failing", "test"]);
  assert.deepEqual(terms("一直做到完成"), ["一直", "直做", "做到", "到完", "完成"]);
});

test("a skill that says the same thing under another name is the top pair; an unrelated one is below the bar", () => {
  const a = mkdtempSync(join(tmpdir(), "collide-a-"));
  const b = mkdtempSync(join(tmpdir(), "collide-b-"));
  skill(a, "m-debug", "Root-cause a failing test or crash: reproduce, hypothesis, regression test.", "A test fails or a crash needs a root cause");
  skill(a, "m-ship", "Open a pull request and watch CI.", "Ship a branch");
  skill(b, "trace", "Find the root cause of a failing test or crash by reproducing it and testing hypotheses.", "failing test, crash, root cause");
  skill(b, "wiki", "A cross-session knowledge base of notes.", "remember things");
  const pairs = collisions(loadSkills(a), loadSkills(b), { min: 0.1 });
  assert.equal(pairs[0].mine, "m-debug");
  assert.equal(pairs[0].theirs, "trace");
  assert.ok(pairs[0].score > 0.4, String(pairs[0].score));
  assert.ok(pairs[0].shared.includes("root") || pairs[0].shared.includes("failing"));
  assert.ok(!pairs.some((p) => p.mine === "m-ship" && p.theirs === "wiki" && p.score > pairs[0].score));
  assert.deepEqual(collisions(loadSkills(a), loadSkills(b), { min: 0.99 }), []);
});

test("our own repo loads: 17 skills with routing text", () => {
  assert.equal(loadSkills(fileURLToPath(new URL("../skills", import.meta.url))).length, 17);
});
