// Tests for check-pretool.mjs. Run: node --test "skills/m-guard/scripts/*.test.mjs"
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "./check-pretool.mjs";

const script = new URL("./check-pretool.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const branches = { lookupGit: false, defaultBranch: "main", currentBranch: "feature", home: "/home/mola" };
const bash = (command, extra = {}) => evaluate(
  { tool_name: "Bash", cwd: "/proj", tool_input: { command } },
  { ...branches, ...extra },
);

test("recursive delete of / or home asks; a subdirectory does not", () => {
  for (const command of ["rm -rf /", "rm -fr ~", "rm -r $HOME", "rm -rf /home/mola", "sudo rm -rf /*", "bash -c 'rm -rf /'"]) {
    const hit = bash(command);
    if (!hit) throw new Error(`expected ask: ${command}`);
    if (!hit.reason.startsWith("m-guard:")) throw new Error(hit.reason);
  }
  for (const command of ["rm -rf /tmp/build", "rm -rf ~/proj", "rm -rf node_modules", "rm /"]) {
    if (bash(command)) throw new Error(`expected no ask: ${command}`);
  }
});

test("force-push to the default branch asks; lease and other branches do not", () => {
  const ask = [
    "git push --force origin main",
    "git push -f origin HEAD:main",
    "git push origin +main",
    "git push --force-with-lease origin +refs/heads/main",
  ];
  for (const command of ask) if (!bash(command)) throw new Error(`expected ask: ${command}`);
  const ok = [
    "git push --force-with-lease origin main",
    "git push --force origin feature",
    "git push origin main",
    "git push --force",
  ];
  for (const command of ok) if (bash(command)) throw new Error(`expected no ask: ${command}`);
  const onMain = bash("git push --force origin", { currentBranch: "main" });
  if (!onMain) throw new Error("expected ask when the current branch is the default");
  const unknown = bash("git push --force origin feature", { defaultBranch: null });
  if (!unknown) throw new Error("expected ask when the default branch is unknown");
});

test("freeze allows only the listed prefixes", () => {
  const opts = { lookupGit: false, freezeText: "src/\n# note\n", canonical: (p) => p, cwd: "/proj" };
  const edit = (file_path) => evaluate({ tool_name: "Edit", cwd: "/proj", tool_input: { file_path } }, opts);
  if (edit("/proj/src/a.ts")) throw new Error("inside prefix should pass");
  if (!edit("/proj/src-old/a.ts")) throw new Error("/src must not match /src-old");
  if (!edit("C:\\proj\\other\\a.ts")) throw new Error("outside should ask");
  const win = evaluate(
    { tool_name: "Write", tool_input: { file_path: "C:\\proj\\src\\a.ts" } },
    { lookupGit: false, freezeText: "C:\\proj\\src", canonical: (p) => p, cwd: "C:/proj" },
  );
  if (win) throw new Error(`windows prefix should pass: ${win.reason}`);
  const off = evaluate(
    { tool_name: "Edit", cwd: "/proj", tool_input: { file_path: "/etc/passwd" } },
    { lookupGit: false, freezeText: "", canonical: (p) => p },
  );
  if (off) throw new Error("empty freeze file is not a freeze");
});

test("freeze never blocks writes under .mstack/ (bug regression: closeout must stay writable)", () => {
  const opts = { lookupGit: false, freezeText: "src/api\n", canonical: (p) => p, cwd: "/proj" };
  const edit = (file_path) => evaluate({ tool_name: "Edit", cwd: "/proj", tool_input: { file_path } }, opts);
  for (const path of ["/proj/.mstack/goals/demo.md", "/proj/.mstack/handoff.md", "/proj/.mstack/freeze", "/proj/.mstack/a/b/c.md"]) {
    const hit = edit(path);
    if (hit) throw new Error(`.mstack write should never ask: ${path} -> ${hit.reason}`);
  }
  if (!edit("/proj/.mstackx/g.md")) throw new Error("only .mstack/ itself is exempt, not .mstackx/");
  if (!edit("/proj/src/other.ts")) throw new Error("non-mstack path outside the prefixes should still ask");
});

test("stdin hook prints ask json and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "m-guard-"));
  mkdirSync(join(dir, ".mstack"));
  writeFileSync(join(dir, ".mstack", "freeze"), "allowed\n");
  const run = (event) => spawnSync(process.execPath, [script], {
    input: JSON.stringify(event),
    encoding: "utf8",
    cwd: dir,
  });
  const rm = run({ tool_name: "Bash", cwd: dir, tool_input: { command: "rm -rf /" } });
  if (rm.status !== 0) throw new Error(`exit ${rm.status}`);
  const body = JSON.parse(rm.stdout);
  if (body.hookSpecificOutput.permissionDecision !== "ask") throw new Error(rm.stdout);
  if (body.hookSpecificOutput.hookEventName !== "PreToolUse") throw new Error(rm.stdout);
  if (body.permissionDecision) throw new Error("decision must not be top-level");
  const safe = run({ tool_name: "Bash", cwd: dir, tool_input: { command: "npm test" } });
  if (safe.status !== 0 || safe.stdout.trim()) throw new Error(`expected silence, got ${safe.stdout}`);
  const outside = run({ tool_name: "Write", cwd: dir, tool_input: { file_path: join(dir, "nope.txt") } });
  if (outside.status !== 0 || !outside.stdout.includes('"ask"')) throw new Error(outside.stdout || outside.stderr);
});
