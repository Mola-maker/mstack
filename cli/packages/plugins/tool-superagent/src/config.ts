/**
 * Instance configuration (B2f): the two dsh-superagent bots and their
 * Management API endpoints.
 *
 * Defaults (cli/design/inputs/superagent-ops.md):
 *   layerfs  → http://127.0.0.1:3082  (Ephemeral-AI-Lab/layerfs, profile
 *              superagent-layerfs)
 *   cad2gis  → http://127.0.0.1:3083  (Mola-maker/CAD2GIS, profile
 *              superagent-cad2gis)
 *
 * Overridable in ~/.mola/config.jsonc (JSONC layering, core §2.4) under
 * `superagent.instances`. A value is either the port number or an object
 * `{ port?, url? }` — the object form exists for a bot reachable under a
 * different host (e.g. a tunnelled remote later). Overriding REPLACES the
 * default set: the file is the single source of truth for which bots exist.
 */

import type { ConfigView } from "@mola/plugin-sdk";
import { MolaError, ExitCode } from "@mola/plugin-sdk";

export interface SuperagentInstance {
  name: string;
  port: number;
  /** base URL without trailing slash, e.g. http://127.0.0.1:3082 */
  url: string;
}

/** name → port for the two bots that run today. */
export const DEFAULT_INSTANCES: Record<string, number> = {
  layerfs: 3082,
  cad2gis: 3083,
};

export const INSTANCES_CONFIG_KEY = "superagent.instances";

function toInstance(name: string, value: unknown): SuperagentInstance {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return { name, port: value, url: `http://127.0.0.1:${value}` };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as { port?: unknown; url?: unknown };
    if (obj.url !== undefined) {
      if (typeof obj.url !== "string" || !/^https?:\/\//.test(obj.url)) {
        throw new MolaError(
          "CONFIG_INVALID",
          `${INSTANCES_CONFIG_KEY}.${name}.url must be an http(s) URL`,
          ExitCode.DataErr,
        );
      }
      const port = typeof obj.port === "number" ? obj.port : Number(new URL(obj.url).port) || 80;
      return { name, port, url: obj.url.replace(/\/+$/, "") };
    }
    if (typeof obj.port === "number" && Number.isInteger(obj.port) && obj.port > 0) {
      return { name, port: obj.port, url: `http://127.0.0.1:${obj.port}` };
    }
  }
  throw new MolaError(
    "CONFIG_INVALID",
    `${INSTANCES_CONFIG_KEY}.${name} must be a port number or { port?, url? }`,
    ExitCode.DataErr,
  );
}

/** Read the instance list from config (defaults when the key is absent). */
export function resolveInstances(config: ConfigView): SuperagentInstance[] {
  const raw = config.get<Record<string, unknown>>(INSTANCES_CONFIG_KEY, DEFAULT_INSTANCES);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MolaError(
      "CONFIG_INVALID",
      `${INSTANCES_CONFIG_KEY} must be an object { <name>: port | { port?, url? } }`,
      ExitCode.DataErr,
    );
  }
  return Object.entries(raw).map(([name, value]) => toInstance(name, value));
}

/**
 * The exact operator fix for a `setup.problem` code (superagent-ops.md: these
 * are operator steps — tell the user the exact command, never ask for a
 * secret). Unknown codes fall back to pointing at the ops doc.
 */
export function setupHint(code: string | undefined, port: number): string {
  switch (code) {
    case "agentCliSignedOut":
      return "sign the agent account in: in WSL run `gh-agent auth login`";
    case "repositoryUnset":
      return (
        "rerun configure: node ~/src/mola-dsh-stack/superagent/configure.mjs " +
        `--port ${port} --repo <org/repo> --clone <path> --allow Mola-maker`
      );
    default:
      return `no captured fix for "${code ?? "unknown problem"}" — see cli/design/inputs/superagent-ops.md`;
  }
}
