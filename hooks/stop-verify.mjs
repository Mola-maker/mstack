#!/usr/bin/env node
// Stop hook: opt-in reminder (m-verify). When `.mstack/verify/gate` exists in the project and the current
// code has no verify receipt at the required level, show the user one `systemMessage` line.
// Never blocks: no `decision`, no `continue: false`, always exit 0, and any error prints nothing.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const receipt = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "m-verify", "scripts", "receipt.mjs");

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

  const reason = (() => {
    try {
      execFileSync(process.execPath, [receipt, "check"], { cwd: root, encoding: "utf8", timeout: 6000, stdio: ["ignore", "pipe", "ignore"] });
      return null;
    } catch (e) {
      return e.status === 1 ? String(e.stdout ?? "").trim() : null; // exit 2 or a crash: stay silent
    }
  })();
  if (reason) process.stdout.write(`${JSON.stringify({ systemMessage: reason })}\n`);
} catch {
  // Never block the stop.
}
process.exit(0);
