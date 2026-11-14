#!/usr/bin/env node
/**
 * Standalone statusLine entry: `node statusline-bin.js [--wrap "<cmd>"]`.
 * Same output as `mola statusline`, without booting every mola plugin
 * (the full CLI takes seconds; a status line has a few hundred ms).
 */
import { readStdin, renderStatusline } from "./statusline.js";

try {
  const i = process.argv.indexOf("--wrap");
  const wrap = i >= 0 ? process.argv[i + 1] : undefined;
  // Claude Code renders ANSI in the status line; stdout is a pipe there, so colour is on unless the user opted out.
  const color = !process.env.NO_COLOR && !process.env.MOLA_NO_COLOR;
  const out = renderStatusline({ stdin: await readStdin(), cwd: process.cwd(), color, ...(wrap ? { wrap } : {}) });
  if (out) process.stdout.write(out + "\n");
} catch {
  // never fail the host
}
process.exit(0);
