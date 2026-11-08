/**
 * `mola notify` — tell the human. Channels come from config: `notify.ntfy`
 * (a full ntfy topic URL — a secret) and `notify.webhook` (JSON POST). stderr
 * always gets the text. Failures warn and never fail the caller.
 */

import type { PluginContext } from "@mola/plugin-sdk";

export type FetchLike = (url: string, init: { method: string; headers?: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface NotifyDeps {
  fetch?: FetchLike;
  /** stderr writer (injectable for tests) */
  stderr?: (line: string) => void;
  timeoutMs?: number;
}

/** `https://ntfy.sh/my-secret-topic` → `https://ntfy.sh/***`. The path is the secret; query and userinfo go too. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/***`;
  } catch {
    return "<invalid url>";
  }
}

/** Replace every occurrence of a channel URL (and its path alone) in a message. */
function scrub(message: string, urls: string[]): string {
  let out = message;
  for (const url of urls) {
    out = out.split(url).join(maskUrl(url));
    try {
      const u = new URL(url);
      const secret = u.pathname.replace(/^\/+/, "");
      if (secret.length >= 3) out = out.split(secret).join("***");
    } catch {
      // not a URL
    }
  }
  return out;
}

/** HTTP header values must be Latin-1; encode anything else as an RFC 2047 word (ntfy decodes it). */
export function headerSafe(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export interface NotifyResult {
  channels: Array<{ channel: "ntfy" | "webhook"; target: string; ok: boolean; error?: string }>;
}

function stringConfig(ctx: PluginContext, key: string): string | undefined {
  try {
    const v = ctx.config.get<unknown>(key);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Send `text` to every configured channel; always echo it on stderr. Never throws. */
export async function sendNotify(
  ctx: PluginContext,
  msg: { text: string; title?: string },
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const write = deps.stderr ?? ((l: string) => void process.stderr.write(l + "\n"));
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const title = msg.title?.trim() || "mola";
  write(`mola notify: ${title}: ${msg.text}`);

  const ntfy = stringConfig(ctx, "notify.ntfy");
  const webhook = stringConfig(ctx, "notify.webhook");
  const urls = [ntfy, webhook].filter((u): u is string => Boolean(u));
  const result: NotifyResult = { channels: [] };

  const post = async (
    channel: "ntfy" | "webhook",
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<void> => {
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      result.channels.push({ channel, target: maskUrl(url), ok: true });
    } catch (err) {
      const why = scrub(err instanceof Error ? err.message : String(err), urls);
      write(`mola notify: warning: ${channel} ${maskUrl(url)} failed: ${why}`);
      result.channels.push({ channel, target: maskUrl(url), ok: false, error: why });
    }
  };

  if (ntfy) await post("ntfy", ntfy, { Title: headerSafe(title) }, msg.text);
  if (webhook) {
    await post("webhook", webhook, { "Content-Type": "application/json" }, JSON.stringify({ title, text: msg.text }));
  }
  return result;
}
