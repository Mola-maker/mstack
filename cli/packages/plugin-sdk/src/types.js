/**
 * The plugin contract (core §2.2). This package is the single definition point
 * for all interfaces (DESIGN §11 conflict 3); core implements them, plugins
 * consume them.
 */
export function definePlugin(p) {
    return p;
}
