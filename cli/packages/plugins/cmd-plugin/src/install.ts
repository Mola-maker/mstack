/**
 * Third-party plugin install/update/remove (ADR-0002 §2, core §5).
 *
 * The rules this module implements, in the order they matter:
 *
 *  1. **The permission diff is the gate.** Before anything is copied into
 *     ~/.mola/plugins the installer prints what the plugin asks for
 *     (`process.exec`, `fs.read`, …) and what it would add/remove relative to
 *     the recorded grant. A human confirms; `--yes` (or MOLA_YES=1) skips the
 *     prompt. Nothing is written before the confirmation (ADR-0002 §3:
 *     enforcement against malice is at install/update time).
 *  2. **The integrity pin.** The installed tree is hashed with SHA-512 and
 *     recorded next to the granted permissions in ~/.mola/plugins.json, so a
 *     later `update` can tell that the files changed under it.
 *  3. **The trust tier.** A plugin installed from a local path or an unknown
 *     registry is `untrusted` (ADR-0002 §2). Only a plugin from a verified
 *     registry with a matching hash could ever be `verified`; B2 has no
 *     registry client, so a local install is always `untrusted` and an npm/git
 *     spec is forwarded to pnpm and then pinned as `untrusted` too.
 *
 * The copy is a plain file copy — no symlink games, no postinstall scripts:
 * the plugin's own dependencies are installed by the package manager, not by
 * mola.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PermissionSet, PluginManifest, TrustTier } from "@mola/plugin-sdk";
import { validateManifest } from "@mola/plugin-sdk";
import {
  diffPermissions,
  formatPermissionDiff,
  hashPluginTree,
  readPluginRegistry,
  writePluginRegistry,
  type PermissionDiff,
  type PluginRegistryFile,
  type PluginRegistryRecord,
} from "@mola/core";

/** Files and directories never copied into the install tree. */
const SKIP_ENTRIES = new Set(["node_modules", ".git", ".mola", ".omc"]);

export interface InstallSource {
  /** the spec the user typed (a local path, an npm spec, a git url) */
  spec: string;
  /** resolved local directory (local specs only) */
  dir?: string;
  /** how the plugin was obtained — recorded in the registry */
  origin: "local" | "npm" | "git";
}

export interface PreparedInstall {
  source: InstallSource;
  manifest: PluginManifest;
  /** the permission set the manifest asks for */
  requested: PermissionSet;
  /** the manifest's declared permissions, normalized */
  diff: PermissionDiff;
  /** the install directory name under ~/.mola/plugins */
  installDirName: string;
  /** the absolute target directory */
  targetDir: string;
  /** the SHA-512 of the source tree */
  sha512: string;
  /** the existing grant, if this plugin is already installed */
  previous?: PluginRegistryRecord;
}

/** The install directory name for a plugin: `<id>-<version>`. */
export function installDirName(manifest: PluginManifest): string {
  return `${manifest.id}-${manifest.version}`;
}

/** Read + validate the manifest of a plugin directory (strict JSON). */
export function readManifest(dir: string): { manifest?: PluginManifest; error?: string } {
  const file = path.join(dir, "mola-plugin.json");
  if (!fs.existsSync(file)) return { error: `${dir}: missing mola-plugin.json` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return {
      error: `${file}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const v = validateManifest(parsed);
  if (!v.ok || !v.manifest) return { error: `${file}: ${v.errors.join("; ")}` };
  return { manifest: v.manifest };
}

/** Normalize a manifest's declared permissions into a full PermissionSet. */
export function normalizePermissions(manifest: PluginManifest): PermissionSet {
  const p = manifest.permissions ?? {};
  return {
    "process.exec": p["process.exec"] ?? [],
    "fs.read": p["fs.read"] ?? [],
    "fs.write": p["fs.write"] ?? [],
    "net.connect": p["net.connect"] ?? [],
    "env.read": p["env.read"] ?? [],
    mola: p.mola ?? [],
  };
}

/**
 * Prepare an install from a local directory: validate the manifest, compute
 * the permission diff against the recorded grant and hash the source tree.
 * Nothing is written here — the caller confirms first.
 */
export function prepareLocalInstall(opts: {
  sourceDir: string;
  spec: string;
  homeDir: string;
  registry: PluginRegistryFile;
}): { prepared?: PreparedInstall; error?: string } {
  const { sourceDir, spec, homeDir, registry } = opts;
  const { manifest, error } = readManifest(sourceDir);
  if (!manifest) return { error: error! };

  const name = installDirName(manifest);
  const targetDir = path.join(homeDir, "plugins", name);
  const previous = registry[name];

  // the diff is against the grant this plugin already holds (update) or
  // against nothing (fresh install: the full set shows up as "added")
  const before = previous?.permissions;
  const requested = normalizePermissions(manifest);
  const diff = diffPermissions(before, requested);

  return {
    prepared: {
      source: { spec, dir: sourceDir, origin: "local" },
      manifest,
      requested,
      diff,
      installDirName: name,
      targetDir,
      sha512: hashPluginTree(sourceDir),
      previous,
    },
  };
}

/** Copy a plugin tree into the install directory (no node_modules, no .git). */
export function copyPluginTree(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyPluginTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

/** The record written to ~/.mola/plugins.json for an installed plugin. */
export function makeRecord(opts: {
  prepared: PreparedInstall;
  tier: TrustTier;
  now: string;
}): PluginRegistryRecord {
  const { prepared, tier, now } = opts;
  const record: PluginRegistryRecord = {
    id: prepared.manifest.id,
    version: prepared.manifest.version,
    kind: prepared.manifest.kind,
    tier,
    dir: prepared.installDirName,
    source: prepared.source.spec,
    sha512: prepared.sha512,
    permissions: prepared.requested,
    enabled: true,
    installedAt: prepared.previous?.installedAt ?? now,
    updatedAt: now,
  };
  return record;
}

/** Write the record into the registry (creating it when missing). */
export function recordInstall(
  homeDir: string,
  prepared: PreparedInstall,
  tier: TrustTier,
  now: string,
): PluginRegistryFile {
  const registry = readPluginRegistry(homeDir);
  registry[prepared.installDirName] = makeRecord({ prepared, tier, now });
  writePluginRegistry(homeDir, registry);
  return registry;
}

/** Remove a plugin's files and its registry record (core §5). */
export function removeInstalled(
  homeDir: string,
  name: string,
): { removedFiles: boolean; record?: PluginRegistryRecord } {
  const registry = readPluginRegistry(homeDir);
  const rec = registry[name];
  const dir = path.join(homeDir, "plugins", name);
  let removedFiles = false;
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    removedFiles = true;
  }
  delete registry[name];
  writePluginRegistry(homeDir, registry);
  return { removedFiles, record: rec };
}

/** Human-readable permission diff lines (core §5 step 4). */
export function permissionDiffLines(diff: PermissionDiff): string[] {
  return formatPermissionDiff(diff);
}

/** The trust tier for a plugin obtained the given way (ADR-0002 §2). */
export function tierForOrigin(origin: InstallSource["origin"]): TrustTier {
  // B2 has no registry client, so nothing can be `verified` yet: a verified
  // tier needs "registry + recorded tarball SHA-512" (ADR-0002 §2), and the
  // hash we record is of a local tree, not of a registry artifact.
  void origin;
  return "untrusted";
}
