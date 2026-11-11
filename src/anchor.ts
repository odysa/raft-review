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

/** Re-place an anchor in new text: keep it if the quote is still at the same
 *  offsets, else search for the quote nearest the old position. Returns null
 *  when the quoted text no longer exists (the thread becomes orphaned). */
export function reanchor(text: string, anchor: Span & { quote: string }): Span | null {
  if (text.slice(anchor.start, anchor.end) === anchor.quote) return { start: anchor.start, end: anchor.end };
  return findQuote(text, anchor.quote, { near: anchor.start });
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
