// stop-verify.mjs when the receipt check itself fails or is too slow. Run: node --test "hooks/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("./stop-verify.mjs", import.meta.url));

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
};
function repo({ gate }) {
  const dir = mkdtempSync(join(tmpdir(), "stop-verify-f-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  if (gate) {
    mkdirSync(join(dir, ".mstack", "verify"), { recursive: true });
    writeFileSync(join(dir, ".mstack", "verify", "gate"), "");
  }
  return dir;
}
const run = (dir, env = {}) =>
  spawnSync(process.execPath, [hook], { cwd: dir, input: JSON.stringify({ hook_event_name: "Stop", cwd: dir }), encoding: "utf8", env: { ...process.env, ...env } });

test("gate on and the check times out: a non-blocking systemMessage says it could not be evaluated and why", () => {
  const dir = repo({ gate: true });
  const r = run(dir, { MSTACK_STOP_VERIFY_TIMEOUT_MS: "1" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, /could not be evaluated/);
  assert.match(out.systemMessage, /timed out after 1 ms/);
  assert.equal(out.systemMessage.includes("\n"), false, "one line");
  for (const k of ["decision", "reason", "continue", "stopReason", "hookSpecificOutput"]) assert.equal(k in out, false, `must not set ${k}`);
  const tmp = join(dir, ".git", "mstack-tmp");
  assert.deepEqual(existsSync(tmp) ? readdirSync(tmp) : [], []);
});

test("gate absent: still fully silent even when the check would time out", () => {
  const r = run(repo({ gate: false }), { MSTACK_STOP_VERIFY_TIMEOUT_MS: "1" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("gate on and the check crashes: systemMessage with the error, exit 0", () => {
  const dir = repo({ gate: true });
  // an invalid timeout value makes receipt.mjs exit 2 with an error line
  const r = run(dir, { MSTACK_STOP_VERIFY_TIMEOUT_MS: "not-a-number" });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /could not be evaluated: .*timeout-ms/);
});
