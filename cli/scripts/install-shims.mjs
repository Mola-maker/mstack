#!/usr/bin/env node
// Put a `mola` command on PATH that runs this checkout's build (cli/packages/mola/dist/bin.js).
// Windows: mola.cmd + mola.ps1 + mola (Git Bash) in %APPDATA%\npm (already on PATH).
// Linux/WSL: /usr/local/bin/mola (or ~/.local/bin/mola when not root).
// Usage: node cli/scripts/install-shims.mjs [--dir <bin dir>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "mola", "dist", "bin.js");
if (!fs.existsSync(bin)) {
  console.error(`mola is not built yet: ${bin} is missing (run: cd cli && pnpm install && pnpm -r build)`);
  process.exit(66);
}
const dirArg = process.argv.indexOf("--dir");
const written = [];
const write = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  written.push(file);
};
if (process.platform === "win32") {
  const dir = dirArg > 0 ? process.argv[dirArg + 1] : path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "npm");
  write(path.join(dir, "mola.cmd"), `@echo off\r\nnode "${bin}" %*\r\n`);
  write(path.join(dir, "mola.ps1"), `& node "${bin}" @args\r\nexit $LASTEXITCODE\r\n`);
  write(path.join(dir, "mola"), `#!/bin/sh\nexec node "$(cygpath -u '${bin}' 2>/dev/null || echo '${bin}')" "$@"\n`, 0o755);
} else {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const dir = dirArg > 0 ? process.argv[dirArg + 1] : isRoot ? "/usr/local/bin" : path.join(os.homedir(), ".local", "bin");
  write(path.join(dir, "mola"), `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`, 0o755);
}
console.log(`mola shims → ${bin}\n${written.map((f) => "  " + f).join("\n")}`);
