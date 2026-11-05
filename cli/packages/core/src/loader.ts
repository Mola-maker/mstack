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
 */

import * as fs from "node:fs";
import * as path from "node:path";
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

/** Scan ~/.mola/plugins for installed third-party plugins (resolve only). */
export function scanUserPlugins(homeDir: string, log: Logger): PluginSource[] {
  const dir = path.join(homeDir, "plugins");
  if (!fs.existsSync(dir)) return [];
  // granted snapshots + tiers recorded by `mola plugin install` (B2)
  let registry: Record<string, { tier?: TrustTier; permissions?: PermissionSet; dir?: string }> = {};
  const registryFile = path.join(homeDir, "plugins.json");
  if (fs.existsSync(registryFile)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    } catch {
      log.warn("ignoring unparseable plugins.json", { file: registryFile });
    }
  }
  const out: PluginSource[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pdir = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(pdir, "mola-plugin.json"))) continue;
    const rec = registry[entry.name] ?? {};
    if (rec.tier !== "verified") {
      // honesty note (ADR-0002 §3): untrusted in-process loading is containment
      // by permission handles only until B2 ships worker isolation
      log.warn("loading non-verified plugin in-process (worker isolation lands in B2)", {
        plugin: entry.name,
      });
    }
    out.push({ dir: pdir, tier: rec.tier ?? "untrusted", granted: rec.permissions });
  }
  return out;
}
