#!/usr/bin/env node
// Stop hook: opt-in reminder (m-verify). When `.mstack/verify/gate` exists in the project and the current
// code has no verify receipt at the required level, show the user one `systemMessage` line. If the check
// itself fails or runs out of time, say so in one line instead of going quiet.
// By default it never blocks: no `decision`, no `continue: false`, always exit 0. Gate absent: no output at all.
// Opt-in block mode: the first word in the gate file is `block`. Then a stop with code BELOW the required level is
// refused once per turn (`decision: "block"`, the reason names the gap and the command), so the agent has to prove it
// or say why not. Three limits keep it from becoming a trap: a check that could not run never blocks; a stop that is
// already continuing because of a hook never blocks again (`stop_hook_active`); and after MSTACK_STOP_VERIFY_MAX_BLOCKS
// (default 3) blocks in a row with no pass in between it falls back to the reminder and says so.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const receipt = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "m-verify", "scripts", "receipt.mjs");
// hooks.json gives the hook 10 s: 3 s for the git lookup, then the script's own deadline, then a margin to exit and clean up
const DEADLINE = process.env.MSTACK_STOP_VERIFY_TIMEOUT_MS ?? "4000";

const MAX_BLOCKS = Math.max(1, Number(process.env.MSTACK_STOP_VERIFY_MAX_BLOCKS) || 3);
const block = (reason) => process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
// blocks in a row so far, kept in the status file the hook already writes (so no new file for git to see)
const blocksSoFar = (root) => {
  try { return Math.max(0, Number(JSON.parse(readFileSync(join(root, ".mstack", "verify", "status.json"), "utf8")).blocks) || 0); } catch { return 0; }
};
const say = (message) => process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
const oneLine = (s) => String(s ?? "").trim().split("\n")[0].replace(/^receipt:\s*/, "");
// The status line shows this file instead of hashing the tree itself. ok: true = receipt at the required level,
// false = below it, null = the check could not run. A read-only checkout must not break the stop.
// The file is local state: it changes on every stop, so it is kept out of git by a .gitignore beside it, and the
// recorded message stops before the "run …" hint, which holds an absolute path of this machine.
const record = (root, ok, message, blocks = 0) => {
  const dir = join(root, ".mstack", "verify");
  // The verdict first, on its own: a .gitignore that cannot be written must not leave an old "ok" standing.
  try {
    const local = String(message).split("; run ")[0].split(receipt).join("receipt.mjs");
    writeFileSync(join(dir, "status.json"), `${JSON.stringify({ ts: new Date().toISOString(), ok, message: local, blocks })}\n`);
  } catch { /* nothing to do */ }
  try {
    const ignore = join(dir, ".gitignore");
    const have = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
    if (!have.split(/\r?\n/).includes("status.json")) appendFileSync(ignore, `${have && !have.endsWith("\n") ? "\n" : ""}status.json\n`);
  } catch { /* the file stays untracked-but-visible; the verdict is still current */ }
};

try {
  let cwd = process.cwd();
  let active = false;
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  await new Promise((resolve) => process.stdin.on("end", resolve).on("error", resolve));
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof payload?.cwd === "string" && payload.cwd) cwd = payload.cwd;
    active = payload?.stop_hook_active === true;
  } catch { /* empty or non-JSON stdin: use process.cwd() */ }

  // already continuing because of a stop hook: do not repeat the reminder
  if (active) process.exit(0);

  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  const gateFile = join(root, ".mstack", "verify", "gate");
  if (!existsSync(gateFile)) process.exit(0);
  let blockMode = false;
  try { blockMode = readFileSync(gateFile, "utf8").trim().split(/\s+/)[0] === "block"; } catch { /* unreadable gate: reminder mode */ }
  const prior = blocksSoFar(root);

  if (!existsSync(receipt)) {
    say(`verify gate could not be evaluated: receipt script missing at ${receipt}`);
    record(root, null, `receipt script missing at ${receipt}`);
    process.exit(0);
  }
  try {
    execFileSync(process.execPath, [receipt, "check", "--timeout-ms", DEADLINE], {
      cwd: root, encoding: "utf8", timeout: (Number(DEADLINE) || 4000) + 2000, stdio: ["ignore", "pipe", "pipe"],
    });
    record(root, true, "receipt at the required level", 0);
  } catch (e) {
    const below = e.status === 1 && oneLine(e.stdout);
    const message = below
      ? oneLine(e.stdout)
      : e.code === "ETIMEDOUT"
        ? `verify gate could not be evaluated: the check did not finish within ${(Number(DEADLINE) || 4000) + 2000} ms`
        : `verify gate could not be evaluated: ${oneLine(e.stderr) || `${receipt} failed with exit ${e.status ?? "none"}`}`;
    if (below && blockMode && prior < MAX_BLOCKS) {
      block(`${message}. This project's verify gate is in block mode: prove the current code at the required level (m-verify), or tell the user plainly that you could not.`);
      record(root, false, message, prior + 1);
    } else {
      say(below && blockMode ? `${message} (block limit ${MAX_BLOCKS} reached; reminding only)` : message);
      record(root, below ? false : null, message, prior);
    }
  }
} catch {
  // Never block the stop. (Reached only before the gate file is known: no git repo, unreadable cwd.)
}
process.exit(0);
