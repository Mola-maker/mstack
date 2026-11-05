/**
 * cmd-plugin tests — the packaging conveniences (B2): `mola skills install`,
 * `mola completions <shell>` and `mola version`.
 *
 * Nothing here touches the real home directory: the skills targets are
 * redirected into a tmp dir, and the mstack repo root is a tmp fixture with
 * the same shape (skills/<name>/SKILL.md + .claude-plugin/plugin.json).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import plugin from "../src/index.js";
import { commandOf, errOf, makeFakeCtx, makeIo } from "./helpers.js";

function activate(config: Record<string, unknown> = {}) {
  const f = makeFakeCtx({ config });
  plugin.activate(f.ctx);
  return f;
}

/** A fake mstack repo: skills/<name>/SKILL.md + .claude-plugin/plugin.json. */
function fakeMstack(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mola-mstack-"));
  fs.mkdirSync(path.join(root, "skills", "m-start"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "m-start", "SKILL.md"),
    "---\nname: m-start\ndescription: router\nwhenToUse: always\n---\n\nbody\n",
  );
  fs.mkdirSync(path.join(root, "skills", "m-ship"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "m-ship", "SKILL.md"),
    "---\nname: m-ship\ndescription: ship\nwhenToUse: at the end\n---\n\nbody\n",
  );
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "mstack", version: "0.3.1" }),
  );
  return root;
}

// ------------------------------------------------------------ skills install

test("skills install --dry-run plans the dsh symlinks and the codex copies", async () => {
  const root = fakeMstack();
  const f = activate({ "skills.source": root });
  const io = makeIo({ yes: true });
  const code = await commandOf(f, "skills install").handler(
    { positionals: [], flags: { "dry-run": true } },
    io,
  );
  assert.equal(code, 0);
  const data = io.dataValue as any;
  assert.equal(data.dryRun, true);
  const dsh = data.entries.filter((e: any) => e.target === "dsh");
  const codex = data.entries.filter((e: any) => e.target === "codex");
  assert.equal(dsh.length, 2);
  assert.equal(codex.length, 2);
  assert.equal(dsh[0].mode, "symlink");
  assert.equal(codex[0].mode, "copy");
  assert.equal(dsh[0].action, "create");
});

test("skills install --dry-run writes nothing to the target dirs", async () => {
  const root = fakeMstack();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mola-userhome-"));
  const f = activate({ "skills.source": root });
  const prevHome = process.env.USERPROFILE;
  const prevUnixHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    await commandOf(f, "skills install").handler(
      { positionals: [], flags: { "dry-run": true } },
      makeIo({ yes: true }),
    );
    assert.equal(fs.existsSync(path.join(home, ".dsh", "skills")), false);
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills")), false);
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevHome;
    if (prevUnixHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevUnixHome;
  }
});

test("skills install --dsh creates a symlink per skill, --codex copies them", async () => {
  const root = fakeMstack();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mola-userhome-"));
  const f = activate({ "skills.source": root });
  const prevHome = process.env.USERPROFILE;
  const prevUnixHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    await commandOf(f, "skills install").handler(
      { positionals: [], flags: { dsh: true } },
      makeIo({ yes: true }),
    );
    const link = path.join(home, ".dsh", "skills", "m-start");
    assert.ok(fs.existsSync(link), "the dsh skill link exists");
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "dsh uses a symlink");
    assert.equal(fs.readFileSync(path.join(link, "SKILL.md"), "utf8").includes("m-start"), true);

    await commandOf(f, "skills install").handler(
      { positionals: [], flags: { codex: true } },
      makeIo({ yes: true }),
    );
    const copy = path.join(home, ".codex", "skills", "m-ship");
    assert.ok(fs.existsSync(path.join(copy, "SKILL.md")), "the codex skill copy exists");
    assert.equal(fs.lstatSync(copy).isSymbolicLink(), false, "codex uses a copy");
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevHome;
    if (prevUnixHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevUnixHome;
  }
});

test("skills install --claude prints the marketplace line instead of copying", async () => {
  const root = fakeMstack();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mola-userhome-"));
  const f = activate({ "skills.source": root });
  const prevHome = process.env.USERPROFILE;
  const prevUnixHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const io = makeIo({ yes: true });
    const code = await commandOf(f, "skills install").handler(
      { positionals: [], flags: { claude: true } },
      io,
    );
    assert.equal(code, 0);
    const data = io.dataValue as any;
    assert.equal(data.claudeHint, "claude plugin marketplace add Mola-maker/mstack");
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0].target, "claude");
    assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "m-start")), false);
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevHome;
    if (prevUnixHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevUnixHome;
  }
});

test("skills install without a reachable mstack repo is a 66", async () => {
  const f = activate({ "skills.source": path.join(os.tmpdir(), "no-such-mstack-repo") });
  const err = errOf(
    await commandOf(f, "skills install")
      .handler({ positionals: [], flags: { "dry-run": true } }, makeIo({ yes: true }))
      .catch((e) => e),
  );
  assert.equal(err.code, "NO_INPUT");
  assert.equal(err.exitCode, 66);
});

// ---------------------------------------------------------------- completions

test("completions bash prints a script that completes the command names", async () => {
  const f = activate();
  const io = makeIo();
  const code = await commandOf(f, "completions").handler({ positionals: ["bash"], flags: {} }, io);
  assert.equal(code, 0);
  const script = io.outLines.join("\n");
  assert.match(script, /complete -F _mola_complete mola/);
  assert.match(script, /"plugin install"/);
  assert.match(script, /"skills install"/);
});

test("completions zsh and pwsh render their own syntax", async () => {
  const f = activate();
  const zsh = makeIo();
  await commandOf(f, "completions").handler({ positionals: ["zsh"], flags: {} }, zsh);
  assert.match(zsh.outLines.join("\n"), /#compdef mola/);

  const pwsh = makeIo();
  await commandOf(f, "completions").handler({ positionals: ["pwsh"], flags: {} }, pwsh);
  assert.match(pwsh.outLines.join("\n"), /Register-ArgumentCompleter/);
});

test("completions with an unknown shell is a 64, without a shell a 64", async () => {
  const f = activate();
  const err = errOf(
    await commandOf(f, "completions")
      .handler({ positionals: ["fish"], flags: {} }, makeIo())
      .catch((e) => e),
  );
  assert.equal(err.code, "USAGE_ERROR");
  assert.equal(err.exitCode, 64);

  const err2 = errOf(
    await commandOf(f, "completions")
      .handler({ positionals: [], flags: {} }, makeIo())
      .catch((e) => e),
  );
  assert.equal(err2.exitCode, 64);
});

// -------------------------------------------------------------------- version

test("version reports mola, core, the skills version and the plugin set", async () => {
  const root = fakeMstack();
  const f = activate({ "skills.source": root });
  const io = makeIo();
  const code = await commandOf(f, "version").handler({ positionals: [], flags: {} }, io);
  assert.equal(code, 0);
  const data = io.dataValue as any;
  assert.equal(data.mola, "0.1.0");
  assert.equal(data.core, "0.1.0");
  assert.equal(data.skills, "0.3.1", "the skills version comes from .claude-plugin/plugin.json");
  assert.ok(Array.isArray(data.plugins));
});

test("version reports a null skills version when the repo is not reachable", async () => {
  const f = activate({ "skills.source": path.join(os.tmpdir(), "no-such-mstack-repo") });
  const io = makeIo();
  await commandOf(f, "version").handler({ positionals: [], flags: {} }, io);
  const data = io.dataValue as any;
  assert.equal(data.skills, null);
});
