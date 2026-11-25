/**
 * cmd-mcp: `mola mcp [--cwd <repo>] [--operate] [--allow-auto]` — newline-delimited
 * JSON-RPC 2.0 on stdin/stdout (the MCP stdio transport). See server.ts.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { PluginContext } from "@mola/plugin-sdk";
import { ExitCode, MolaError, definePlugin, listProgress } from "@mola/plugin-sdk";
import { handle, type Grant, type Runner } from "./server.js";

export * from "./server.js";

export function realRunner(cwd: string, entry: string | undefined = process.argv[1]): Runner {
  if (!entry) throw new MolaError("NO_INPUT", "cannot find the mola entry point", ExitCode.NoInput);
  return {
    call(argv) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [entry, ...argv, "--json"], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.once("error", (e) => resolve({ ok: false, error: e.message }));
        child.once("exit", (code) => {
          let env: { data?: unknown } | undefined;
          try {
            env = JSON.parse(out) as { data?: unknown };
          } catch {
            env = undefined;
          }
          if (code === 0) return resolve({ ok: true, data: env?.data, text: out });
          let msg = err.trim();
          try {
            msg = (JSON.parse(err.trim().split("\n").pop() ?? "") as { error?: { message?: string } }).error?.message ?? msg;
          } catch {
            // plain text
          }
          resolve({ ok: false, error: msg || `exit ${code}`, ...(env?.data !== undefined ? { data: env.data } : {}) });
        });
      });
    },
    spawn(argv) {
      const child = spawn(process.execPath, [entry, ...argv], { cwd, windowsHide: true, stdio: "ignore", detached: true });
      child.unref();
    },
    async findRunByKey(key) {
      for (let i = 0; i < 50; i++) {
        const hit = listProgress(cwd).find((p) => p.key === key);
        if (hit) return hit.id;
        await new Promise((r) => setTimeout(r, 100));
      }
      return undefined;
    },
  };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["mcp"],
      description: "serve mstack to any MCP agent over stdio (read only by default; --operate, --allow-auto)",
      async handler(args, io) {
        const dir = typeof args.flags.cwd === "string" ? path.resolve(io.cwd, args.flags.cwd) : io.cwd;
        if (!fs.existsSync(dir)) throw new MolaError("NO_INPUT", `no such directory: ${dir}`, ExitCode.NoInput);
        const grant: Grant = { operate: args.flags.operate === true, allowAuto: args.flags["allow-auto"] === true };
        if (grant.allowAuto && !grant.operate) throw new MolaError("USAGE_ERROR", "--allow-auto needs --operate", ExitCode.Usage);
        const runner = realRunner(dir);
        const rl = readline.createInterface({ input: process.stdin });
        const pending: Promise<void>[] = [];
        for await (const line of rl) {
          if (!line.trim()) continue;
          let req;
          try {
            req = JSON.parse(line);
          } catch {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
            continue;
          }
          pending.push(
            handle(req, grant, runner).then((res) => {
              if (res) process.stdout.write(JSON.stringify(res) + "\n");
            }),
          );
        }
        await Promise.all(pending);
        return ExitCode.Ok;
      },
    });
  },
});
