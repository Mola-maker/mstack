/**
 * Plugin manifest types + validator (ADR-0002). `manifest.schema.json` at the
 * package root is the CI-checked contract; `validateManifest` is the runtime
 * implementation of it (no JSON-Schema dependency is allowed in B1).
 */

export type PluginKind = "agent" | "tool" | "env" | "sync" | "command" | "policy";
export type TrustTier = "builtin" | "verified" | "untrusted";

export const PLUGIN_KINDS: readonly PluginKind[] = ["agent", "tool", "env", "sync", "command", "policy"];

/** Permission model (core §6). Enforcement point: the ctx.* handles. */
export interface PermissionSet {
  /** argv[0] allow-list, e.g. ["claude", "dsh", "gh"] */
  "process.exec"?: string[];
  "fs.read"?: string[];
  "fs.write"?: string[];
  /** host[:port] globs */
  "net.connect"?: string[];
  /** name globs, e.g. ["MOLA_*", "ANTHROPIC_*"] */
  "env.read"?: string[];
  /** mola capabilities: events, config.read, config.write, state.kv, commands, doctor, … */
  mola?: string[];
}

export interface PluginManifest {
  schemaVersion: 1;
  /** unique, kebab-case, e.g. mola-agent-claude */
  id: string;
  version: string;
  kind: PluginKind;
  displayName?: string;
  /** core API semver range, e.g. ">=0.1.0 <1.0.0" */
  mola?: string;
  engine?: { node?: string };
  entry: { ts?: string; bin?: string; protocol?: "jsonrpc-stdio" };
  provides?: string[];
  requires?: string[];
  capabilities?: string[];
  permissions?: PermissionSet;
  hooks?: { emit?: string[]; listen?: string[] };
  conflicts?: string[];
  overrides?: string[];
  configSchema?: Record<string, unknown>;
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  manifest?: PluginManifest;
}

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PERMISSION_KEYS = ["process.exec", "fs.read", "fs.write", "net.connect", "env.read", "mola"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkStringArray(v: unknown, field: string, errors: string[]): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    errors.push(`${field} must be an array of strings`);
  }
}

/**
 * Validate a parsed `mola-plugin.json` value against the schema contract.
 * Returns human-readable errors; callers map failure to exit 65 (EX_DATAERR).
 */
export function validateManifest(input: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }
  const m = input as Record<string, unknown>;

  if (m.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    errors.push("id must be a kebab-case string matching /^[a-z0-9][a-z0-9.-]*$/");
  }
  if (typeof m.version !== "string" || !VERSION_RE.test(m.version)) {
    errors.push("version must be a semver string (x.y.z)");
  }
  if (typeof m.kind !== "string" || !PLUGIN_KINDS.includes(m.kind as PluginKind)) {
    errors.push(`kind must be one of: ${PLUGIN_KINDS.join(", ")}`);
  }
  if (m.displayName !== undefined && typeof m.displayName !== "string") {
    errors.push("displayName must be a string");
  }
  if (m.mola !== undefined && typeof m.mola !== "string") {
    errors.push("mola must be a semver range string");
  }
  if (m.engine !== undefined) {
    if (!isPlainObject(m.engine)) errors.push("engine must be an object");
    else if (m.engine.node !== undefined && typeof m.engine.node !== "string") {
      errors.push("engine.node must be a string");
    }
  }

  // entry: exactly {ts} or {bin, protocol: "jsonrpc-stdio"}
  if (!isPlainObject(m.entry)) {
    errors.push("entry must be an object: {ts} or {bin, protocol: \"jsonrpc-stdio\"}");
  } else {
    const e = m.entry;
    const hasTs = typeof e.ts === "string";
    const hasBin = typeof e.bin === "string";
    if (hasTs && hasBin) errors.push("entry must not declare both ts and bin");
    else if (!hasTs && !hasBin) errors.push("entry must declare ts or bin");
    if (hasBin && e.protocol !== "jsonrpc-stdio") {
      errors.push("entry.protocol must be \"jsonrpc-stdio\" when entry.bin is used");
    }
    if (e.ts !== undefined && typeof e.ts !== "string") errors.push("entry.ts must be a string");
    if (e.bin !== undefined && typeof e.bin !== "string") errors.push("entry.bin must be a string");
  }

  checkStringArray(m.provides, "provides", errors);
  checkStringArray(m.requires, "requires", errors);
  checkStringArray(m.capabilities, "capabilities", errors);
  checkStringArray(m.conflicts, "conflicts", errors);
  checkStringArray(m.overrides, "overrides", errors);

  if (m.permissions !== undefined) {
    if (!isPlainObject(m.permissions)) {
      errors.push("permissions must be an object");
    } else {
      for (const key of Object.keys(m.permissions)) {
        if (!(PERMISSION_KEYS as readonly string[]).includes(key)) {
          errors.push(`permissions: unknown key "${key}" (allowed: ${PERMISSION_KEYS.join(", ")})`);
        } else {
          checkStringArray(m.permissions[key], `permissions.${key}`, errors);
        }
      }
    }
  }

  if (m.hooks !== undefined) {
    if (!isPlainObject(m.hooks)) errors.push("hooks must be an object");
    else {
      checkStringArray(m.hooks.emit, "hooks.emit", errors);
      checkStringArray(m.hooks.listen, "hooks.listen", errors);
    }
  }

  if (m.configSchema !== undefined && !isPlainObject(m.configSchema)) {
    errors.push("configSchema must be an object");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], manifest: m as unknown as PluginManifest };
}
