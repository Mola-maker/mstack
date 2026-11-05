/**
 * policy-approval (B1): the two policy gates on the mola hook bus (core §3,
 * DESIGN §11 conflict 12 — waterfall listeners may reject; the rejection IS
 * the denial path and the router maps it to exit 77):
 *
 *  - `mola.task.pre-dispatch` → route whitelist (ADR-0003 §2): group/*, auto/*
 *    allowed; deepseek/* banned → ROUTE_BANNED, exit 77, before any worker
 *    starts. `--yes` does not bypass it.
 *  - `mola.tool.before` → conservative argv classifier (BRIEF #7): outward /
 *    destructive commands are held unless `--yes` (MOLA_YES=1) or a human
 *    approved; every hold emits `mola.approval.denied` (or `.granted` when
 *    --yes lets it through) so the bus records the decision.
 *
 * Note on the core death-loop brake: three consecutive waterfall rejections by
 * this plugin quarantine it (core §3). That is the designed stop for a policy
 * plugin that keeps denying — the human is meant to look.
 */

import type { ConfigView, PluginContext } from "@mola/plugin-sdk";
import { definePlugin, ExitCode, MolaError, MolaEvents, PolicyDenial } from "@mola/plugin-sdk";
import {
  DEFAULT_ALLOWED_HEADLESS,
  DEFAULT_BANNED_HEADLESS,
  checkModelRoute,
  type RoutePolicy,
} from "./routes.js";
import { classifyToolCall, type ToolCall } from "./classifier.js";

export function routePolicyFromConfig(config: ConfigView): RoutePolicy {
  return {
    allowedHeadless: config.get<string[]>(
      "policy.modelRoutes.allowedHeadless",
      DEFAULT_ALLOWED_HEADLESS,
    ),
    bannedHeadless: config.get<string[]>("policy.modelRoutes.bannedHeadless", DEFAULT_BANNED_HEADLESS),
  };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.events.hook(MolaEvents.TaskPreDispatch, (value) => {
      const req = (value ?? {}) as { modelRoute?: string };
      if (typeof req.modelRoute !== "string" || !req.modelRoute) {
        throw new PolicyDenial(
          "pre-dispatch: no modelRoute — magpie owns the model, dispatch must name a route",
        );
      }
      const verdict = checkModelRoute(req.modelRoute, routePolicyFromConfig(ctx.config));
      if (!verdict.ok) {
        throw new MolaError(verdict.code, verdict.message, ExitCode.NoPerm);
      }
      return value;
    });

    ctx.events.hook(MolaEvents.ToolBefore, (value) => {
      const call = (value ?? {}) as ToolCall;
      const verdict = classifyToolCall(call);
      if (verdict.action !== "deny") return value;
      if (call.yes) {
        ctx.events.emit(MolaEvents.ApprovalGranted, {
          action: verdict.rule,
          rule: verdict.rule,
          approver: "--yes",
        });
        return value;
      }
      ctx.events.emit(MolaEvents.ApprovalDenied, {
        action: verdict.rule,
        rule: verdict.rule,
        reason: verdict.reason,
      });
      throw new PolicyDenial(verdict.reason, { rule: verdict.rule });
    });
  },
});

export { checkModelRoute, classifyToolCall };
