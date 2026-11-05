import * as os from "node:os";
/**
 * cmd-plugin tests — the plugin lifecycle (B2).
 *
 * Everything external is mocked or redirected: the mola home is a tmp dir
 * (MOLA_HOME), no process is spawned (the pnpm forward is printed, not run),
 * and the fixture plugin is a local directory that is copied, never activated
 * for real.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import plugin from "../src/index.js";
import { commandOf, copyFixture, errOf, makeFakeCtx, makeIo, tmpHome } from "./helpers.js";

// Windows runs npm CLIs through cmd.exe (.cmd shims): compare the command after the wrapper.
const unwrapCmd = (argv: string[]): string[] => (argv[0] === "cmd" ? argv.slice(argv.indexOf("/c") + 1) : argv);


function activate() {
  const f = makeFakeCtx();
  plugin.activate(f.ctx);
  return f;
}

/**
 * Run a block with MOLA_HOME pointed at a tmp dir. The env var is restored
 * only after the (async) block finished — otherwise the plugin would read a
 * home that is already gone.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = tmpHome();
  const prev = process.env.MOLA_HOME;
  process.env.MOLA_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.MOLA_HOME;
    else process.env.MOLA_HOME = prev;
  }
}

function registry(home: string): Record<string, any> {
  const file = path.join(home, "plugins.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ------------------------------------------------------------------ install

test("plugin install copies the tree, pins sha512 and records the untrusted tier", async () => {
  await withHome(async (home) => {
    const f = activate();
    const src = copyFixture();
    const io = makeIo({ yes: true });
    const code = await commandOf(f, "plugin install").handler(
      { positionals: [src], flags: {} },
      io,
    );
    assert.equal(code, 0);

    const data = io.dataValue as Record<string, any>;
    assert.equal(data.installed, true);
    assert.equal(data.id, "mola-fake-plugin");
    assert.equal(data.tier, "untrusted", "a local dir install is never verified");

    // the tree is in ~/.mola/plugins/<id>-<version>
    const installed = path.join(home, "plugins", "mola-fake-plugin-0.1.0");
    assert.ok(fs.existsSync(path.join(installed, "mola-plugin.json")));
    assert.ok(fs.existsSync(path.join(installed, "index.js")));

    // the registry records the pin, the grant and the tier
    const rec = registry(home)["mola-fake-plugin-0.1.0"];
    assert.equal(rec.id, "mola-fake-plugin");
    assert.equal(rec.tier, "untrusted");
    assert.equal(rec.enabled, true);
    assert.match(rec.sha512, /^[0-9a-f]{128}$/);
    assert.deepEqual(rec.permissions["env.read"], ["MOLA_*"]);
    assert.deepEqual(rec.permissions.mola, ["events", "commands", "config.read", "state.kv"]);
  });
});

test("the sha512 pin is the hash of the installed tree and changes with the content", async () => {
  await withHome(async (home) => {
    const f = activate();
    const src = copyFixture();
    await commandOf(f, "plugin install").handler({ positionals: [src], flags: {} }, makeIo({ yes: true }));
    const rec = registry(home)["mola-fake-plugin-0.1.0"];

    // recompute the pin the same way the loader does and compare
    const installed = path.join(home, "plugins", "mola-fake-plugin-0.1.0");
    const hash = createHash("sha512");
    for (const rel of ["index.js", "mola-plugin.json", "README.md"]) {
      hash.update(rel);
      hash.update("\n");
      const data = fs.readFileSync(path.join(installed, rel));
      hash.update(String(data.length));
      hash.update("\n");
      hash.update(data);
    }
    assert.equal(hash.digest("hex"), rec.sha512);

    // editing an installed file breaks the pin → `plugin doctor` reports it
    fs.writeFileSync(path.join(installed, "index.js"), "// tampered\n");
    const doctorIo = makeIo({ yes: true });
    const code = await commandOf(f, "plugin doctor").handler({ positionals: [], flags: {} }, doctorIo);
    assert.equal(code, 65);
    const problems = (doctorIo.dataValue as any).problems as Array<{ id: string; problem: string }>;
    assert.ok(
      problems.some((p) => p.problem.includes("sha512")),
      JSON.stringify(problems),
    );
  });
});

test("the permission diff is printed before the install and the grant is the diff target", async () => {
  await withHome(async () => {
    const f = activate();
    const src = copyFixture();
    const io = makeIo({ yes: true });
    await commandOf(f, "plugin install").handler({ positionals: [src], flags: {} }, io);

    // the human output lists every requested permission as an addition
    const printed = io.outLines.join("\n");
    assert.match(printed, /\+ fs\.read: ~\/\.mola\/\*\*/);
    assert.match(printed, /\+ env\.read: MOLA_\*/);
    assert.match(printed, /\+ mola: events/);

    // the machine payload carries the same diff
    const diff = (io.dataValue as any).diff;
    assert.equal(diff.escalates, true);
    assert.ok(diff.added.some((e: any) => e.permission === "env.read"));
  });
});

test("without --yes and without a TTY the install is refused (exit 77) and nothing is written", async () => {
  await withHome(async (home) => {
    const f = activate();
    const src = copyFixture();
    const io = makeIo({ yes: false });
    const err = errOf(
      await commandOf(f, "plugin install")
        .handler({ positionals: [src], flags: {} }, io)
        .catch((e) => e),
    );
    assert.equal(err.code, "POLICY_DENIED");
    assert.equal(err.exitCode, 77);
    assert.equal(fs.existsSync(path.join(home, "plugins", "mola-fake-plugin-0.1.0")), false);
    assert.deepEqual(registry(home), {});
  });
});

test("a directory without a manifest is a 65, a missing directory a 66", async () => {
  await withHome(async () => {
    const f = activate();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mola-empty-"));
    const err = errOf(
      await commandOf(f, "plugin install")
        .handler({ positionals: [empty], flags: {} }, makeIo({ yes: true }))
        .catch((e) => e),
    );
    assert.equal(err.exitCode, 65);
    assert.equal(err.code, "MANIFEST_INVALID");

    const err2 = errOf(
      await commandOf(f, "plugin install")
        .handler({ positionals: ["/definitely/not/here"], flags: {} }, makeIo({ yes: true }))
        .catch((e) => e),
    );
    assert.equal(err2.exitCode, 66);
    assert.equal(err2.code, "NO_INPUT");
  });
});

test("an npm spec is forwarded to pnpm (printed, never run)", async () => {
  await withHome(async (home) => {
    const f = activate();
    const io = makeIo({ yes: true });
    const code = await commandOf(f, "plugin install").handler(
      { positionals: ["some-npm-plugin"], flags: {} },
      io,
    );
    assert.equal(code, 0);
    const data = io.dataValue as Record<string, any>;
    assert.equal(data.forwardedTo, "pnpm");
    assert.equal(data.installed, false);
    assert.deepEqual(unwrapCmd(data.argv), ["pnpm", "--dir", path.join(home, "plugins"), "add", "some-npm-plugin"]);
    assert.equal(f.calls.length, 0, "mola never runs a package manager behind the user's back");
  });
});

test("an npm spec with --run executes the forwarded pnpm command", async () => {
  await withHome(async (home) => {
    const f = activate();
    const io = makeIo({ yes: true });
    const code = await commandOf(f, "plugin install").handler(
      { positionals: ["some-npm-plugin"], flags: { run: true } },
      io,
    );
    assert.equal(code, 0);
    assert.equal(f.calls.length, 1, "the forwarded command ran once");
    assert.equal(unwrapCmd(f.calls[0].argv)[0], "pnpm");
    assert.deepEqual(unwrapCmd(f.calls[0].argv).slice(1), ["--dir", path.join(home, "plugins"), "add", "some-npm-plugin"]);
    const data = io.dataValue as Record<string, any>;
    assert.equal(data.executed, true);
    assert.equal(data.exitCode, 0);
  });
});

// ------------------------------------------------------------------- update

test("plugin update re-runs the diff; a new permission needs a fresh confirmation", async () => {
  await withHome(async (home) => {
    const f = activate();
    const src = copyFixture();
    await commandOf(f, "plugin install").handler({ positionals: [src], flags: {} }, makeIo({ yes: true }));

    // the manifest now asks for one more permission
    const manifestPath = path.join(src, "mola-plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.permissions["net.connect"] = ["example.com:443"];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const io = makeIo({ yes: true });
    const code = await commandOf(f, "plugin update").handler(
      { positionals: ["mola-fake-plugin"], flags: {} },
      io,
    );
    assert.equal(code, 0);
    const printed = io.outLines.join("\n");
    assert.match(printed, /\+ net\.connect: example\.com:443/);
    const rec = registry(home)["mola-fake-plugin-0.1.0"];
    assert.deepEqual(rec.permissions["net.connect"], ["example.com:443"]);
    assert.notEqual(rec.sha512, undefined);
  });
});

test("plugin update of an unknown id is a 66", async () => {
  await withHome(async () => {
    const f = activate();
    const err = errOf(
      await commandOf(f, "plugin update")
        .handler({ positionals: ["nope"], flags: {} }, makeIo({ yes: true }))
        .catch((e) => e),
    );
    assert.equal(err.code, "PLUGIN_NOT_FOUND");
    assert.equal(err.exitCode, 66);
  });
});

// ------------------------------------------------------ remove/enable/disable

test("plugin remove deletes the files and the registry entry", async () => {
  await withHome(async (home) => {
    const f = activate();
    const src = copyFixture();
    await commandOf(f, "plugin install").handler({ positionals: [src], flags: {} }, makeIo({ yes: true }));
    const dir = path.join(home, "plugins", "mola-fake-plugin-0.1.0");
    assert.ok(fs.existsSync(dir));

    const io = makeIo({ yes: true });
    const code = await commandOf(f, "plugin remove").handler(
      { positionals: ["mola-fake-plugin"], flags: {} },
      io,
    );
    assert.equal(code, 0);
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(registry(home), {});
    assert.equal((io.dataValue as any).removed, true);
  });
});

test("plugin disable/enable flip the flag and never delete files", async () => {
  await withHome(async (home) => {
    const f = activate();
    const src = copyFixture();
    await commandOf(f, "plugin install").handler({ positionals: [src], flags: {} }, makeIo({ yes: true }));
    const dir = path.join(home, "plugins", "mola-fake-plugin-0.1.0");

    await commandOf(f, "plugin disable").handler(
      { positionals: ["mola-fake-plugin"], flags: {} },
      makeIo({ yes: true }),
    );
    assert.equal(registry(home)["mola-fake-plugin-0.1.0"].enabled, false);
    assert.ok(fs.existsSync(dir), "disable never deletes files");

    await commandOf(f, "plugin enable").handler(
      { positionals: ["mola-fake-plugin"], flags: {} },
      makeIo({ yes: true }),
    );
    assert.equal(registry(home)["mola-fake-plugin-0.1.0"].enabled, true);
    assert.ok(fs.existsSync(dir));
  });
});

test("enable/disable/remove of an unknown plugin is a 66", async () => {
  await withHome(async () => {
    const f = activate();
    for (const cmd of ["plugin enable", "plugin disable", "plugin remove"]) {
      const err = errOf(
        await commandOf(f, cmd)
          .handler({ positionals: ["nope"], flags: {} }, makeIo({ yes: true }))
          .catch((e) => e),
      );
      assert.equal(err.code, "PLUGIN_NOT_FOUND", cmd);
      assert.equal(err.exitCode, 66, cmd);
    }
  });
});

// ------------------------------------------------------------------- doctor

test("in --json mode the command writes no human notes (stderr stays clean)", async () => {
  await withHome(async () => {
    const f = activate();
    const src = copyFixture();
    const io = makeIo({ json: true, yes: true });
    await commandOf(f, "plugin install").handler({ positionals: [src], flags: {} }, io);
    assert.deepEqual(io.notes, [], "no note may reach stderr in --json mode");
    assert.deepEqual(io.outLines, [], "human stdout stays empty in --json mode");
    assert.ok((io.dataValue as any).installed);
  });
});

test("the lifecycle emits the ADR-0004 plugin events", async () => {
  await withHome(async () => {
    const f = activate();
    const src = copyFixture();
    await commandOf(f, "plugin install").handler({ positionals: [src], flags: {} }, makeIo({ yes: true }));
    await commandOf(f, "plugin disable").handler(
      { positionals: ["mola-fake-plugin"], flags: {} },
      makeIo({ yes: true }),
    );
    await commandOf(f, "plugin enable").handler(
      { positionals: ["mola-fake-plugin"], flags: {} },
      makeIo({ yes: true }),
    );
    await commandOf(f, "plugin remove").handler(
      { positionals: ["mola-fake-plugin"], flags: {} },
      makeIo({ yes: true }),
    );
    const kinds = f.emitted.map((e) => e.event);
    assert.deepEqual(kinds, [
      "mola.plugin.installed",
      "mola.plugin.disabled",
      "mola.plugin.enabled",
      "mola.plugin.removed",
    ]);
  });
});

test("plugin doctor is clean for a fresh install and reports the plan", async () => {
  await withHome(async () => {
    const f = activate();
    const src = copyFixture();
    await commandOf(f, "plugin install").handler({ positionals: [src], flags: {} }, makeIo({ yes: true }));
    const io = makeIo({ yes: true });
    const code = await commandOf(f, "plugin doctor").handler({ positionals: [], flags: {} }, io);
    assert.equal(code, 0);
    const data = io.dataValue as any;
    assert.equal(data.ok, true);
    assert.equal(data.checked.length, 1);
    assert.equal(data.checked[0].id, "mola-fake-plugin");
    assert.equal(data.checked[0].sha512Ok, true);
  });
});

test("plugin doctor reports a manifest that asks for more than the recorded grant", async () => {
  await withHome(async () => {
    const f = activate();
    const src = copyFixture();
    await commandOf(f, "plugin install").handler({ positionals: [src], flags: {} }, makeIo({ yes: true }));
    // tamper with the *installed* manifest (the pin check fires too, but the
    // grant check is the one under test here)
    const installed = path.join(tmpHome(), "x");
    void installed;
    const home = process.env.MOLA_HOME!;
    const file = path.join(home, "plugins", "mola-fake-plugin-0.1.0", "mola-plugin.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.permissions["process.exec"] = ["rm"];
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));

    const io = makeIo({ yes: true });
    const code = await commandOf(f, "plugin doctor").handler({ positionals: [], flags: {} }, io);
    assert.equal(code, 65);
    const problems = (io.dataValue as any).problems as Array<{ problem: string }>;
    assert.ok(
      problems.some((p) => p.problem.includes("beyond the recorded grant")),
      JSON.stringify(problems),
    );
  });
});
