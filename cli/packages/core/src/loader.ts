/**
 * Plugin loader (ADR-0002, core §2.2): resolve → validate → plan → activate.
 *
 * - resolve: builtin dirs (bundled with mola) → ~/.mola/plugins → project
 *   plugins from .mola/config.jsonc (`plugins:` paths).
 * - validate: mola-plugin.json against the SDK contract (exit 65 on bad data).
 * - plan: topo sort over provides/requires, conflicts check. A cycle or missing
 *   provider is a load error recorded in the plan — boot continues, the
 *   plugins.plan-ok doctor check and `mola plugin validate` surface it.
 * - activate: PluginContext per plugin; an activate() throw quarantines the
 *   plugin (mola.plugin.quarantined) and boot continues degraded (core §2.1).
 *   B1 loads every tier in-process; worker isolation for `untrusted` arrives
 *   with third-party install support in B2 (ADR-0002 §3).
 *
 * B2 adds the third-party install registry (~/.mola/plugins.json), the
 * permission diff the installer confirms (core §5 step 4) and the SHA-512
 * integrity pin. The installer itself lives in cmd-plugin; the shared
 * record shape and the diff/hash helpers live here so both sides agree.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type {
  Logger,
  PermissionSet,
  Plugin,
  PluginContext,
  PluginManifest,
  TrustTier,
} from "@mola/plugin-sdk";
import { validateManifest } from "@mola/plugin-sdk";

export interface PluginSource {
  dir: string;
  tier: TrustTier;
  /** granted permission snapshot from ~/.mola/plugins.json (install-time gate) */
  granted?: PermissionSet;
}

export interface ResolvedPlugin {
  dir: string;
  tier: TrustTier;
  manifest: PluginManifest;
  granted: PermissionSet;
}

export interface ResolveResult {
  resolved: ResolvedPlugin[];
  errors: string[];
}

export interface LoadPlan {
  ok: boolean;
  errors: string[];
  order: ResolvedPlugin[];
}

/** Read + validate the manifest of one plugin directory. */
export function resolvePlugin(source: PluginSource): ResolvedPlugin | string {
  const manifestPath = path.join(source.dir, "mola-plugin.json");
  if (!fs.existsSync(manifestPath)) {
    return `${source.dir}: missing mola-plugin.json`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")); // manifests are strict JSON
  } catch (err) {
    return `${manifestPath}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`;
  }
  const v = validateManifest(parsed);
  if (!v.ok || !v.manifest) {
    return `${manifestPath}: ${v.errors.join("; ")}`;
  }
  // builtin: manifest permissions are auto-granted; others need the install-time snapshot
  const granted = source.tier === "builtin" ? (v.manifest.permissions ?? {}) : (source.granted ?? {});
  return { dir: source.dir, tier: source.tier, manifest: v.manifest, granted };
}

export function resolvePlugins(sources: PluginSource[]): ResolveResult {
  const resolved: ResolvedPlugin[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const r = resolvePlugin(source);
    if (typeof r === "string") {
      errors.push(r);
      continue;
    }
    if (seen.has(r.manifest.id)) {
      errors.push(`duplicate plugin id "${r.manifest.id}" (${r.dir})`);
      continue;
    }
    seen.add(r.manifest.id);
    resolved.push(r);
  }
  return { resolved, errors };
}

/** Topo sort over provides/requires + conflict check (ADR-0002 §1). */
export function planLoad(resolved: ResolvedPlugin[]): LoadPlan {
  const errors: string[] = [];
  const provides = new Map<string, string>(); // capability -> plugin id
  for (const p of resolved) {
    for (const cap of p.manifest.provides ?? []) {
      const other = provides.get(cap);
      if (other) {
        errors.push(`capability "${cap}" is provided by both ${other} and ${p.manifest.id}`);
      } else {
        provides.set(cap, p.manifest.id);
      }
    }
  }
  const ids = new Set(resolved.map((p) => p.manifest.id));
  for (const p of resolved) {
    for (const c of p.manifest.conflicts ?? []) {
      if (ids.has(c)) errors.push(`${p.manifest.id} conflicts with ${c}`);
    }
  }

  // edges: provider -> requirer
  const eligible = new Set(resolved.map((p) => p.manifest.id));
  for (const p of resolved) {
    for (const req of p.manifest.requires ?? []) {
      if (!provides.has(req)) {
        errors.push(`${p.manifest.id} requires "${req}", which no active plugin provides`);
        eligible.delete(p.manifest.id);
      }
    }
  }

  const byId = new Map(resolved.map((p) => [p.manifest.id, p]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const p of resolved) {
    if (!eligible.has(p.manifest.id)) continue;
    indegree.set(p.manifest.id, 0);
  }
  for (const p of resolved) {
    if (!eligible.has(p.manifest.id)) continue;
    for (const req of p.manifest.requires ?? []) {
      const provider = provides.get(req);
      if (!provider || !eligible.has(provider)) continue;
      indegree.set(p.manifest.id, (indegree.get(p.manifest.id) ?? 0) + 1);
      const list = dependents.get(provider) ?? [];
      list.push(p.manifest.id);
      dependents.set(provider, list);
    }
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: ResolvedPlugin[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const dep of dependents.get(id) ?? []) {
      const d = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, d);
      if (d === 0) queue.push(dep);
    }
  }
  if (order.length < indegree.size) {
    const stuck = [...indegree.entries()].filter(([, d]) => d > 0).map(([id]) => id);
    errors.push(`dependency cycle involving: ${stuck.join(", ")}`);
  }

  return { ok: errors.length === 0, errors, order };
}

export interface ActivatedPlugin {
  resolved: ResolvedPlugin;
  plugin: Plugin;
  ctx: PluginContext;
  disposeAll: () => Promise<void>;
}

// ------------------------------------------------------- permission diffing

/** The six permission buckets of the manifest contract (core §6). */
export const PERMISSION_KEYS = [
  "process.exec",
  "fs.read",
  "fs.write",
  "net.connect",
  "env.read",
  "mola",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export interface PermissionDiffEntry {
  permission: PermissionKey;
  added: string[];
  removed: string[];
}

export interface PermissionDiff {
  added: PermissionDiffEntry[];
  removed: PermissionDiffEntry[];
  /** true when the new set is a strict superset of the old one */
  escalates: boolean;
}

/**
 * Diff two permission sets (ADR-0002 §3, core §5 install step 4): the diff
 * the installer prints and the user confirms. "added" = the new set asks for
 * something the old one did not; "removed" = the old grant is gone.
 *
 * A grant is only a grant if the *old* set contained it, so a permission that
 * was never granted shows up as `added` even when the new set also lacks it —
 * that is the point: the diff is "what this plugin wants now", not a delta
 * between two arbitrary sets.
 */
export function diffPermissions(
  before: PermissionSet | undefined,
  after: PermissionSet | undefined,
): PermissionDiff {
  const added: PermissionDiffEntry[] = [];
  const removed: PermissionDiffEntry[] = [];
  for (const key of PERMISSION_KEYS) {
    const oldList = before?.[key] ?? [];
    const newList = after?.[key] ?? [];
    const gained = newList.filter((v) => !oldList.includes(v));
    const lost = oldList.filter((v) => !newList.includes(v));
    if (gained.length > 0) added.push({ permission: key, added: gained, removed: [] });
    if (lost.length > 0) removed.push({ permission: key, added: [], removed: lost });
  }
  return { added, removed, escalates: added.length > 0 };
}

/** Flatten a permission set to "key: value" lines — the human-readable diff. */
export function formatPermissionDiff(diff: PermissionDiff): string[] {
  const lines: string[] = [];
  for (const entry of diff.added) {
    for (const value of entry.added) lines.push(`+ ${entry.permission}: ${value}`);
  }
  for (const entry of diff.removed) {
    for (const value of entry.removed) lines.push(`- ${entry.permission}: ${value}`);
  }
  return lines;
}

// --------------------------------------------------- the plugins.json registry

/**
 * One record of ~/.mola/plugins.json — the install-time registry
 * (ADR-0002 §2, core §5). Keyed by the plugin's *install directory name*
 * under ~/.mola/plugins (not by manifest id: two versions may coexist on
 * disk, one is active — ADR-0002 §1).
 */
export interface PluginRegistryRecord {
  /** manifest id — for the human report and for `plugin enable <id>` lookup */
  id: string;
  version: string;
  kind: string;
  /** builtin | verified | untrusted (ADR-0002 §2 trust tiers) */
  tier: TrustTier;
  /** install directory under ~/.mola/plugins */
  dir: string;
  /** where it came from: a local path, an npm spec, a git url */
  source: string;
  /** SHA-512 of the installed tree — the integrity pin (ADR-0002 §2) */
  sha512?: string;
  /** the permission snapshot granted at install time */
  permissions?: PermissionSet;
  /** `plugin disable` flips this; disabled plugins are not resolved */
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
}

/** The whole registry file: `{ "<install dir>": record }`. */
export type PluginRegistryFile = Record<string, PluginRegistryRecord>;

export function pluginsRegistryFile(homeDir: string): string {
  return path.join(homeDir, "plugins.json");
}

export function pluginsInstallDir(homeDir: string): string {
  return path.join(homeDir, "plugins");
}

/** Read ~/.mola/plugins.json; a missing or broken file is an empty registry. */
export function readPluginRegistry(homeDir: string, log?: Logger): PluginRegistryFile {
  const file = pluginsRegistryFile(homeDir);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      log?.warn("ignoring malformed plugins.json", { file });
      return {};
    }
    return parsed as PluginRegistryFile;
  } catch (err) {
    log?.warn("ignoring unparseable plugins.json", {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/** Write ~/.mola/plugins.json atomically (tmp + rename on the same volume). */
export function writePluginRegistry(homeDir: string, registry: PluginRegistryFile): void {
  const file = pluginsRegistryFile(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------- integrity pinning

/**
 * SHA-512 over an installed plugin tree — the integrity pin (ADR-0002 §2,
 * core §5 step 4: "Record the granted snapshot + tarball SHA-512").
 *
 * A local directory install has no tarball, so the pin is computed over the
 * tree itself: every regular file, sorted by its POSIX-relative path, hashed
 * into one digest together with its path and size. The digest therefore
 * changes when a file is added, removed, renamed or edited — the property an
 * integrity pin needs. `node_modules` and dot-directories are skipped: they
 * are dependency state, not plugin content.
 */
export function hashPluginTree(dir: string): string {
  const hash = createHash("sha512");
  for (const rel of listPluginFiles(dir)) {
    const abs = path.join(dir, rel);
    const data = fs.readFileSync(abs);
    hash.update(rel);
    hash.update("\n");
    hash.update(String(data.length));
    hash.update("\n");
    hash.update(data);
  }
  return hash.digest("hex");
}

/** SHA-512 of one file (the tarball case: a downloaded .tgz). */
export function hashPluginFile(file: string): string {
  return createHash("sha512").update(fs.readFileSync(file)).digest("hex");
}

/** POSIX-relative paths of the plugin's own files, sorted. */
export function listPluginFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules") continue;
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listPluginFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}


export interface ActivateHooks {
  makeContext(p: ResolvedPlugin): PluginContext & { runDisposers(): Promise<void> };
  onActivated(p: ResolvedPlugin): void;
  onQuarantined(p: ResolvedPlugin, error: unknown): void;
  log: Logger;
}

async function loadEntry(p: ResolvedPlugin): Promise<Plugin> {
  const entry = p.manifest.entry;
  if (entry.ts) {
    const file = path.resolve(p.dir, entry.ts);
    const mod = await import(pathToFileURL(file).href);
    const candidate = mod.default ?? mod;
    const plugin: Plugin = typeof candidate === "function" ? candidate() : candidate;
    if (!plugin || typeof plugin.activate !== "function") {
      throw new Error(`${p.manifest.id}: entry ${entry.ts} does not export a Plugin`);
    }
    return plugin;
  }
  // Rust sidecar plugins (entry.bin) spawn per ADR-0001 — sidecars start in B3
  throw new Error(`${p.manifest.id}: entry.bin sidecar plugins are not supported in B1`);
}

/** Activate in plan order; failures quarantine, never stop the boot. */
export async function activateAll(plan: LoadPlan, hooks: ActivateHooks): Promise<ActivatedPlugin[]> {
  const active: ActivatedPlugin[] = [];
  for (const p of plan.order) {
    let ctx: (PluginContext & { runDisposers(): Promise<void> }) | undefined;
    try {
      ctx = hooks.makeContext(p);
      const plugin = await loadEntry(p);
      await plugin.activate(ctx);
      active.push({
        resolved: p,
        plugin,
        ctx,
        disposeAll: async () => {
          try {
            await plugin.deactivate?.();
          } catch (err) {
            hooks.log.warn("deactivate failed", { plugin: p.manifest.id, error: String(err) });
          }
          await ctx!.runDisposers();
        },
      });
      hooks.onActivated(p);
    } catch (err) {
      if (ctx) {
        try {
          await ctx.runDisposers();
        } catch {
          /* disposal of a half-activated plugin is best-effort */
        }
      }
      hooks.onQuarantined(p, err);
    }
  }
  return active;
}

/**
 * Scan ~/.mola/plugins for installed third-party plugins (resolve only).
 *
 * The registry file (~/.mola/plugins.json) is written by `mola plugin
 * install` — its format lives with the installer, in
 * cli/packages/plugins/cmd-plugin/src/registry.ts; this side only needs three
 * fields of a record: the trust tier, the granted permission snapshot
 * (install-time gate) and the enabled flag.
 */
export function scanUserPlugins(homeDir: string, log: Logger): PluginSource[] {
  const dir = path.join(homeDir, "plugins");
  if (!fs.existsSync(dir)) return [];
  // granted snapshots + tiers recorded by `mola plugin install` (B2)
  const registry = readPluginRegistry(homeDir, log);
  const out: PluginSource[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pdir = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(pdir, "mola-plugin.json"))) continue;
    const rec = registry[entry.name];
    // `mola plugin disable` flips the flag; disabled plugins stay on disk but
    // are not resolved (core §5: enable/disable never delete files).
    if (rec?.enabled === false) {
      log.info("plugin disabled, skipping", { plugin: entry.name });
      continue;
    }
    if (rec?.tier !== "verified") {
      // honesty note (ADR-0002 §3): an untrusted plugin still loads in-process;
      // the install-time permission gate is the real boundary. Worker
      // isolation for `untrusted` is not implemented yet.
      log.warn("loading non-verified plugin in-process (ADR-0002 §3: the install-time gate is the boundary)", {
        plugin: entry.name,
        tier: rec?.tier ?? "untrusted",
      });
    }
    out.push({ dir: pdir, tier: rec?.tier ?? "untrusted", granted: rec?.permissions });
  }
  return out;
}
