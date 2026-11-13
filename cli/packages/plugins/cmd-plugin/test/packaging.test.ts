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
  // isolate HOME: the plan depends on what already exists in ~/.dsh and ~/.codex
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mola-userhome-"));
  const prev = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  let code: number;
  try {
    code = await commandOf(f, "skills install").handler(
      { positionals: [], flags: { "dry-run": true } },
      io,
    );
  } finally {
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
    if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
  }
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

// ------------------------------------------------- copy mode, stamps, status

import { applySkillEntry, hashDir, planSkills, readStamp, skillsStatus, STAMP_FILE } from "../src/skills.js";

test("skills install --copy: dsh gets stamped copies; a second plan keeps them; an edited source replaces", () => {
  const root = fakeMstack();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mola-userhome-"));
  const first = planSkills({ root, targets: ["dsh"], home, copy: true });
  assert.ok(first.entries.length >= 2);
  for (const e of first.entries) { assert.equal(e.mode, "copy"); assert.equal(e.action, "create"); applySkillEntry(e); }
  const dest = path.join(home, ".dsh", "skills", "m-start");
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
  assert.ok(fs.existsSync(path.join(dest, "SKILL.md")));
  assert.equal(readStamp(dest)?.hash, hashDir(path.join(root, "skills", "m-start")));
  for (const e of planSkills({ root, targets: ["dsh"], home, copy: true }).entries) assert.equal(e.action, "keep", e.name);

  fs.appendFileSync(path.join(root, "skills", "m-start", "SKILL.md"), "\nnew line\n");
  const again = planSkills({ root, targets: ["dsh"], home, copy: true }).entries;
  assert.equal(again.find((e) => e.name === "m-start")?.action, "replace");
  assert.equal(again.find((e) => e.name === "m-ship")?.action, "keep");
});

test("skills: a copied directory with no stamp is replaced, not kept forever", () => {
  const root = fakeMstack();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mola-userhome-"));
  const dest = path.join(home, ".codex", "skills", "m-start");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "SKILL.md"), "an old copy\n");
  const e = planSkills({ root, targets: ["codex"], home }).entries.find((x) => x.name === "m-start");
  assert.equal(e?.action, "replace");
  applySkillEntry(e!);
  assert.notEqual(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"), "an old copy\n");
});

test("skills: the hash ignores line endings and the stamp file", () => {
  const root = fakeMstack();
  const dir = path.join(root, "skills", "m-start");
  const before = hashDir(dir);
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
  fs.writeFileSync(path.join(dir, STAMP_FILE), "{}");
  assert.equal(hashDir(dir), before);
});

test("skills status: missing, then current, then stale after the source changes", () => {
  const root = fakeMstack();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mola-userhome-"));
  let s = skillsStatus({ root, target: "dsh", home });
  assert.equal(s.missing.length, s.total);
  for (const e of planSkills({ root, targets: ["dsh"], home, copy: true }).entries) applySkillEntry(e);
  s = skillsStatus({ root, target: "dsh", home });
  assert.equal(s.current.length, s.total);
  fs.appendFileSync(path.join(root, "skills", "m-ship", "SKILL.md"), "\nchanged\n");
  s = skillsStatus({ root, target: "dsh", home });
  assert.deepEqual(s.stale, ["m-ship"]);
});
