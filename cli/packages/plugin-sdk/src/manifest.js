/**
 * Plugin manifest types + validator (ADR-0002). `manifest.schema.json` at the
 * package root is the CI-checked contract; `validateManifest` is the runtime
 * implementation of it (no JSON-Schema dependency is allowed in B1).
 */
export const PLUGIN_KINDS = ["agent", "tool", "env", "sync", "command", "policy"];
const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PERMISSION_KEYS = ["process.exec", "fs.read", "fs.write", "net.connect", "env.read", "mola"];
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function checkStringArray(v, field, errors) {
    if (v === undefined)
        return;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
        errors.push(`${field} must be an array of strings`);
    }
}
/**
 * Validate a parsed `mola-plugin.json` value against the schema contract.
 * Returns human-readable errors; callers map failure to exit 65 (EX_DATAERR).
 */
export function validateManifest(input) {
    const errors = [];
    if (!isPlainObject(input)) {
        return { ok: false, errors: ["manifest must be a JSON object"] };
    }
    const m = input;
    if (m.schemaVersion !== 1)
        errors.push("schemaVersion must be 1");
    if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
        errors.push("id must be a kebab-case string matching /^[a-z0-9][a-z0-9.-]*$/");
    }
    if (typeof m.version !== "string" || !VERSION_RE.test(m.version)) {
        errors.push("version must be a semver string (x.y.z)");
    }
    if (typeof m.kind !== "string" || !PLUGIN_KINDS.includes(m.kind)) {
        errors.push(`kind must be one of: ${PLUGIN_KINDS.join(", ")}`);
    }
    if (m.displayName !== undefined && typeof m.displayName !== "string") {
        errors.push("displayName must be a string");
    }
    if (m.mola !== undefined && typeof m.mola !== "string") {
        errors.push("mola must be a semver range string");
    }
    if (m.engine !== undefined) {
        if (!isPlainObject(m.engine))
            errors.push("engine must be an object");
        else if (m.engine.node !== undefined && typeof m.engine.node !== "string") {
            errors.push("engine.node must be a string");
        }
    }
    // entry: exactly {ts} or {bin, protocol: "jsonrpc-stdio"}
    if (!isPlainObject(m.entry)) {
        errors.push("entry must be an object: {ts} or {bin, protocol: \"jsonrpc-stdio\"}");
    }
    else {
        const e = m.entry;
        const hasTs = typeof e.ts === "string";
        const hasBin = typeof e.bin === "string";
        if (hasTs && hasBin)
            errors.push("entry must not declare both ts and bin");
        else if (!hasTs && !hasBin)
            errors.push("entry must declare ts or bin");
        if (hasBin && e.protocol !== "jsonrpc-stdio") {
            errors.push("entry.protocol must be \"jsonrpc-stdio\" when entry.bin is used");
        }
        if (e.ts !== undefined && typeof e.ts !== "string")
            errors.push("entry.ts must be a string");
        if (e.bin !== undefined && typeof e.bin !== "string")
            errors.push("entry.bin must be a string");
    }
    checkStringArray(m.provides, "provides", errors);
    checkStringArray(m.requires, "requires", errors);
    checkStringArray(m.capabilities, "capabilities", errors);
    checkStringArray(m.conflicts, "conflicts", errors);
    checkStringArray(m.overrides, "overrides", errors);
    if (m.permissions !== undefined) {
        if (!isPlainObject(m.permissions)) {
            errors.push("permissions must be an object");
        }
        else {
            for (const key of Object.keys(m.permissions)) {
                if (!PERMISSION_KEYS.includes(key)) {
                    errors.push(`permissions: unknown key "${key}" (allowed: ${PERMISSION_KEYS.join(", ")})`);
                }
                else {
                    checkStringArray(m.permissions[key], `permissions.${key}`, errors);
                }
            }
        }
    }
    if (m.hooks !== undefined) {
        if (!isPlainObject(m.hooks))
            errors.push("hooks must be an object");
        else {
            checkStringArray(m.hooks.emit, "hooks.emit", errors);
            checkStringArray(m.hooks.listen, "hooks.listen", errors);
        }
    }
    if (m.configSchema !== undefined && !isPlainObject(m.configSchema)) {
        errors.push("configSchema must be an object");
    }
    if (errors.length > 0)
        return { ok: false, errors };
    return { ok: true, errors: [], manifest: m };
}
