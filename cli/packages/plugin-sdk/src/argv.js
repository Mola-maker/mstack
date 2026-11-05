/**
 * Minimal positional/flag parsing shared by the router and command handlers.
 * Supports: --flag, --flag=value, --flag value, `--` separator. Short flags are
 * treated as booleans (global short flags like -v are consumed by the bin).
 */
export function parseArgv(tokens) {
    const positionals = [];
    const flags = {};
    let rest = false;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (rest) {
            positionals.push(t);
            continue;
        }
        if (t === "--") {
            rest = true;
            continue;
        }
        if (t.startsWith("--")) {
            const eq = t.indexOf("=");
            if (eq >= 0) {
                flags[t.slice(2, eq)] = t.slice(eq + 1);
            }
            else if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
                flags[t.slice(2)] = tokens[++i];
            }
            else {
                flags[t.slice(2)] = true;
            }
            continue;
        }
        if (t.startsWith("-") && t.length > 1) {
            flags[t.slice(1)] = true;
            continue;
        }
        positionals.push(t);
    }
    return { positionals, flags };
}
