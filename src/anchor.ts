// Text anchoring for review threads and suggested edits.
//
// An anchor is a half-open character range [start, end) into the current
// document text, plus the quoted text it covered when it was last placed.
// Ranges are kept valid across edits by mapping them through each edit, and
// re-located by quote search when a whole new version replaces the text.

export interface Span {
  start: number;
  end: number;
}

export interface Edit {
  start: number;
  end: number;
  insertLength: number;
}

/** Map a span through a single replace edit. The span never disappears: if an
 *  edit overlaps it, the span grows to cover the replacement. */
export function mapSpanThroughEdit(span: Span, edit: Edit): Span {
  const delta = edit.insertLength - (edit.end - edit.start);
  if (span.end <= edit.start) return { ...span };
  if (span.start >= edit.end) {
    return { start: span.start + delta, end: span.end + delta };
  }
  const start = span.start < edit.start ? span.start : edit.start;
  const end = span.end > edit.end ? span.end + delta : edit.start + edit.insertLength;
  return { start, end: Math.max(start, end) };
}

/** All start offsets of `quote` in `text`. */
export function quoteOccurrences(text: string, quote: string): number[] {
  if (!quote) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(quote, from);
    if (index < 0) return out;
    out.push(index);
    from = index + 1;
  }
}

/** Locate `quote` in `text`. With `occurrence` (1-based) pick that match;
 *  with `near`, pick the match closest to that offset; otherwise the first. */
export function findQuote(
  text: string,
  quote: string,
  opts: { occurrence?: number; near?: number } = {},
): Span | null {
  const hits = quoteOccurrences(text, quote);
  if (hits.length === 0) return null;
  let start: number;
  if (opts.occurrence !== undefined) {
    const hit = hits[opts.occurrence - 1];
    if (hit === undefined) return null;
    start = hit;
  } else if (opts.near !== undefined) {
    const near = opts.near;
    start = hits.reduce((best, cur) => (Math.abs(cur - near) < Math.abs(best - near) ? cur : best), hits[0]);
  } else {
    start = hits[0];
  }
  return { start, end: start + quote.length };
}

/** Characters of context kept on each side of an anchor, as in the W3C Web
 *  Annotation TextQuoteSelector (exact + prefix + suffix). */
export const CONTEXT_CHARS = 32;

export interface QuoteAnchor extends Span {
  quote: string;
  prefix?: string;
  suffix?: string;
}

export function contextFor(text: string, span: Span): { prefix: string; suffix: string } {
  return {
    prefix: text.slice(Math.max(0, span.start - CONTEXT_CHARS), span.start),
    suffix: text.slice(span.end, span.end + CONTEXT_CHARS),
  };
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Re-place an anchor in new text, combining a position selector with a
 *  quote selector (the W3C annotation model's recommendation): keep it if the
 *  quote is still at the same offsets; otherwise pick the occurrence whose
 *  surrounding text best matches the stored prefix/suffix, breaking ties by
 *  distance from the old position. Returns null when the quoted text no longer
 *  exists (the thread becomes orphaned). */
export function reanchor(text: string, anchor: QuoteAnchor): Span | null {
  return reanchorDetailed(text, anchor)?.span ?? null;
}

export type AnchorMatch = "exact" | "fuzzy" | "context";

/** Like `reanchor`, but also says how the anchor was found:
 *  exact quote → approximate quote (edit distance ≤ 25% of its length, as
 *  Hypothesis does) → the span between the unchanged prefix and suffix. */
export function reanchorDetailed(text: string, anchor: QuoteAnchor): { span: Span; match: AnchorMatch } | null {
  const exact = reanchorExact(text, anchor);
  if (exact) return { span: exact, match: "exact" };
  const fuzzy = fuzzyFind(text, anchor);
  if (fuzzy) return { span: fuzzy, match: "fuzzy" };
  const bracketed = betweenContext(text, anchor);
  if (bracketed) return { span: bracketed, match: "context" };
  return null;
}

function reanchorExact(text: string, anchor: QuoteAnchor): Span | null {
  if (text.slice(anchor.start, anchor.end) === anchor.quote) return { start: anchor.start, end: anchor.end };
  const hits = quoteOccurrences(text, anchor.quote);
  if (hits.length === 0) return null;
  let best = hits[0];
  let bestScore = -1;
  let bestDistance = Infinity;
  for (const start of hits) {
    const end = start + anchor.quote.length;
    const score = (anchor.prefix ? commonSuffixLength(text.slice(Math.max(0, start - anchor.prefix.length), start), anchor.prefix) : 0)
      + (anchor.suffix ? commonPrefixLength(text.slice(end, end + anchor.suffix.length), anchor.suffix) : 0);
    const distance = Math.abs(start - anchor.start);
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = start;
      bestScore = score;
      bestDistance = distance;
    }
  }
  return { start: best, end: best + anchor.quote.length };
}

export function applyEdit(text: string, span: Span, replacement: string): string {
  return text.slice(0, span.start) + replacement + text.slice(span.end);
}

export function isValidSpan(text: string, span: Span): boolean {
  return Number.isInteger(span.start) && Number.isInteger(span.end)
    && span.start >= 0 && span.end >= span.start && span.end <= text.length;
}

/** A few lines of context around a span, for agents reading a thread. */
export function contextAround(text: string, span: Span, chars = 400): { before: string; after: string } {
  return {
    before: text.slice(Math.max(0, span.start - chars), span.start),
    after: text.slice(span.end, span.end + chars),
  };
}

/** 1-based line number of an offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** PDFs store extracted text with pages separated by a form feed. */
export const PAGE_SEPARATOR = "\f";

export function pageOf(text: string, offset: number): number {
  let page = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === PAGE_SEPARATOR) page++;
  return page;
}

// ---------- approximate matching ----------

interface ApproxHit extends Span {
  errors: number;
}

/** Semi-global edit-distance search (Sellers' algorithm): every place in
 *  text[from, to) where `pattern` matches with at most `maxErrors` edits.
 *  O(pattern × window) time, O(pattern) memory. Starts are tracked through
 *  the DP so each hit is a full span. */
export function approxSearch(text: string, pattern: string, maxErrors: number, from = 0, to = text.length): ApproxHit[] {
  const m = pattern.length;
  if (m === 0) return [];
  let prevCost = new Int32Array(m + 1);
  let prevStart = new Int32Array(m + 1);
  let curCost = new Int32Array(m + 1);
  let curStart = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) { prevCost[j] = j; prevStart[j] = from; }
  const hits: ApproxHit[] = [];
  for (let i = from; i < to; i++) {
    const ch = text.charCodeAt(i);
    curCost[0] = 0;
    curStart[0] = i + 1;
    for (let j = 1; j <= m; j++) {
      let cost = prevCost[j - 1] + (pattern.charCodeAt(j - 1) === ch ? 0 : 1);
      let start = prevStart[j - 1];
      if (curCost[j - 1] + 1 < cost) { cost = curCost[j - 1] + 1; start = curStart[j - 1]; }
      if (prevCost[j] + 1 < cost) { cost = prevCost[j] + 1; start = prevStart[j]; }
      curCost[j] = cost;
      curStart[j] = start;
    }
    if (curCost[m] <= maxErrors) hits.push({ start: curStart[m], end: i + 1, errors: curCost[m] });
    [prevCost, curCost] = [curCost, prevCost];
    [prevStart, curStart] = [curStart, prevStart];
  }
  return hits;
}

const FUZZY_MAX_PATTERN = 256;
const FUZZY_WINDOW = 20_000;

function contextScore(text: string, span: Span, anchor: QuoteAnchor): number {
  return (anchor.prefix ? commonSuffixLength(text.slice(Math.max(0, span.start - anchor.prefix.length), span.start), anchor.prefix) : 0)
    + (anchor.suffix ? commonPrefixLength(text.slice(span.end, span.end + anchor.suffix.length), anchor.suffix) : 0);
}

function bestHit(text: string, hits: ApproxHit[], anchor: QuoteAnchor): ApproxHit | null {
  let best: ApproxHit | null = null;
  let bestKey: [number, number, number] = [Infinity, -Infinity, Infinity];
  for (const hit of hits) {
    const key: [number, number, number] = [hit.errors, contextScore(text, hit, anchor), Math.abs(hit.start - anchor.start)];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      best = hit;
      bestKey = key;
    }
  }
  return best;
}

/** Find a lightly edited quote. Short quotes are matched whole; long ones by
 *  their head and tail, which must pair up at a plausible length. Searches a
 *  window around the old position to keep the cost bounded. */
function fuzzyFind(text: string, anchor: QuoteAnchor): Span | null {
  const quote = anchor.quote;
  if (quote.trim().length < 4) return null; // too short to tell an edit from a coincidence
  const from = Math.max(0, anchor.start - FUZZY_WINDOW);
  const to = Math.min(text.length, anchor.end + FUZZY_WINDOW);
  if (quote.length <= FUZZY_MAX_PATTERN) {
    const hit = bestHit(text, approxSearch(text, quote, Math.floor(quote.length / 4), from, to), anchor);
    return hit ? trimSpan(text, hit) : null;
  }
  const head = quote.slice(0, FUZZY_MAX_PATTERN / 2);
  const tail = quote.slice(-FUZZY_MAX_PATTERN / 2);
  const heads = approxSearch(text, head, Math.floor(head.length / 4), from, to);
  const tails = approxSearch(text, tail, Math.floor(tail.length / 4), from, to);
  let best: ApproxHit | null = null;
  for (const h of heads) {
    for (const t of tails) {
      const length = t.end - h.start;
      if (t.start < h.end || length < quote.length * 0.6 || length > quote.length * 1.4) continue;
      // Cost = edits in head + tail + how far the span's length strays from
      // the original, so repeated text cannot pair a head with the wrong tail.
      // Small length drift is ordinary editing; only large drift is penalized.
      const candidate = { start: h.start, end: t.end, errors: h.errors + t.errors + Math.floor(Math.abs(length - quote.length) / 8) };
      if (!best || candidate.errors < best.errors
        || (candidate.errors === best.errors && candidate.end - candidate.start > best.end - best.start)) best = candidate;
    }
  }
  return best ? trimSpan(text, best) : null;
}

/** The quote was rewritten beyond recognition but the text around it was
 *  not: anchor to whatever now sits between the old prefix and suffix. */
function betweenContext(text: string, anchor: QuoteAnchor): Span | null {
  const prefix = anchor.prefix?.slice(-16) ?? "";
  const suffix = anchor.suffix?.slice(0, 16) ?? "";
  // A quote at the very start or end of the document has (almost) no context
  // on that side; the document boundary itself is the anchor there.
  const atStart = prefix.trim() === "";
  const atEnd = suffix.trim() === "";
  if (atStart && atEnd) return null;
  if ((!atStart && prefix.length < 8) || (!atEnd && suffix.length < 8)) return null;
  const maxLength = anchor.quote.length * 3 + 50;
  let best: Span | null = null;
  const consider = (span: Span) => {
    if (span.end <= span.start || span.end - span.start > maxLength) return;
    if (!best || Math.abs(span.start - anchor.start) < Math.abs(best.start - anchor.start)) best = span;
  };
  if (atStart) {
    const s = text.indexOf(suffix);
    if (s >= 0) consider({ start: 0, end: s });
  } else {
    for (const p of quoteOccurrences(text, prefix)) {
      const start = p + prefix.length;
      if (atEnd) {
        consider({ start, end: text.length });
        continue;
      }
      const s = text.indexOf(suffix, start);
      if (s >= 0) consider({ start, end: s });
    }
  }
  return best ? trimSpan(text, best) : null;
}

function trimSpan(text: string, span: Span): Span | null {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? { start, end } : null;
}
