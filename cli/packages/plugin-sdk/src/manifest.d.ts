/**
 * Plugin manifest types + validator (ADR-0002). `manifest.schema.json` at the
 * package root is the CI-checked contract; `validateManifest` is the runtime
 * implementation of it (no JSON-Schema dependency is allowed in B1).
 */
export type PluginKind = "agent" | "tool" | "env" | "sync" | "command" | "policy";
export type TrustTier = "builtin" | "verified" | "untrusted";
export declare const PLUGIN_KINDS: readonly PluginKind[];
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
    engine?: {
        node?: string;
    };
    entry: {
        ts?: string;
        bin?: string;
        protocol?: "jsonrpc-stdio";
    };
    provides?: string[];
    requires?: string[];
    capabilities?: string[];
    permissions?: PermissionSet;
    hooks?: {
        emit?: string[];
        listen?: string[];
    };
    conflicts?: string[];
    overrides?: string[];
    configSchema?: Record<string, unknown>;
}
export interface ManifestValidation {
    ok: boolean;
    errors: string[];
    manifest?: PluginManifest;
}
/**
 * Validate a parsed `mola-plugin.json` value against the schema contract.
 * Returns human-readable errors; callers map failure to exit 65 (EX_DATAERR).
 */
export declare function validateManifest(input: unknown): ManifestValidation;
