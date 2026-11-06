/**
 * cmd-plugin (B1: list + validate; B2: the plugin lifecycle).
 *
 * B2 commands (ADR-0002 §2, core §5):
 *
 *   mola plugin list                     installed plugins: id, version, kind, tier, state
 *   mola plugin validate <dir>           check a checkout's mola-plugin.json (no install)
 *   mola plugin install <dir|pkg>        install from a local dir (B2); npm/git specs are
 *                                        forwarded to pnpm on the user's machine
 *   mola plugin update [id|--all]        re-install, re-run the permission diff (mandatory)
 *   mola plugin remove <id>              deactivate + delete files + registry entry
 *   mola plugin enable <id> | disable <id>   flip a flag in plugins.json (files stay)
 *   mola plugin doctor                   resolve→plan without activating (conflicts,
 *                                        missing providers, stale mola API ranges)
 *
 * The install/update gate is the permission diff (ADR-0002 §3): the diff is
 * printed and confirmed; `--yes` skips the confirmation. Nothing is written
 * before the confirmation.
 *
 * B2 also hosts the packaging conveniences that have no other owner:
 *   mola skills install [--claude|--dsh|--codex]
 *   mola completions <bash|zsh|pwsh>
 *   mola version
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Io, PluginContext } from "@mola/plugin-sdk";
import { definePlugin, detectColor, palette, statusGlyph, table, validateManifest, MolaError, ExitCode } from "@mola/plugin-sdk";

/**
 * The plugin lifecycle events (ADR-0004 `mola.<domain>.<verb>`). The SDK's
 * MolaEvents map has the activation events but not the install ones — those
 * are new in B2 and belong to the ADR-0004 vocabulary, so the names are
 * spelled out here (the SDK constant can be added when plugin-sdk is next
 * touched).
 */
const PluginEvents = {
  Installed: "mola.plugin.installed",
  Updated: "mola.plugin.updated",
  Removed: "mola.plugin.removed",
  Enabled: "mola.plugin.enabled",
  Disabled: "mola.plugin.disabled",
} as const;
import {
  diffPermissions,
  formatPermissionDiff,
  hashPluginTree,
  readPluginRegistry,
  writePluginRegistry,
  type PluginRegistryFile,
  type PluginRegistryRecord,
} from "@mola/core";
import {
  applySkillEntry,
  defaultTargets,
  planSkills,
  SKILL_TARGETS,
  userHome,
  type SkillTarget,
} from "./skills.js";
import { molaHome, findMstackRoot, readSkillsVersion } from "./paths.js";
import {
  copyPluginTree,
  installDirName,
  normalizePermissions,
  prepareLocalInstall,
  readManifest,
  recordInstall,
  removeInstalled,
  tierForOrigin,
  type PreparedInstall,
} from "./install.js";
import { renderCompletions, SHELLS, normalizeCommands, type Shell } from "./completions.js";
import { onWindows, pnpmArgv, pnpmCommandLine, pnpmInstallDir, runPnpm, type PnpmForward } from "./pnpm.js";
import { satisfies } from "./semver.js";

const USAGE_INSTALL = "usage: mola plugin install <dir|pkg> [--yes]";
const USAGE_REMOVE = "usage: mola plugin remove <id>";
const USAGE_TOGGLE = "usage: mola plugin enable|disable <id>";

/** The core API version mola implements — the range a plugin must accept. */
const MOLA_API_VERSION = "0.1.0";

/**
 * A human note that stays out of the way in --json mode: the contract is
 * "stdout carries exactly one envelope and stderr one error line", so a
 * progress note would break it. Everything the note says is also in the
 * envelope's `data`.
 */
function note(io: Io, message: string): void {
  if (!io.json) io.note(message);
}

/** Ask the human to confirm the permission diff. */
async function confirmDiff(
  io: Io,
  lines: string[],
  question: string,
): Promise<boolean> {
  if (!io.json) {
    for (const line of lines) io.out(line);
  }
  if (io.yes) {
    note(io, "permission diff accepted (--yes)");
    return true;
  }
  // An interactive prompt needs a TTY; without one we refuse rather than
  // guess — the caller turns this into exit 77.
  if (!process.stdin.isTTY) {
    note(
      io,
      "no TTY for the confirmation prompt — rerun with --yes (or MOLA_YES=1) to accept the permission diff",
    );
    return false;
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Print the permission diff of a prepared install (human + machine readable). */
function diffSummary(prepared: PreparedInstall): string[] {
  const lines = formatPermissionDiff(prepared.diff);
  if (lines.length === 0) return ["(no permission change)"];
  return lines;
}

interface InstalledEntry {
  /** the registry key (the install directory name) */
  key: string;
  record: PluginRegistryRecord;
  /** the absolute install directory */
  dir: string;
}

/** The installed third-party plugins, from the registry. */
function installedEntries(home: string): InstalledEntry[] {
  const registry = readPluginRegistry(home);
  return Object.entries(registry)
    .map(([key, record]) => ({ key, record, dir: path.join(home, "plugins", key) }))
    .sort((a, b) => a.record.id.localeCompare(b.record.id));
}

/** Find an installed plugin by manifest id (or by its install dir name). */
function findInstalled(home: string, id: string): InstalledEntry | undefined {
  const entries = installedEntries(home);
  return (
    entries.find((e) => e.record.id === id || e.key === id) ??
    // also match by id prefix (the user may type "fake" for "mola-fake-plugin")
    entries.find((e) => e.record.id.startsWith(id))
  );
}

/**
 * Resolve a spec to a local directory. B2 installs from a local directory;
 * an npm/git spec is forwarded to pnpm on the user's machine (the dsh plugin
 * model, core §5 step 2) — that path is reported, not executed in tests.
 */
function resolveLocalSpec(spec: string, cwd: string): string | null {
  const candidates = [path.resolve(cwd, spec)];
  if (spec.startsWith("file:")) candidates.push(path.resolve(cwd, spec.slice("file:".length)));
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* not a directory */
    }
  }
  return null;
}

/** Is this spec an npm/git spec (i.e. not a local path)? */
function isRemoteSpec(spec: string): boolean {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~")) return false;
  if (path.isAbsolute(spec)) return false;
  if (/^[A-Za-z]:[\\/]/.test(spec)) return false; // Windows drive path
  if (fs.existsSync(path.resolve(spec))) return false;
  return true;
}

export default definePlugin({
  activate(ctx: PluginContext) {
    const home = () => molaHome();

    // ------------------------------------------------------------ plugin list

    ctx.commands.register({
      path: ["plugin", "list"],
      description: "installed plugins: id, version, kind, tier, state",
      async handler(_args, io) {
        const plugins = ctx.plugins.list();
        // third-party installs carry the registry metadata (core §5: "shows id,
        // version, tier, enabled, granted permissions, and quarantine state")
        const registry = readPluginRegistry(home());
        const byId = new Map<string, PluginRegistryRecord>();
        for (const rec of Object.values(registry)) byId.set(rec.id, rec);
        const rows = plugins.map((p) => {
          const rec = byId.get(p.id);
          if (!rec) return p;
          return {
            ...p,
            enabled: rec.enabled,
            source: rec.source,
            sha512: rec.sha512,
            installDir: rec.dir,
          };
        });
        io.data(rows);
        if (!io.json) {
          const paint = palette(detectColor());
          const body = rows.map((p) => {
            const glyph = statusGlyph(p.state === "quarantined" ? "fail" : p.enabled === false ? "warn" : "ok", paint);
            const state = p.state === "quarantined" ? `quarantined: ${p.error ?? "?"}` : p.enabled === false ? "disabled" : p.state;
            return [glyph, p.id, p.version, p.kind, p.tier, state];
          });
          for (const line of table({ header: ["", "id", "version", "kind", "tier", "state"], rows: body })) {
            io.out(line);
          }
        }
        return ExitCode.Ok;
      },
    });

    // ------------------------------------------------------- plugin validate

    ctx.commands.register({
      path: ["plugin", "validate"],
      description: "check a checkout's mola-plugin.json (no install)",
      async handler(args, io) {
        const dirArg = args.positionals[0];
        if (!dirArg) {
          throw new MolaError("USAGE_ERROR", "usage: mola plugin validate <dir>", ExitCode.Usage);
        }
        const dir = path.resolve(io.cwd, dirArg);
        const manifestPath = path.join(dir, "mola-plugin.json");
        if (!fs.existsSync(manifestPath)) {
          throw new MolaError("NO_INPUT", `no mola-plugin.json in ${dir}`, ExitCode.NoInput);
        }
        let parsed: unknown;
        try {
          // read through the permission-checked handle (manifest grants fs.read)
          parsed = JSON.parse(ctx.fs.readFile(manifestPath)); // manifests are strict JSON
        } catch (err) {
          if (err instanceof MolaError) throw err; // permission denials stay 77
          throw new MolaError(
            "MANIFEST_INVALID",
            `${manifestPath}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
            ExitCode.DataErr,
          );
        }
        const result = validateManifest(parsed);
        if (!result.ok) {
          if (!io.json) for (const e of result.errors) note(io, `  ✗ ${e}`);
          throw new MolaError("MANIFEST_INVALID", `${manifestPath}: ${result.errors.length} error(s)`, ExitCode.DataErr, {
            errors: result.errors,
          });
        }
        const m = result.manifest!;
        io.data({ valid: true, id: m.id, version: m.version, kind: m.kind });
        if (!io.json) io.out(`valid: ${m.id}@${m.version} (${m.kind})`);
        return ExitCode.Ok;
      },
    });

    // -------------------------------------------------------- plugin install

    ctx.commands.register({
      path: ["plugin", "install"],
      description: "install a plugin from a local dir (npm specs forward to pnpm)",
      async handler(args, io) {
        const spec = args.positionals[0];
        if (!spec) throw new MolaError("USAGE_ERROR", USAGE_INSTALL, ExitCode.Usage);
        const h = home();

        // A remote spec is forwarded to pnpm on the user's machine — mola does
        // not start a package manager behind the user's back (core §5 step 2).
        // `--run` executes the forwarded command through the permission-checked
        // exec service; without it the command line is only printed.
        if (isRemoteSpec(spec)) {
          const forward = pnpmForward({
            installDir: pnpmInstallDir(h),
            spec,
            dev: args.flags.dev === true,
            exact: args.flags["save-exact"] === true,
          });
          if (args.flags.run !== true) {
            io.data({
              spec,
              forwardedTo: "pnpm",
              argv: forward.argv,
              command: forward.command,
              installed: false,
              note: "npm/git specs are fetched by pnpm; pass --run to execute the forwarded command",
            });
            if (!io.json) {
              io.out(`forwarding to pnpm: ${forward.command}`);
              note(io, "pass --run to execute it, or run the command above by hand");
            }
            return ExitCode.Ok;
          }
          const code = await runPnpm(ctx.process, forward.argv, io.cwd);
          io.data({
            spec,
            forwardedTo: "pnpm",
            argv: forward.argv,
            command: forward.command,
            executed: true,
            exitCode: code,
            installed: false,
            note: "the fetched package is not a mola plugin until it carries a mola-plugin.json — install that directory",
          });
          if (!io.json) {
            io.out(`pnpm exited ${code}`);
            note(io, "install the fetched directory with `mola plugin install <dir>`");
          }
          return (code === 0 ? ExitCode.Ok : code) as ExitCode;
        }

        const sourceDir = resolveLocalSpec(spec, io.cwd);
        if (!sourceDir) {
          throw new MolaError("NO_INPUT", `no such plugin directory: ${spec}`, ExitCode.NoInput);
        }
        const registry = readPluginRegistry(h);
        const { prepared, error } = prepareLocalInstall({ sourceDir, spec, homeDir: h, registry });
        if (!prepared) {
          throw new MolaError("MANIFEST_INVALID", error!, ExitCode.DataErr);
        }

        // the permission diff is the gate (ADR-0002 §3)
        const lines = diffSummary(prepared);
        const accepted = await confirmDiff(io, lines, `install ${prepared.manifest.id}@${prepared.manifest.version}?`);
        if (!accepted) {
          io.data({ installed: false, id: prepared.manifest.id, diff: prepared.diff, declined: true });
          throw new MolaError(
            "POLICY_DENIED",
            `install of ${prepared.manifest.id} declined — the permission diff was not confirmed`,
            ExitCode.NoPerm,
            { diff: prepared.diff },
          );
        }

        // write the tree, then the registry record (sha512 + granted snapshot)
        fs.mkdirSync(path.dirname(prepared.targetDir), { recursive: true });
        if (fs.existsSync(prepared.targetDir)) {
          fs.rmSync(prepared.targetDir, { recursive: true, force: true });
        }
        copyPluginTree(sourceDir, prepared.targetDir);
        const tier = tierForOrigin(prepared.source.origin);
        recordInstall(h, prepared, tier, new Date().toISOString());

        ctx.events.emit(PluginEvents.Installed, {
          id: prepared.manifest.id,
          version: prepared.manifest.version,
          tier,
          sha512: prepared.sha512,
          dir: prepared.targetDir,
        });

        io.data({
          installed: true,
          id: prepared.manifest.id,
          version: prepared.manifest.version,
          kind: prepared.manifest.kind,
          tier,
          dir: prepared.targetDir,
          sha512: prepared.sha512,
          permissions: prepared.requested,
          diff: prepared.diff,
          registry: path.join(h, "plugins.json"),
        });
        if (!io.json) {
          io.out(`installed ${prepared.manifest.id}@${prepared.manifest.version} (${tier}) → ${prepared.targetDir}`);
          note(io, `sha512 ${prepared.sha512}`);
          note(io, "activate on the next boot (or restart the current mola)");
        }
        return ExitCode.Ok;
      },
    });

    // --------------------------------------------------------- plugin update

    ctx.commands.register({
      path: ["plugin", "update"],
      description: "re-install a plugin and re-run its permission diff (mandatory)",
      async handler(args, io) {
        const h = home();
        const target = args.positionals[0];
        const all = args.flags.all === true || target === "--all";
        const entries = installedEntries(h);
        const selected = all
          ? entries
          : entries.filter((e) => e.record.id === target || e.key === target);
        if (!all && selected.length === 0) {
          throw new MolaError("PLUGIN_NOT_FOUND", `no installed plugin named "${target}"`, ExitCode.NoInput);
        }
        if (all && entries.length === 0) {
          throw new MolaError("NO_INPUT", "no third-party plugins are installed", ExitCode.NoInput);
        }

        const updated: Array<Record<string, unknown>> = [];
        for (const entry of selected) {
          const sourceDir = resolveUpdateSource(entry, io.cwd);
          if (!sourceDir) {
            throw new MolaError(
              "NO_INPUT",
              `cannot re-resolve ${entry.record.id} — the recorded source "${entry.record.source}" is not reachable`,
              ExitCode.NoInput,
            );
          }
          const registry = readPluginRegistry(h);
          const { prepared, error } = prepareLocalInstall({
            sourceDir,
            spec: entry.record.source,
            homeDir: h,
            registry,
          });
          if (!prepared) throw new MolaError("MANIFEST_INVALID", error!, ExitCode.DataErr);

          // the diff is mandatory on update (core §5)
          const lines = diffSummary(prepared);
          const accepted = await confirmDiff(
            io,
            lines,
            `update ${prepared.manifest.id} → ${prepared.manifest.version}?`,
          );
          if (!accepted) {
            io.data({ updated: false, id: prepared.manifest.id, diff: prepared.diff, declined: true });
            throw new MolaError(
              "POLICY_DENIED",
              `update of ${prepared.manifest.id} declined — the permission diff was not confirmed`,
              ExitCode.NoPerm,
              { diff: prepared.diff },
            );
          }
          fs.mkdirSync(path.dirname(prepared.targetDir), { recursive: true });
          if (fs.existsSync(prepared.targetDir)) fs.rmSync(prepared.targetDir, { recursive: true, force: true });
          copyPluginTree(sourceDir, prepared.targetDir);
          const tier = tierForOrigin(prepared.source.origin);
          recordInstall(h, prepared, tier, new Date().toISOString());
          ctx.events.emit(PluginEvents.Updated, {
            id: prepared.manifest.id,
            version: prepared.manifest.version,
            tier,
            sha512: prepared.sha512,
          });
          updated.push({
            id: prepared.manifest.id,
            version: prepared.manifest.version,
            tier,
            sha512: prepared.sha512,
            diff: prepared.diff,
          });
          if (!io.json) io.out(`updated ${prepared.manifest.id} → ${prepared.manifest.version} (${tier})`);
        }

        io.data({ updated: true, plugins: updated });
        return ExitCode.Ok;
      },
    });

    // --------------------------------------------------------- plugin remove

    ctx.commands.register({
      path: ["plugin", "remove"],
      description: "remove an installed plugin (files + registry entry)",
      async handler(args, io) {
        const id = args.positionals[0];
        if (!id) throw new MolaError("USAGE_ERROR", USAGE_REMOVE, ExitCode.Usage);
        const h = home();
        const entry = findInstalled(h, id);
        if (!entry) {
          throw new MolaError("PLUGIN_NOT_FOUND", `no installed plugin named "${id}"`, ExitCode.NoInput);
        }
        const { removedFiles } = removeInstalled(h, entry.key);
        ctx.events.emit(PluginEvents.Removed, {
          id: entry.record.id,
          dir: entry.dir,
          filesDeleted: removedFiles,
        });
        io.data({
          removed: true,
          id: entry.record.id,
          dir: entry.dir,
          filesDeleted: removedFiles,
        });
        if (!io.json) io.out(`removed ${entry.record.id} (${entry.dir})`);
        return ExitCode.Ok;
      },
    });

    // -------------------------------------------------------- plugin enable

    ctx.commands.register({
      path: ["plugin", "enable"],
      description: "enable an installed plugin (flag only, files stay)",
      async handler(args, io) {
        return setEnabled(ctx, args, io, true);
      },
    });

    // ------------------------------------------------------- plugin disable

    ctx.commands.register({
      path: ["plugin", "disable"],
      description: "disable an installed plugin (flag only, files stay)",
      async handler(args, io) {
        return setEnabled(ctx, args, io, false);
      },
    });

    // -------------------------------------------------------- plugin doctor

    ctx.commands.register({
      path: ["plugin", "doctor"],
      description: "resolve→plan the plugin set without activating it",
      async handler(_args, io) {
        const h = home();
        const registry = readPluginRegistry(h);
        const problems: Array<{ id: string; problem: string }> = [];
        const checked: Array<Record<string, unknown>> = [];

        for (const entry of installedEntries(h)) {
          const rec = entry.record;
          const { manifest, error } = readManifest(entry.dir);
          if (!manifest) {
            problems.push({ id: rec.id, problem: error! });
            continue;
          }
          // the manifest's declared range vs the core API version
          if (manifest.mola && !satisfies(MOLA_API_VERSION, manifest.mola)) {
            problems.push({
              id: rec.id,
              problem: `requires mola ${manifest.mola}, this mola is ${MOLA_API_VERSION}`,
            });
          }
          // the integrity pin: the files must still hash to the recorded value
          const actual = hashPluginTree(entry.dir);
          const pinOk = !rec.sha512 || actual === rec.sha512;
          if (!pinOk) {
            problems.push({ id: rec.id, problem: "installed files do not match the recorded sha512 pin" });
          }
          // the granted snapshot must still cover what the manifest asks for
          const granted = rec.permissions ?? {};
          const missing = diffPermissions(granted, normalizePermissions(manifest)).added;
          if (missing.length > 0) {
            problems.push({
              id: rec.id,
              problem: `manifest asks for permissions beyond the recorded grant: ${missing
                .map((m) => `${m.permission}: ${m.added.join(", ")}`)
                .join("; ")}`,
            });
          }
          checked.push({
            id: rec.id,
            version: rec.version,
            tier: rec.tier,
            enabled: rec.enabled,
            sha512Ok: pinOk,
            molaRange: manifest.mola ?? null,
          });
        }

        // the live plan of the whole set (builtin + installed): conflicts and
        // missing providers — the same plan the boot ran
        const plan = ctx.plugins.plan();
        for (const err of plan.errors) problems.push({ id: "plan", problem: err });
        for (const id of plan.quarantined) problems.push({ id, problem: "quarantined" });

        io.data({
          ok: problems.length === 0,
          checked,
          problems,
          plan: { ok: plan.ok, order: plan.order, errors: plan.errors, quarantined: plan.quarantined },
        });
        if (!io.json) {
          for (const c of checked) {
            io.out(`ok   ${c.id}@${c.version} (${c.tier})${c.enabled ? "" : " [disabled]"}`);
          }
          for (const p of problems) io.out(`FAIL ${p.id} — ${p.problem}`);
          if (problems.length === 0) io.out("plugin plan clean");
        }
        // a broken manifest is EX_DATAERR, an unresolvable provider is too
        // (core §8.3); everything else reports as 0 with the problems listed
        return (problems.length > 0 ? ExitCode.DataErr : ExitCode.Ok) as ExitCode;
      },
    });

    // ----------------------------------------------------- skills install

    ctx.commands.register({
      path: ["skills", "install"],
      description: "install the mstack skills (--claude|--dsh|--codex)",
      async handler(args, io) {
        const root = findMstackRoot({
          cwd: io.cwd,
          configSource: ctx.config.get<string>("skills.source"),
        });
        if (!root) {
          throw new MolaError(
            "NO_INPUT",
            "cannot find the mstack repo (skills/ + .claude-plugin/plugin.json) — " +
              "set skills.source in ~/.mola/config.jsonc or MOLA_MSTACK_DIR",
            ExitCode.NoInput,
          );
        }
        const targets = parseTargets(args.flags);
        const dryRun = args.flags["dry-run"] === true || args.flags.dryRun === true;
        const home = userHome();
        const plan = planSkills({ root, targets, home, dryRun });
        if (dryRun) {
          io.data({ dryRun: true, root, entries: plan.entries, claudeHint: plan.claudeHint });
          if (!io.json) {
            for (const e of plan.entries) {
              io.out(`${e.action.padEnd(8)} ${e.target}/${e.name} → ${e.destination} (${e.mode})`);
            }
            if (plan.claudeHint) note(io, plan.claudeHint);
          }
          return ExitCode.Ok;
        }
        for (const entry of plan.entries) applySkillEntry(entry);
        io.data({ dryRun: false, root, entries: plan.entries, claudeHint: plan.claudeHint });
        if (!io.json) {
          for (const e of plan.entries) {
            if (e.action === "keep" || e.action === "skip") continue;
            io.out(`${e.target}/${e.name} → ${e.destination} (${e.mode})`);
          }
          if (plan.claudeHint) note(io, `claude: ${plan.claudeHint}`);
        }
        return ExitCode.Ok;
      },
    });

    // --------------------------------------------------------- completions

    ctx.commands.register({
      path: ["completions"],
      description: "print the shell completion script (bash|zsh|pwsh)",
      async handler(args, io) {
        const shell = args.positionals[0];
        if (!shell) {
          throw new MolaError(
            "USAGE_ERROR",
            `usage: mola completions <${SHELLS.join("|")}>`,
            ExitCode.Usage,
          );
        }
        if (!SHELLS.includes(shell as Shell)) {
          throw new MolaError(
            "USAGE_ERROR",
            `unknown shell "${shell}" (expected ${SHELLS.join(", ")})`,
            ExitCode.Usage,
          );
        }
        const commands = normalizeCommands(currentCommands());
        const script = renderCompletions(shell as Shell, commands);
        // the script itself goes to stdout — it is the command's product, not
        // a human note; in --json mode it travels inside the envelope
        if (io.json) {
          io.data({ shell, script, commands: commands.map((c) => c.path.join(" ")) });
        } else {
          io.out(script);
        }
        return ExitCode.Ok;
      },
    });

    // ------------------------------------------------------------- version

    ctx.commands.register({
      path: ["version"],
      description: "mola, core, plugin and mstack skills versions",
      async handler(_args, io) {
        const root = findMstackRoot({
          cwd: io.cwd,
          configSource: ctx.config.get<string>("skills.source"),
        });
        const skillsVersion = root ? readSkillsVersion(root) : null;
        const plugins = ctx.plugins.list();
        const payload = {
          mola: MOLA_API_VERSION,
          core: MOLA_API_VERSION,
          skills: skillsVersion,
          skillsSource: root,
          plugins: plugins.map((p) => ({ id: p.id, version: p.version, kind: p.kind, tier: p.tier })),
        };
        io.data(payload);
        if (!io.json) {
          io.out(`mola ${payload.mola}`);
          io.out(`core ${payload.core}`);
          io.out(`skills ${skillsVersion ?? "(not found)"}`);
          io.out(`plugins ${plugins.length}`);
          for (const p of plugins) io.out(`  ${p.id} ${p.version} (${p.tier})`);
        }
        return ExitCode.Ok;
      },
    });
  },
});

/** Enable/disable a plugin: flip the flag in plugins.json (files stay). */
async function setEnabled(
  ctx: PluginContext,
  args: { positionals: string[]; flags: Record<string, string | boolean> },
  io: Io,
  enabled: boolean,
): Promise<ExitCode> {
  const id = args.positionals[0];
  if (!id) throw new MolaError("USAGE_ERROR", USAGE_TOGGLE, ExitCode.Usage);
  const h = molaHome();
  const entry = findInstalled(h, id);
  if (!entry) {
    throw new MolaError("PLUGIN_NOT_FOUND", `no installed plugin named "${id}"`, ExitCode.NoInput);
  }
  const registry: PluginRegistryFile = readPluginRegistry(h);
  registry[entry.key] = { ...entry.record, enabled };
  writePluginRegistry(h, registry);
  ctx.events.emit(enabled ? PluginEvents.Enabled : PluginEvents.Disabled, {
    id: entry.record.id,
    dir: entry.dir,
  });
  io.data({ id: entry.record.id, enabled, dir: entry.dir });
  if (!io.json) {
    io.out(`${enabled ? "enabled" : "disabled"} ${entry.record.id}`);
  }
  return ExitCode.Ok;
}

/** The update source: the recorded local path, if it still resolves. */
function resolveUpdateSource(entry: InstalledEntry, cwd: string): string | null {
  const source = entry.record.source;
  return resolveLocalSpec(source, cwd);
}

/** Parse the --claude/--dsh/--codex flags into a target list. */
function parseTargets(flags: Record<string, string | boolean>): SkillTarget[] {
  const picked: SkillTarget[] = [];
  for (const t of SKILL_TARGETS) {
    if (flags[t] === true) picked.push(t);
  }
  if (picked.length === 0) return defaultTargets();
  return picked;
}

/**
 * The pnpm command line a remote spec is forwarded to. The install directory
 * is ~/.mola/plugins (core §5 step 2: "pnpm, forwarded verbatim into
 * ~/.mola/plugins/ — the exact model dsh plugin uses").
 */
function pnpmForward(opts: {
  installDir: string;
  spec: string;
  dev?: boolean;
  exact?: boolean;
}): PnpmForward {
  const argv = pnpmArgv({
    installDir: opts.installDir,
    spec: opts.spec,
    dev: opts.dev,
    exact: opts.exact,
    windows: onWindows(),
  });
  return { argv, command: pnpmCommandLine(argv) };
}

/**
 * The commands the completion script offers. The router's inventory is not
 * reachable from a plugin (core §2.3 exposes no router handle), so the
 * plugin keeps its own list of the commands it knows about plus the core
 * surface. The script is a convenience, never a contract.
 */
function currentCommands(): Array<{ path: string[]; description: string }> {
  return [
    { path: ["completions"], description: "print the shell completion script (bash|zsh|pwsh)" },
    { path: ["config", "get"], description: "read a config key (dotted path, e.g. log.level)" },
    { path: ["config", "set"], description: "write a config key to ~/.mola/config.jsonc (null deletes)" },
    { path: ["doctor"], description: "health: node, plugins, magpie, agents, tools (per-plugin checks)" },
    { path: ["plugin", "disable"], description: "disable an installed plugin (flag only, files stay)" },
    { path: ["plugin", "doctor"], description: "resolve→plan the plugin set without activating it" },
    { path: ["plugin", "enable"], description: "enable an installed plugin (flag only, files stay)" },
    { path: ["plugin", "install"], description: "install a plugin from a local dir (npm specs forward to pnpm)" },
    { path: ["plugin", "list"], description: "installed plugins: id, version, kind, tier, state" },
    { path: ["plugin", "remove"], description: "remove an installed plugin (files + registry entry)" },
    { path: ["plugin", "update"], description: "re-install a plugin and re-run its permission diff (mandatory)" },
    { path: ["plugin", "validate"], description: "check a checkout's mola-plugin.json (no install)" },
    { path: ["skills", "install"], description: "install the mstack skills (--claude|--dsh|--codex)" },
    { path: ["version"], description: "mola, core, plugin and mstack skills versions" },
  ];
}

export { installDirName, permissionDiffSummary };

function permissionDiffSummary(diff: ReturnType<typeof diffPermissions>): string[] {
  return formatPermissionDiff(diff);
}
