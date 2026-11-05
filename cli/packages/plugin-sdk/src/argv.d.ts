/**
 * Minimal positional/flag parsing shared by the router and command handlers.
 * Supports: --flag, --flag=value, --flag value, `--` separator. Short flags are
 * treated as booleans (global short flags like -v are consumed by the bin).
 */
import type { ParsedArgs } from "./types.js";
export declare function parseArgv(tokens: string[]): ParsedArgs;
