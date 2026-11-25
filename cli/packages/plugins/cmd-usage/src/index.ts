/**
 * cmd-usage:
 *   mola usage [--days 7] [--by model|day|project|source] [--no-scan]
 *   mola usage prices                       where prices.json lives and what it holds
 */

import * as os from "node:os";
import * as path from "node:path";
import type { PluginContext } from "@mola/plugin-sdk";
import { ExitCode, MolaError, definePlugin, table } from "@mola/plugin-sdk";
import { aggregate, fmtTok, readLedger, readPrices, scanClaude, scanCodex, updateLedger, usageHome, type GroupBy } from "./usage.js";

export * from "./usage.js";

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["usage"],
      description: "tokens, cache hits and estimated cost from Claude Code / Codex transcripts (kept past their own deletion)",
      async handler(args, io) {
        const days = args.flags.days === undefined ? 7 : Number(args.flags.days);
        if (!(days > 0 && days <= 3650)) throw new MolaError("USAGE_ERROR", "--days is 1 to 3650", ExitCode.Usage);
        const by = (typeof args.flags.by === "string" ? args.flags.by : "model") as GroupBy;
        if (!["model", "day", "project", "source"].includes(by)) throw new MolaError("USAGE_ERROR", "--by model|day|project|source", ExitCode.Usage);
        const now = Date.now();
        const retention = ctx.config.get<unknown>("usage.retentionDays", 92);
        const keep = retention === "unlimited" ? "unlimited" : Number(retention) > 0 ? Number(retention) : 92;
        let scanned = { added: 0, total: 0 };
        if (args.flags["no-scan"] !== true) {
          // scan a little past the window the ledger keeps, so nothing between two scans is lost
          const since = keep === "unlimited" ? 0 : now - keep * 86400000;
          const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
          const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
          scanned = updateLedger([...scanClaude(claudeHome, since), ...scanCodex(codexHome, since)], keep, now);
        }
        const rows = readLedger().filter((r) => now - Date.parse(r.ts) <= days * 86400000);
        const buckets = aggregate(rows, by, readPrices());
        const total = aggregate(rows, "source", readPrices()).reduce(
          (t, b) => ({ cost: t.cost + b.cost, unpriced: t.unpriced + b.unpriced, output: t.output + b.output }),
          { cost: 0, unpriced: 0, output: 0 },
        );
        io.data({ days, by, scanned, buckets, totalCostUsd: total.cost, unpricedRows: total.unpriced });
        if (rows.length === 0) {
          io.out(`no usage in the last ${days} days (looked in Claude Code and Codex transcripts)`);
          return ExitCode.Ok;
        }
        for (const l of table({
          header: [by, "input", "output", "cache read", "cache write", "hit", "est. cost"],
          rows: buckets.map((b) => [
            b.key.length > 48 ? "…" + b.key.slice(-47) : b.key,
            fmtTok(b.input),
            fmtTok(b.output),
            fmtTok(b.cacheRead),
            fmtTok(b.cacheWrite),
            `${Math.round(b.cacheHit * 100)}%`,
            b.unpriced === b.rows ? "unpriced" : `$${b.cost.toFixed(2)}${b.unpriced ? "+" : ""}`,
          ]),
        }))
          io.out(l);
        io.out(`last ${days}d · est. $${total.cost.toFixed(2)} at API rates (not your subscription bill)${total.unpriced ? ` · ${total.unpriced} rows unpriced: add prices in ${path.join(usageHome(), "prices.json")}` : ""}`);
        return ExitCode.Ok;
      },
    });
    ctx.commands.register({
      path: ["usage", "prices"],
      description: "the price table used for cost estimates ($ per million tokens, by model id or prefix)",
      async handler(_args, io) {
        const prices = readPrices();
        const file = path.join(usageHome(), "prices.json");
        io.data({ file, prices });
        io.out(`file: ${file}`);
        io.out(Object.keys(prices).length ? JSON.stringify(prices, null, 2) : 'empty. Example: {"claude-opus": {"input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25}}');
        return ExitCode.Ok;
      },
    });
  },
});
