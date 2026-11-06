// Tests for the plugin hooks. Run: node --test "hooks/*.test.mjs"
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const run = (script, { cwd, stdin = "" } = {}) => {
  try {
    return { out: execFileSync(process.execPath, [join(here, script)], { cwd, input: stdin, encoding: "utf8", timeout: 5000 }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout ?? ""), code: e.status };
  }
};

test("hooks.json matches the verified plugin schema", () => {
  const cfg = JSON.parse(readFileSync(join(here, "hooks.json"), "utf8"));
  const pre = cfg.hooks.PreCompact[0];
  if (pre.matcher !== "*") throw new Error(`PreCompact matcher ${pre.matcher}`);
  if (!pre.hooks[0].command.includes('node "${CLAUDE_PLUGIN_ROOT}/hooks/precompact.mjs"')) throw new Error(pre.hooks[0].command);
  const ss = cfg.hooks.SessionStart[0];
  if (ss.matcher !== "compact") throw new Error(`SessionStart matcher ${ss.matcher}`);
  if (!ss.hooks[0].command.includes('node "${CLAUDE_PLUGIN_ROOT}/hooks/session-compact.mjs"')) throw new Error(ss.hooks[0].command);
});

test("precompact appends a snapshot and never overwrites", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "x\n");
  mkdirSync(join(dir, ".mstack", "goals"), { recursive: true });
  writeFileSync(join(dir, ".mstack", "goals", "g.md"), "# goal\n");
  writeFileSync(join(dir, ".mstack", "handoff.md"), "# existing handoff\n\n## Progress\nkeep me\n");

  const r = run("precompact.mjs", { cwd: dir, stdin: JSON.stringify({ cwd: dir }) });
  if (r.code !== 0) throw new Error(`exit ${r.code}`);
  const text = readFileSync(join(dir, ".mstack", "handoff.md"), "utf8");
  if (!text.startsWith("# existing handoff")) throw new Error("existing content was overwritten");
  if (!text.includes("keep me")) throw new Error("existing section lost");
  if (!text.includes("## Auto snapshot")) throw new Error("no snapshot appended");
  if (!text.includes("- goal: none")) throw new Error(`a goal without a state file must not count as active:\n${text}`);

  const before = text;
  const r2 = run("precompact.mjs", { cwd: dir, stdin: "{not json" });
  if (r2.code !== 0) throw new Error(`second run exit ${r2.code}`);
  const after = readFileSync(join(dir, ".mstack", "handoff.md"), "utf8");
  if (!after.startsWith("# existing handoff") || !after.includes("keep me")) throw new Error("second run rewrote earlier content");
  const snapshots = after.match(/^## Auto snapshot/gm) ?? [];
  if (snapshots.length !== 1) throw new Error(`expected the snapshot replaced, found ${snapshots.length} sections`);
  if (!after.includes(before.slice(before.indexOf("- branch:")))) throw new Error("snapshot content lost on replace");
  if (after.length >= before.length + "## Auto snapshot".length) throw new Error("second run grew the file instead of replacing");
});

test("precompact never creates .mstack/ in a project that does not use mstack", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  const r = run("precompact.mjs", { cwd: dir, stdin: "" });
  if (r.code !== 0) throw new Error(`exit ${r.code}`);
  if (existsSync(join(dir, ".mstack"))) throw new Error("created .mstack/ in a non-mstack project");
});

test("precompact exits 0 and writes nothing outside cwd when git is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  mkdirSync(join(dir, ".mstack"));
  const r = run("precompact.mjs", { cwd: dir, stdin: JSON.stringify({ cwd: dir }) });
  if (r.code !== 0) throw new Error(`exit ${r.code}`);
  const text = readFileSync(join(dir, ".mstack", "handoff.md"), "utf8");
  if (!text.includes("(not a git repo)")) throw new Error(`expected non-git note:\n${text}`);
});

test("a repo with no commits is labelled (no commits yet), not (not a git repo) (bug regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".mstack"));
  const r = run("precompact.mjs", { cwd: dir, stdin: JSON.stringify({ cwd: dir }) });
  if (r.code !== 0) throw new Error(`exit ${r.code}`);
  const text = readFileSync(join(dir, ".mstack", "handoff.md"), "utf8");
  if (!text.includes("(no commits yet)")) throw new Error(`expected no-commits label:\n${text}`);
  if (text.includes("(not a git repo)")) throw new Error("an empty repo is still a git repo");
});

test("the goal is the newest one whose state.json says status active (bug regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "x\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  const goals = join(dir, ".mstack", "goals");
  mkdirSync(goals, { recursive: true });
  writeFileSync(join(goals, "old.md"), "# old\n");
  writeFileSync(join(goals, "old.state.json"), '{"status":"done"}\n');
  writeFileSync(join(goals, "live.md"), "# live\n");
  writeFileSync(join(goals, "live.state.json"), '{"status":"active"}\n');
  // The closed goal is touched last, so mtime alone would pick it wrongly.
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(goals, "old.md"), later, later);

  const r = run("precompact.mjs", { cwd: dir, stdin: JSON.stringify({ cwd: dir }) });
  if (r.code !== 0) throw new Error(`exit ${r.code}`);
  const text = readFileSync(join(dir, ".mstack", "handoff.md"), "utf8");
  if (!text.includes(`- goal: ${join(goals, "live.md")}`)) throw new Error(`active goal not picked:\n${text}`);
  if (text.includes("old.md")) throw new Error("a closed goal was picked");
});

test("session-compact reminds only when a handoff exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  const none = run("session-compact.mjs", { cwd: dir, stdin: JSON.stringify({ cwd: dir }) });
  if (none.code !== 0) throw new Error(`exit ${none.code}`);
  const noneJson = JSON.parse(none.out);
  if (!noneJson.suppressOutput) throw new Error(`expected silent payload: ${none.out}`);

  mkdirSync(join(dir, ".mstack"));
  writeFileSync(join(dir, ".mstack", "handoff.md"), "# h\n");
  const some = run("session-compact.mjs", { cwd: dir, stdin: JSON.stringify({ cwd: dir }) });
  if (some.code !== 0) throw new Error(`exit ${some.code}`);
  const j = JSON.parse(some.out);
  if (j.hookSpecificOutput?.hookEventName !== "SessionStart") throw new Error(`bad payload: ${some.out}`);
  if (!j.hookSpecificOutput.additionalContext.includes(".mstack/handoff.md")) throw new Error(`no reminder: ${some.out}`);
  if (!existsSync(join(dir, ".mstack", "handoff.md"))) throw new Error("handoff was removed");
});

test("both scripts exit 0 on garbage stdin and a missing cwd", () => {
  for (const script of ["precompact.mjs", "session-compact.mjs"]) {
    const r = run(script, { stdin: JSON.stringify({ cwd: join(tmpdir(), "does-not-exist-xyz") }) });
    if (r.code !== 0) throw new Error(`${script} exit ${r.code}`);
  }
});
