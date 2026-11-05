/**
 * cmd-dispatch (B1 workhorse — DESIGN §10/§11 conflict 9): a thin wrapper over
 * today's tested DSH headless flow (tasks/dispatch.sh):
 *
 *   mola dispatch <task-file|-> [--agent dsh] [--route <id>] [--yes] [--json]
 *
 * Per run mola writes the group/smart-split magpie overlay (route whitelist is
 * enforced by the policy-approval gate on `mola.task.pre-dispatch`, the
 * conservative argv classifier on `mola.tool.before`), then runs
 *
 *   bash -lc 'source ~/src/mola-dsh-stack/scripts/env.sh; cd <wsl-cwd>; \
 *     dsh --profile mola-cli --patch <overlay> --json - < <task>'
 *
 * (through `wsl -e bash -lc …` on Windows), tees stdout+stderr to
 * logs/dispatch-<runId>.out ending with `exit=N`, records the run in state and
 * emits the canonical ADR-0004 events. The runId is the invocation's traceId.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginContext } from "@mola/plugin-sdk";
import { definePlugin, ExitCode, MolaEvents, MolaError } from "@mola/plugin-sdk";
import {
  DISPATCH_TIMEOUT_MS,
  DEFAULT_ROUTE,
  dshMachine,
  onWindows,
  shellQuote,
  winToWslPath,
  wslFileRef,
} from "./platform.js";
import { buildBashScript, dispatchArgv, extractFinalText, overlayYaml } from "./plan.js";

const USAGE = "usage: mola dispatch <task-file|-> [--agent dsh] [--route <id>] [--yes] [--json]";

function readStdin(): string {
  return fs.readFileSync(0, "utf8");
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["dispatch"],
      description: "run one task through the DSH headless worker (WSL, profile mola-cli)",
      async handler(args, io) {
        const taskArg = args.positionals[0];
        if (!taskArg) throw new MolaError("USAGE_ERROR", USAGE, ExitCode.Usage);

        const agent = typeof args.flags.agent === "string" ? args.flags.agent : "dsh";
        if (agent !== "dsh") {
          // B1 ships only the dsh adapter (DESIGN §11 conflict 8); unknown ⇒ 66
          throw new MolaError("NO_INPUT", `agent "${agent}" has no adapter in B1 (dsh only)`, ExitCode.NoInput);
        }
        const requestedRoute =
          typeof args.flags.route === "string"
            ? args.flags.route
            : ctx.config.get<string>("dispatch.route", DEFAULT_ROUTE);

        const windows = onWindows();
        const machine = dshMachine();
        const runId = io.traceId;
        const cwdPosix = windows ? winToWslPath(io.cwd) : io.cwd.replace(/\/+$/, "");
        if (!cwdPosix) {
          throw new MolaError("NO_INPUT", `cannot map working directory into WSL: ${io.cwd}`, ExitCode.NoInput);
        }

        // resolve the task: "-" reads stdin, otherwise the file must exist
        let stdinTask: string | undefined;
        let taskRef: string | undefined;
        let taskChars = 0;
        if (taskArg === "-") {
          stdinTask = readStdin();
          taskChars = stdinTask.length;
        } else {
          const abs = path.resolve(io.cwd, taskArg);
          let content: string;
          try {
            content = ctx.fs.readFile(abs);
          } catch {
            throw new MolaError("NO_INPUT", `task file not found: ${taskArg}`, ExitCode.NoInput);
          }
          taskChars = content.length;
          taskRef = wslFileRef(io.cwd, abs, windows) ?? undefined;
          if (!taskRef) {
            throw new MolaError("NO_INPUT", `cannot map task file into WSL: ${abs}`, ExitCode.NoInput);
          }
        }
        if (taskChars === 0) {
          throw new MolaError("NO_INPUT", "dispatch: task text is empty", ExitCode.NoInput);
        }

        // gate 1 — routing policy (route whitelist; rejection ⇒ exit 77)
        const approved = (await ctx.events.runWaterfall(MolaEvents.TaskPreDispatch, {
          agent,
          machine,
          modelRoute: requestedRoute,
          task: taskArg,
          taskChars,
          runId,
          cwd: io.cwd,
          yes: io.yes,
        })) as { modelRoute: string };
        const route = approved.modelRoute;

        const overlayRef = `.mstack/runs/${runId}/model-overlay.yml`;
        const logRef = `logs/dispatch-${runId}.out`;
        ctx.fs.writeFile(path.join(io.cwd, overlayRef), overlayYaml(route));

        const script = buildBashScript({ cwdPosix, overlayPath: overlayRef, taskPath: taskRef });
        const argv = dispatchArgv(script, windows);

        // gate 2 — conservative argv classifier (policy-approval)
        await ctx.events.runWaterfall(MolaEvents.ToolBefore, {
          tool: "dsh",
          argv,
          callId: runId,
          runId,
          cwd: io.cwd,
          yes: io.yes,
        });

        const startedAt = new Date().toISOString();
        const t0 = Date.now();
        ctx.events.emit(MolaEvents.SessionStarted, {
          agent: "dsh",
          sessionId: runId,
          cwd: io.cwd,
          machine,
          modelRoute: route,
        });

        let res;
        try {
          res = await ctx.process.exec(argv, {
            cwd: io.cwd,
            ...(stdinTask !== undefined ? { input: stdinTask } : {}),
            timeoutMs: DISPATCH_TIMEOUT_MS,
            ...(windows ? { env: { MSYS_NO_PATHCONV: "1" } } : {}),
          });
        } catch (err) {
          // timeout / spawn failure: leave a log that ends with exit=124, then 69
          try {
            ctx.fs.writeFile(
              path.join(io.cwd, logRef),
              `mola: dispatch aborted: ${err instanceof Error ? err.message : String(err)}\nexit=124\n`,
            );
          } catch {
            /* the timeout error matters more than the log failure */
          }
          ctx.events.emit(MolaEvents.SessionEnded, { sessionId: runId, exitCode: 124, reason: "aborted" });
          throw err;
        }

        const durationMs = Date.now() - t0;
        const { finalText } = extractFinalText(res.stdout);
        ctx.fs.writeFile(
          path.join(io.cwd, logRef),
          res.stdout +
            (res.stderr ? `\n--- stderr ---\n${res.stderr}\n` : "") +
            `exit=${res.code}\n`,
        );

        ctx.events.emit(MolaEvents.ToolAfter, {
          callId: runId,
          tool: "dsh",
          ok: res.code === 0,
          durationMs,
          outputSummary: finalText ? finalText.slice(0, 200) : "",
        });
        if (res.code === 0) {
          ctx.events.emit(MolaEvents.TaskDone, { runId, sessionId: runId, evidence: logRef });
        } else {
          ctx.events.emit(MolaEvents.ErrorRaised, {
            kind: "crash",
            sessionId: runId,
            detail: `dsh exited ${res.code} — see ${logRef}`,
          });
        }
        ctx.events.emit(MolaEvents.SessionEnded, { sessionId: runId, exitCode: res.code });

        ctx.state.set(`run:${runId}`, {
          runId,
          traceId: io.traceId,
          command: "dispatch",
          argv: [taskArg, ...(typeof args.flags.route === "string" ? ["--route", args.flags.route] : [])],
          agent,
          machine,
          modelRoute: route,
          overlayFile: overlayRef,
          logFile: logRef,
          exitCode: res.code,
          startedAt,
          durationMs,
        });

        io.data({
          runId,
          traceId: io.traceId,
          agent,
          machine,
          modelRoute: route,
          task: taskArg,
          exitCode: res.code,
          durationMs,
          logFile: logRef,
          overlayFile: overlayRef,
          finalText,
        });
        if (!io.json) {
          if (finalText) io.out(finalText);
          else io.note(`no final answer on stdout (dsh exit ${res.code}) — see ${logRef}`);
        }
        return (res.code === 0 ? ExitCode.Ok : res.code) as ExitCode;
      },
    });
  },
});

// re-exported for tests without reaching into private module paths
export { buildBashScript, dispatchArgv, extractFinalText, overlayYaml, shellQuote, winToWslPath, wslFileRef };
