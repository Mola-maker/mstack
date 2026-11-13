#!/usr/bin/env node
// Stop hook: opt-in reminder (m-verify). When `.mstack/verify/gate` exists in the project and the current
// code has no verify receipt at the required level, show the user one `systemMessage` line. If the check
// itself fails or runs out of time, say so in one line instead of going quiet.
// Never blocks: no `decision`, no `continue: false`, always exit 0. Gate absent: no output at all.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const receipt = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "m-verify", "scripts", "receipt.mjs");
// hooks.json gives the hook 10 s: 3 s for the git lookup, then the script's own deadline, then a margin to exit and clean up
const DEADLINE = process.env.MSTACK_STOP_VERIFY_TIMEOUT_MS ?? "4000";

const say = (message) => process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
const oneLine = (s) => String(s ?? "").trim().split("\n")[0].replace(/^receipt:\s*/, "");

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
  if (!existsSync(join(root, ".mstack", "verify", "gate"))) process.exit(0);

  if (!existsSync(receipt)) {
    say(`verify gate could not be evaluated: receipt script missing at ${receipt}`);
    process.exit(0);
  }
  try {
    execFileSync(process.execPath, [receipt, "check", "--timeout-ms", DEADLINE], {
      cwd: root, encoding: "utf8", timeout: (Number(DEADLINE) || 4000) + 2000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (e.status === 1 && oneLine(e.stdout)) say(oneLine(e.stdout));
    else if (e.code === "ETIMEDOUT") say(`verify gate could not be evaluated: the check did not finish within ${(Number(DEADLINE) || 4000) + 2000} ms`);
    else say(`verify gate could not be evaluated: ${oneLine(e.stderr) || `${receipt} failed with exit ${e.status ?? "none"}`}`);
  }
} catch {
  // Never block the stop. (Reached only before the gate file is known: no git repo, unreadable cwd.)
}
process.exit(0);
