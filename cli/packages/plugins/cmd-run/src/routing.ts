/**
 * The model layer of `mola run` (FRAMEWORK §12.3).
 *
 * `config/model-routing.json` in the mstack checkout is the one file shared by
 * the skills and the CLI: `tasks[kind].picks` ranks magpie routes per task
 * kind, `families[family]` says how to shape a prompt for that model family.
 *
 * This module is pure data handling: find and load the file, infer a task
 * kind from the prompt, turn the picks into a primary route plus a quota
 * ladder (policy whitelist applied), and wrap a prompt with the family
 * adapter. A missing file is not an error — `mola run` then keeps its old
 * policy-only behaviour.
 */

import {
  loadRoutingFile,
  normalizeRouting,
  routingFilePath,
  type RoutingFamily,
  type RoutingLoadOptions,
  type RoutingTable,
  type RoutingTask,
} from "@mola/plugin-sdk";
import { checkRoute, type PolicyModelRoutes } from "./policy.js";

// The loader lives in @mola/plugin-sdk (shared with cmd-model); re-exported here.
export { loadRoutingFile, normalizeRouting, routingFilePath };
export type { RoutingFamily, RoutingLoadOptions, RoutingTable, RoutingTask };

/** Load the routing table; null when the file is absent or unusable (use `loadRoutingFile` for the warning). */
export function loadRouting(opts: RoutingLoadOptions = {}): RoutingTable | null {
  return loadRoutingFile(opts).table;
}

/**
 * Weighted kind classifier. Every kind has signals `[pattern, weight]`; a kind
 * scores the sum of the weights of the signals that match. Strong signals
 * (verbs plus their object: "add … test", "translate … module") weigh 3-4,
 * ambiguous words (design, spec, image, ui, verify) weigh 1 or nothing alone.
 * The winner must reach MIN_SCORE and lead the runner-up by MIN_MARGIN;
 * otherwise the guess is not trusted and the caller uses the policy default.
 */
const LANGS = "rust|python|go|golang|typescript|javascript|java|c\\+\\+|c#|kotlin|swift|ruby|php|zig";
const CODE_NOUNS = "module|function|class|codebase|library|script|package|repo|code";
const SIGNALS: Record<string, Array<[RegExp, number]>> = {
  implement: [
    [/\b(implement|build|create|refactor|rewrite|migrate|fix|add|port|delete|remove|rename|wire up)\b/i, 2],
    [new RegExp(`\\b(translate|port|convert|rewrite)\\b[^.\\n]*\\b(to|into)\\s+(${LANGS})\\b`, "i"), 4],
    [new RegExp(`\\btranslate\\b[^.\\n]*\\b(${CODE_NOUNS})\\b`, "i"), 4],
    [/\b(implement|build|code)\b[^.\n]*\b(design|spec|rfc|plan|proposal)\b/i, 2],
    [/实现|重构|新增|修改|迁移|删除/, 3],
  ],
  debug: [
    [/\b(debug|stack ?trace|root cause|crash(es|ed)?|traceback|flaky|regression)\b/i, 3],
    [/\b(bug|failing|fails|broken|exception)\b/i, 2],
    [/报错|崩溃|调试|排查/, 3],
  ],
  review: [
    [/\b(code ?review|review|audit|critique)\b/i, 3],
    [/\bverify\b/i, 1],
    [/审查|评审|复核/, 3],
  ],
  test: [
    [/\b(add|write|create|extend)\b[^.\n]{0,20}\b(tests?|specs?)\b/i, 4],
    [/\b(tests?|testing|coverage|e2e|test suite|test cases?)\b/i, 2],
    [/写测试|补测试|测试用例/, 4],
  ],
  frontend: [
    [/\b(frontend|front-end|css|html|react|vue|astro|tailwind|animation|responsive|landing page)\b/i, 2],
    [/\b(ui|layout|page|component)\b/i, 1],
    [/前端|页面|样式|动画/, 2],
  ],
  vision: [
    [/\b(screenshot|screen ?shot|figma|mockup|wireframe)\b/i, 3],
    [/\.(png|jpe?g|webp|gif)\b/i, 3],
    [/\b(look at|see|describe|analy[sz]e|read|inspect)\b[^.\n]{0,20}\b(image|picture|photo)\b/i, 3],
    [/截图|图片/, 3],
  ],
  plan: [
    [/\b(plan|architecture|roadmap|rfc|trade-?offs?)\b/i, 3],
    [/\b(design|spec)\b/i, 1],
    [/\bdesign (a|an|the)\b/i, 2],
    [/规划|方案|架构|设计/, 3],
  ],
  research: [
    [/\b(research|investigate|survey|landscape|benchmark|look up|search the web)\b/i, 3],
    [/\bcompare\b/i, 2],
    [/调研|对比|搜索/, 3],
  ],
  "long-context": [
    [/\b(whole repo|entire (repo|codebase)|large (file|codebase|document)|long document)\b/i, 4],
    [/整个仓库|全仓|长文档/, 4],
  ],
  explore: [
    [/\b(where is|locate|grep|inventory|summari[sz]e)\b/i, 3],
    [/查找|列出|定位|梳理/, 3],
  ],
  "zh-writing": [
    [/\b(write (a )?(chinese|post|article)|translate)\b/i, 2],
    [/写一篇|文案|润色|翻译/, 3],
  ],
};

const MIN_SCORE = 3;
const MIN_MARGIN = 1;

export interface KindGuess {
  /** the winning kind, or null when the evidence was too weak (use the policy default) */
  kind: string | null;
  score: number;
  scores: Record<string, number>;
}

/** Score the prompt against every kind the table has. */
export function classifyKind(prompt: string, table?: RoutingTable | null): KindGuess {
  const scores: Record<string, number> = {};
  for (const [kind, signals] of Object.entries(SIGNALS)) {
    if (table && !table.tasks[kind]) continue;
    let s = 0;
    for (const [re, w] of signals) if (re.test(prompt)) s += w;
    if (s > 0) scores[kind] = s;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, second] = [ranked[0], ranked[1]];
  if (!top || top[1] < MIN_SCORE || top[1] - (second?.[1] ?? 0) < MIN_MARGIN) {
    return { kind: null, score: top?.[1] ?? 0, scores };
  }
  return { kind: top[0], score: top[1], scores };
}

/** The guessed kind, or `fallback` (the policy default kind) when the guess is not confident. */
export function inferKind(prompt: string, table?: RoutingTable | null, fallback = "implement"): string {
  return classifyKind(prompt, table).kind ?? fallback;
}

/** The policy task kind (permission profile, approval) a routing kind belongs to. */
export function policyKindOf(kind: string): "implement" | "review" | "research" | "debug" | "plan" | "qa" | "chat" {
  switch (kind) {
    case "plan":
      return "plan";
    case "debug":
      return "debug";
    case "review":
      return "review";
    case "test":
      return "qa";
    case "research":
    case "explore":
    case "long-context":
      return "research";
    case "zh-writing":
      return "chat";
    default:
      return "implement";
  }
}

/** The routing kind a policy task kind starts from (used by the skill commands). */
export function routingKindOf(policyKind: string): string {
  switch (policyKind) {
    case "qa":
      return "test";
    case "chat":
      return "zh-writing";
    case "ship":
      return "implement";
    default:
      return policyKind;
  }
}

export interface RoutePlan {
  kind: string;
  /** the primary route (first pick that survives the whitelist) */
  route: string;
  /** the remaining allowed picks, in rank order: the quota ladder */
  ladder: string[];
  /** picks the whitelist removed, with the reason */
  dropped: Array<{ route: string; why: string }>;
}

/** Choose the route from `tasks[kind].picks`, filtered by the policy whitelist. Null when nothing survives. */
export function planRoutes(table: RoutingTable, kind: string, whitelist: PolicyModelRoutes): RoutePlan | null {
  const task = table.tasks[kind];
  if (!task) return null;
  const kept: string[] = [];
  const dropped: RoutePlan["dropped"] = [];
  for (const route of task.picks) {
    const verdict = checkRoute(route, whitelist);
    if (verdict.ok) {
      if (!kept.includes(route)) kept.push(route);
    } else dropped.push({ route, why: verdict.code ?? "POLICY_DENIED" });
  }
  if (kept.length === 0) return null;
  return { kind, route: kept[0], ladder: kept.slice(1), dropped };
}

export interface PromptAdapter {
  /** the family name, or null when no family matched (prompt untouched) */
  family: string | null;
  style: string;
  route: string;
  /** false when the prompt was passed through unchanged */
  applied: boolean;
  /** the family's rules from the routing file (recorded, not injected into the prompt) */
  rules?: string[];
  unverified?: boolean;
}

/** Which family a route belongs to: `group/*` first, then the first family whose match word occurs in the route. */
export function familyOf(table: RoutingTable, route: string): string | null {
  const lower = route.toLowerCase();
  const group = table.families.group;
  if (group && group.match.some((m) => lower.startsWith(m.toLowerCase()))) return "group";
  const model = lower.includes("/") ? lower.slice(lower.indexOf("/") + 1) : lower;
  for (const [name, fam] of Object.entries(table.families)) {
    if (name === "group") continue;
    if (fam.match.some((m) => model.includes(m.toLowerCase()))) return name;
  }
  return null;
}

/**
 * A prompt that already carries structure is passed through unchanged: a
 * paired XML tag (`<goal>…</goal>`) or a markdown heading (`## Goal`).
 */
const HAS_XML_TAGS = /<([A-Za-z][\w-]*)(\s[^>]*)?>[\s\S]*<\/\1\s*>/;
const HAS_MD_HEADINGS = /^ {0,3}#{1,6}\s+\S/m;
const WRAP_TAG = "task";

/** Replace a closing `</task>` inside the content so it cannot end the wrapper early. */
function escapeClosing(body: string): string {
  return body.replace(new RegExp(`</(${WRAP_TAG})(\\s*>)`, "gi"), "&lt;/$1$2");
}

/**
 * Re-shape the prompt for the family of `route`. Structure only, never new
 * instructions: the user's text is kept verbatim inside the wrapper, nothing is
 * appended. The style and the family rules come from the routing file; the
 * rules are recorded on the adapter (for the run record), not injected.
 */
export function adaptPrompt(table: RoutingTable | null, route: string, prompt: string): { prompt: string; adapter: PromptAdapter } {
  const none: PromptAdapter = { family: null, style: "none", route, applied: false };
  if (!table) return { prompt, adapter: none };
  const family = familyOf(table, route);
  if (!family) return { prompt, adapter: none };
  const fam = table.families[family];
  const base: PromptAdapter = {
    family,
    style: fam.style,
    route,
    applied: false,
    ...(fam.rules ? { rules: fam.rules } : {}),
    ...(fam.unverified ? { unverified: true } : {}),
  };
  if (HAS_XML_TAGS.test(prompt) || HAS_MD_HEADINGS.test(prompt)) return { prompt, adapter: base };
  const body = prompt.trim();
  const wrapped =
    fam.style === "xml"
      ? `<${WRAP_TAG}>\n${escapeClosing(body)}\n</${WRAP_TAG}>`
      : `## Task\n\n${body}`;
  return { prompt: wrapped, adapter: { ...base, applied: true } };
}
