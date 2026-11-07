/**
 * cmd-model (B1): `mola model show <agent> | set <agent> <route> | routes` —
 * a thin passthrough to magpie (DESIGN §10; BRIEF #3: magpie picks the model,
 * mola only names route ids and never edits an agent config).
 *
 * - `model show <agent>`: the route magpie currently pins for the agent.
 *   For dsh the WSL dispatch profile wins (DESIGN §11 conflict 7: mola-cli is
 *   the dispatch profile), so the route comes from the
 *   `DeepSeek Harness · WSL Ubuntu` row whose config is a cordis.patch.yml —
 *   reported as source "profile patch".
 * - `model set <agent> <route>`: validates the route against the whitelist
 *   locally (same rule as the policy plugin: group/*, auto/* allowed;
 *   deepseek/* banned — ROUTE_BANNED, exit 77), then runs `magpie <agent>
 *   <route>` verbatim. It never writes a config file itself.
 * - `models rank [kind] [--json]`: the ranked routes per task kind from
 *   config/model-routing.json (FRAMEWORK §12.3), each with its whitelist verdict.
 * - `model routes`: the route ids `magpie models` knows, each marked with
 *   whether the whitelist allows it.
 */

import type { PluginContext } from "@mola/plugin-sdk";
import { definePlugin, detectColor, MolaError, ExitCode, palette, statusGlyph, table } from "@mola/plugin-sdk";
import {
  createMagpieRunner,
  parseMagpieLs,
  parseMagpieRoutes,
  type MagpieAgentRow,
  type MagpieRunner,
} from "./magpie.js";
import {
  DEFAULT_ALLOWED_ROUTES,
  DEFAULT_BANNED_ROUTES,
  classifyRoute,
  stripMagpiePrefix,
} from "./whitelist.js";
import { loadRankTable } from "./routing.js";

const runners = new WeakMap<PluginContext, MagpieRunner>();

function magpie(ctx: PluginContext): MagpieRunner {
  let r = runners.get(ctx);
  if (!r) {
    r = createMagpieRunner({ exec: ctx.process, timeoutMs: 30_000 });
    runners.set(ctx, r);
  }
  return r;
}

function routeLists(ctx: PluginContext): { allowed: string[]; banned: string[] } {
  return {
    allowed: ctx.config.get<string[]>("model.allowedRoutes", DEFAULT_ALLOWED_ROUTES),
    banned: ctx.config.get<string[]>("model.bannedRoutes", DEFAULT_BANNED_ROUTES),
  };
}

function requireAgent(args: { positionals: string[] }, usage: string): string {
  const id = args.positionals[0];
  if (!id) throw new MolaError("USAGE_ERROR", usage, ExitCode.Usage);
  return id;
}

/**
 * The magpie row for an agent id. Bare ids that exist on several machines
 * resolve to the WSL one when there is a choice (dsh's dispatch profile,
 * DESIGN §11 conflict 7); an id with an explicit @machine suffix matches it.
 */
export function pickMagpieRow(rows: MagpieAgentRow[], id: string): MagpieAgentRow | undefined {
  const base = id.split("@")[0];
  const exact = rows.find((r) => r.id === id);
  const matches = rows.filter((r) => r.id.split("@")[0] === base);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return matches.find((r) => r.id.includes("@wsl:")) ?? exact ?? matches[0];
}

/** "profile patch" when magpie manages the route through a cordis.patch.yml. */
export function routeSource(configPath: string | undefined): string {
  return configPath && configPath.endsWith("cordis.patch.yml") ? "profile patch" : "magpie";
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["model", "show"],
      description: "the model route magpie pins for an agent (thin passthrough)",
      async handler(args, io) {
        const id = requireAgent(args, "usage: mola model show <agent>");
        const res = await magpie(ctx).run(["ls"]);
        if (res.unavailable) {
          throw new MolaError(
            "UPSTREAM_UNAVAILABLE",
            `cannot show model for "${id}": magpie is not reachable (${res.unavailable})`,
            ExitCode.Unavailable,
          );
        }
        if (res.code !== 0) {
          throw new MolaError(
            "UPSTREAM_UNAVAILABLE",
            `magpie ls failed: ${res.stderr || `exit ${res.code}`}`,
            ExitCode.Unavailable,
          );
        }
        const rows = parseMagpieLs(res.stdout);
        const row = pickMagpieRow(rows, id);
        if (!row) {
          throw new MolaError("AGENT_NOT_FOUND", `unknown agent: ${id}`, ExitCode.NoInput, {
            id,
            known: rows.map((r) => r.id),
          });
        }
        const route = stripMagpiePrefix(row.model);
        const source = routeSource(row.configPath);
        if (io.json) {
          io.data({ agent: id, magpieId: row.id, route, source, configPath: row.configPath });
        } else {
          const paint = palette(detectColor());
          io.out(`${statusGlyph(route ? "ok" : "warn", paint)}  ${route ?? "-"}  (source: ${source})`);
        }
        return ExitCode.Ok;
      },
    });

    ctx.commands.register({
      path: ["model", "set"],
      description: "set an agent's model route via magpie (whitelist-enforced)",
      async handler(args, io) {
        const id = requireAgent(args, "usage: mola model set <agent> <route>");
        const route = args.positionals[1];
        if (!route) {
          throw new MolaError("USAGE_ERROR", "usage: mola model set <agent> <route>", ExitCode.Usage);
        }
        const { allowed, banned } = routeLists(ctx);
        const verdict = classifyRoute(route, allowed, banned);
        if (!verdict.ok) {
          throw new MolaError(
            verdict.reason === "banned" ? "ROUTE_BANNED" : "POLICY_DENIED",
            verdict.message,
            ExitCode.NoPerm,
            { agent: id, route, allowed, banned },
          );
        }
        const res = await magpie(ctx).run([id, route]);
        if (res.unavailable) {
          throw new MolaError(
            "UPSTREAM_UNAVAILABLE",
            `cannot set model for "${id}": magpie is not reachable (${res.unavailable})`,
            ExitCode.Unavailable,
          );
        }
        if (res.code !== 0) {
          throw new MolaError(
            "UPSTREAM_UNAVAILABLE",
            `magpie ${id} ${route} failed: ${res.stderr || `exit ${res.code}`}`,
            ExitCode.Unavailable,
          );
        }
        if (io.json) {
          io.data({ agent: id, route, via: res.argv.join(" ") });
        } else {
          io.out(`${id} → ${route} (via ${res.argv.join(" ")})`);
        }
        return ExitCode.Ok;
      },
    });

    ctx.commands.register({
      path: ["models", "rank"],
      description: "ranked model routes per task kind (config/model-routing.json)",
      async handler(args, io) {
        const loaded = loadRankTable();
        if (typeof loaded === "string") {
          throw new MolaError("NO_INPUT", loaded, ExitCode.NoInput);
        }
        const kind = args.positionals[0];
        if (kind && !loaded.tasks[kind]) {
          throw new MolaError(
            "USAGE_ERROR",
            `unknown task kind "${kind}" (known: ${Object.keys(loaded.tasks).join(", ")})`,
            ExitCode.Usage,
            { kind, known: Object.keys(loaded.tasks) },
          );
        }
        const { allowed, banned } = routeLists(ctx);
        const kinds = kind ? [kind] : Object.keys(loaded.tasks);
        const rows = kinds.map((k) => {
          const task = loaded.tasks[k];
          return {
            kind: k,
            desc: task.desc,
            unverified: task.unverified === true,
            evidence: task.evidence,
            ...(task.note ? { note: task.note } : {}),
            picks: task.picks.map((route, i) => {
              const verdict = classifyRoute(route, allowed, banned);
              return { rank: i + 1, route, allowed: verdict.ok, ...(verdict.ok ? {} : { reason: verdict.reason }) };
            }),
          };
        });
        if (io.json) {
          io.data({ file: loaded.file, updated: loaded.updated, allowed, banned, tasks: rows });
          return ExitCode.Ok;
        }
        const paint = palette(detectColor());
        const body: string[][] = [];
        for (const row of rows) {
          row.picks.forEach((p, i) => {
            const glyph = statusGlyph(p.allowed ? "ok" : "fail", paint);
            body.push([i === 0 ? row.kind : "", String(p.rank), glyph, p.route, i === 0 ? `${row.unverified ? "(unverified) " : ""}${row.evidence ?? ""}` : ""]);
          });
        }
        for (const line of table({ header: ["kind", "#", "", "route", "evidence"], rows: body })) io.out(line);
        return ExitCode.Ok;
      },
    });

    ctx.commands.register({
      path: ["model", "routes"],
      description: "the route ids magpie knows, with the whitelist verdict for each",
      async handler(_args, io) {
        const res = await magpie(ctx).run(["models"]);
        if (res.unavailable) {
          throw new MolaError(
            "UPSTREAM_UNAVAILABLE",
            `cannot list routes: magpie is not reachable (${res.unavailable})`,
            ExitCode.Unavailable,
          );
        }
        if (res.code !== 0) {
          throw new MolaError(
            "UPSTREAM_UNAVAILABLE",
            `magpie models failed: ${res.stderr || `exit ${res.code}`}`,
            ExitCode.Unavailable,
          );
        }
        const { allowed, banned } = routeLists(ctx);
        const routes = parseMagpieRoutes(res.stdout).map((id) => {
          const verdict = classifyRoute(id, allowed, banned);
          return { id, allowed: verdict.ok, reason: verdict.ok ? undefined : verdict.reason };
        });
        if (io.json) {
          io.data({ allowed, banned, routes });
        } else {
          const paint = palette(detectColor());
          const body = routes.map((r) => {
            const glyph = statusGlyph(r.allowed ? "ok" : r.reason === "banned" ? "fail" : "warn", paint);
            const verdict = r.allowed ? "allowed" : r.reason === "banned" ? "banned" : "not-allowed";
            return [glyph, verdict, r.id];
          });
          for (const line of table({ header: ["", "verdict", "route"], rows: body })) io.out(line);
        }
        return ExitCode.Ok;
      },
    });
  },
});

export { classifyRoute, globToRegExp, stripMagpiePrefix } from "./whitelist.js";
export { loadRankTable, routingFilePath } from "./routing.js";
export { DEFAULT_ALLOWED_ROUTES, DEFAULT_BANNED_ROUTES } from "./whitelist.js";
export {
  createMagpieRunner,
  parseMagpieLs,
  parseMagpieRoutes,
  stripLogNoise,
  resolveMagpieBinary,
} from "./magpie.js";
