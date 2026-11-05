import * as path from "node:path";
/**
 * The pnpm forwarding (core §5 install step 2). The argv shape is checked
 * against pnpm's own documented CLI (`pnpm --dir <DIR> add <spec>`; `-C,
 * --dir <DIR>`: "Set working directory"); no package manager is ever run in
 * a test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { onWindows, pnpmArgv, pnpmCommandLine, pnpmInstallDir } from "../src/pnpm.js";

test("pnpmArgv: the documented pnpm shape — --dir <install dir> add <spec>", () => {
  const argv = pnpmArgv({ installDir: "/home/u/.mola/plugins", spec: "some-plugin" });
  assert.deepEqual(argv, ["pnpm", "--dir", "/home/u/.mola/plugins", "add", "some-plugin"]);
});

test("pnpmArgv: --save-dev and --save-exact are forwarded verbatim", () => {
  const argv = pnpmArgv({
    installDir: "/d",
    spec: "s@^1.0.0",
    dev: true,
    exact: true,
  });
  assert.deepEqual(argv, ["pnpm", "--dir", "/d", "add", "s@^1.0.0", "--save-dev", "--save-exact"]);
});

test("pnpmArgv: on Windows the .cmd shim is reached through cmd.exe", () => {
  const argv = pnpmArgv({ installDir: "C:\\u\\.mola\\plugins", spec: "s", windows: true });
  assert.deepEqual(argv, ["cmd", "/d", "/c", "pnpm", "--dir", "C:\\u\\.mola\\plugins", "add", "s"]);
});

test("pnpmCommandLine: the printable form quotes the paths with spaces", () => {
  const line = pnpmCommandLine(["pnpm", "--dir", "/home/my user/.mola/plugins", "add", "s"]);
  assert.equal(line, 'pnpm --dir "/home/my user/.mola/plugins" add s');
});

test("onWindows honours MOLA_PLATFORM (the platform override rule)", () => {
  assert.equal(onWindows({ MOLA_PLATFORM: "win32" } as NodeJS.ProcessEnv), true);
  assert.equal(onWindows({ MOLA_PLATFORM: "linux" } as NodeJS.ProcessEnv), false);
});

test("pnpmInstallDir: the install directory is ~/.mola/plugins", () => {
  assert.equal(pnpmInstallDir("/home/u/.mola"), path.join("/home/u/.mola", "plugins"));
});
