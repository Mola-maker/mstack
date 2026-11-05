/**
 * JSONC parsing (core §2.4: JSONC everywhere, one parser, no YAML footguns).
 * Supports // line comments, block comments, and trailing commas — nothing else.
 * Parse failures map to CONFIG_INVALID / exit 65.
 */

import { MolaError, ExitCode } from "@mola/plugin-sdk";

/** Strip comments and trailing commas, preserving string contents. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      // copy the whole string verbatim
      out += c;
      i++;
      while (i < n) {
        const s = text[i];
        out += s;
        if (s === "\\") {
          if (i + 1 < n) out += text[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (s === '"') break;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // trailing commas: a comma whose next non-space char closes an object/array
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text: string, fileName = "config"): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (err) {
    throw new MolaError(
      "CONFIG_INVALID",
      `${fileName}: invalid JSONC — ${err instanceof Error ? err.message : String(err)}`,
      ExitCode.DataErr,
    );
  }
}
