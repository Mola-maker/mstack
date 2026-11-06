#!/usr/bin/env node
// SessionStart hook, matcher `compact` (m-handoff). If .mstack/handoff.md exists,
// emits one line of additionalContext telling the model to read it. Never uses the
// network; exits 0 on any error with a silent payload so the session always starts.
import { existsSync } from "node:fs";
import { join } from "node:path";

const silent = () => console.log(JSON.stringify({ continue: true, suppressOutput: true }));

try {
  let cwd = process.cwd();
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  await new Promise((resolve) => process.stdin.on("end", resolve).on("error", resolve));
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof payload?.cwd === "string" && payload.cwd) cwd = payload.cwd;
  } catch { /* stdin empty or not JSON — fall back to process.cwd() */ }

  const file = join(cwd, ".mstack", "handoff.md");
  if (!existsSync(file)) { silent(); process.exit(0); }

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `mstack: .mstack/handoff.md exists — read it before doing anything else (m-handoff).`,
    },
  }));
} catch {
  silent();
}
process.exit(0);
