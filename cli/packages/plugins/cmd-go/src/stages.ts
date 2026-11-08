/**
 * Stage selection for `mola go` (FRAMEWORK §13.1): which of the six stages a
 * sentence needs. Pure functions, unit-tested; no I/O.
 */

import { STAGES, type StageName } from "@mola/plugin-sdk";

/** The model-routing kind each stage runs as (the run engine picks the model from it). */
export const STAGE_KIND: Record<StageName, string> = {
  think: "plan",
  plan: "plan",
  implement: "implement",
  verify: "test",
  review: "review",
  ship: "implement",
};

/** The artifact each stage must write into the run dir. */
export const STAGE_ARTIFACT: Record<StageName, string> = {
  think: "think.md",
  plan: "plan.md",
  implement: "implement.md",
  verify: "verify.md",
  review: "review.md",
  ship: "ship.md",
};

export function isStageName(s: unknown): s is StageName {
  return typeof s === "string" && (STAGES as readonly string[]).includes(s);
}

/** A file path / file name with a known extension, a path with a slash, or a backticked span. */
const FILE_LIKE = /(?:[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|py|rs|go|java|kt|c|cpp|h|css|html|astro|vue|yml|yaml|toml|sh|sql)\b)/i;
const BACKTICKED = /`[^`]+`/;
/** A command the user names: `mola run`, `pnpm test`, `git push` … */
const COMMAND_LIKE = /\b(?:mola|pnpm|npm|yarn|node|npx|git|cargo|pytest|docker|tsc)\s+[\w-]+/i;
/** Something concrete to act on: a feature / defect / artifact noun. */
const NOUN_EN =
  /\b(?:bug|bugs|test|tests|endpoint|endpoints|api|apis|page|pages|command|commands|flag|flags|module|modules|function|functions|class|component|components|button|toggle|cli|hook|hooks|config|error|errors|crash|readme|docs?|plugin|plugins|route|routes|schema|migration|feature|login|auth|build|lint|ci|script|server|query|cache|log|logs)\b/i;
const NOUN_ZH = /修复|页面|接口|测试|命令|功能|报错|文档|配置|函数|模块|按钮|插件|脚本|登录|构建|崩溃|日志|缓存/;

/** Words in the sentence: latin tokens count 1, CJK characters count 1/2 (≈ one word per two characters). */
export function wordCount(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = text
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ")
    .split(/\s+/)
    .filter((t) => /[A-Za-z0-9]/.test(t)).length;
  return latin + cjk / 2;
}

/**
 * Vague = fewer than 6 words AND nothing concrete to act on (no file, command
 * or feature noun). "make it better" is vague; "fix the login bug" is not.
 */
export function isVague(intent: string): boolean {
  const text = intent.trim();
  if (!text) return true;
  if (wordCount(text) >= 6) return false;
  if (FILE_LIKE.test(text) || BACKTICKED.test(text) || COMMAND_LIKE.test(text)) return false;
  if (NOUN_EN.test(text) || NOUN_ZH.test(text)) return false;
  return true;
}

/** Does the sentence ask to push / open a PR / ship? */
export function asksToShip(intent: string): boolean {
  return (
    /\bship\b/i.test(intent) ||
    /\bpush\b/i.test(intent) ||
    /\b(?:open|raise|create|submit|file|make)\b[^.\n]{0,16}\b(?:pr|pull request)\b/i.test(intent) ||
    /提\s*(?:个|一个)?\s*PR|发\s*(?:个)?\s*PR|开\s*(?:个)?\s*PR|提交\s*PR|推送|推到/i.test(intent)
  );
}

/**
 * The stages that will run, in order. `until` caps the run: nothing after it is
 * selected. Without `until`: plan → implement → verify → review, think only
 * when the intent is vague, ship only when the intent asks for it.
 */
export function selectStages(intent: string, until?: StageName): StageName[] {
  const wantShip = until === "ship" || (until === undefined && asksToShip(intent));
  const selected = new Set<StageName>(["plan", "implement", "verify", "review"]);
  if (isVague(intent) || until === "think") selected.add("think");
  if (wantShip) selected.add("ship");
  const cap = until ? STAGES.indexOf(until) : STAGES.length - 1;
  return STAGES.filter((s) => selected.has(s) && STAGES.indexOf(s) <= cap);
}
