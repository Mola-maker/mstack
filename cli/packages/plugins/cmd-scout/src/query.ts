/** Deterministic keyword + query extraction (English and Chinese). */

const STOP_EN = new Set(
  ("a an the and or but of for to in on at by with without from into onto as is are was were be been being it its this that these those " +
    "i we you they he she my our your their me us them do does did done have has had can could should would will shall may might must " +
    "need needs want wants like use using used make makes build builds write writes create creates implement implements add adds get gets " +
    "some any all each every more most very just also then than so such not no yes how what which who when where why " +
    "zero dependency dependencies library libraries lib tool tools simple small tiny new best good existing code").split(/\s+/),
);
const STOP_ZH = new Set(
  ("的 了 和 与 或 及 一个 一种 一些 这个 那个 需要 想要 要 实现 做 做个 写 写个 用 使用 我 我们 你 他 她 它 把 被 在 是 有 并 且 也 都 就 能 可以 " +
    "如何 怎么 怎样 什么 请 帮 帮我 零 依赖 零依赖 带 带有 支持 功能 一下 进行 来 去 个 对 中 上 下 里 而 但 如果 然后 以及 并且 工具 库 项目 代码").split(/\s+/),
);

const WORD_RE = /[A-Za-z][A-Za-z0-9_+#.-]*[A-Za-z0-9+#]|[A-Za-z]/g;
const CJK_RE = /[\u3400-\u9fff]+/g;

function segmentCjk(run: string): string[] {
  try {
    const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: object) => { segment(s: string): Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter;
    if (Seg) {
      const out: string[] = [];
      for (const s of new Seg("zh", { granularity: "word" }).segment(run)) if (s.isWordLike !== false) out.push(s.segment);
      if (out.length) return out;
    }
  } catch {
    /* fall through to bigrams */
  }
  if (run.length <= 2) return [run];
  const out: string[] = [];
  for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  return out;
}

/** Ordered, de-duplicated keywords of a need. */
export function extractKeywords(need: string): string[] {
  type Tok = { at: number; text: string };
  const toks: Tok[] = [];
  for (const m of need.matchAll(WORD_RE)) {
    const w = m[0].toLowerCase().replace(/[.-]+$/, "");
    if (w.length >= 2 && !STOP_EN.has(w)) toks.push({ at: m.index ?? 0, text: w });
  }
  for (const m of need.matchAll(CJK_RE)) {
    let off = 0;
    for (const w of segmentCjk(m[0])) {
      if (w.length >= 2 && !STOP_ZH.has(w)) toks.push({ at: (m.index ?? 0) + off, text: w });
      off += w.length;
    }
  }
  toks.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of toks) if (!seen.has(t.text)) (seen.add(t.text), out.push(t.text));
  return out;
}

/** 2–4 search queries from the keywords (1 when the need has a single keyword plus a variant). */
export function deriveQueries(need: string): string[] {
  const kws = extractKeywords(need);
  if (!kws.length) {
    const raw = need.trim().slice(0, 60);
    return raw ? [raw] : [];
  }
  const qs: string[] = [kws.slice(0, 4).join(" ")];
  if (kws.length > 2) qs.push(kws.slice(0, 2).join(" "));
  if (kws.length > 4) qs.push(kws.slice(2, 6).join(" "));
  else if (kws.length > 2) qs.push(kws.slice(1, 4).join(" "));
  if (kws.length > 5) qs.push(kws.slice(-2).join(" "));
  if (kws.length <= 2) qs.push(kws.length === 1 ? `${kws[0]} library` : kws[0] + " " + kws[1] + " cli");
  const uniq = [...new Set(qs.map((q) => q.trim()).filter(Boolean))];
  return uniq.slice(0, 4);
}

/** Keywords across need + queries (the match vocabulary). */
export function matchVocabulary(need: string, queries: string[]): string[] {
  const set = new Set<string>(extractKeywords(need));
  for (const q of queries) for (const k of extractKeywords(q)) set.add(k);
  return [...set];
}

/** Distinct keywords found in a text, matching on word boundaries (substring for keywords >= 4 chars; camelCase is split). */
export function matchedKeywords(text: string, kws: string[]): string[] {
  const lower = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const words = lower.split(/[^a-z0-9+#]+/).filter(Boolean);
  const out: string[] = [];
  for (const k of kws) {
    const cjk = /[\u3400-\u9fff]/.test(k);
    if (cjk) {
      if (lower.includes(k)) out.push(k);
    } else if (words.some((w) => w === k || (k.length >= 4 && w.includes(k)))) out.push(k);
  }
  return out;
}
