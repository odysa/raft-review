// Map text between a compiled PDF and its LaTeX source.
//
// Both sides are reduced to a comparable plain-text form, each character of
// which remembers where it came from:
//   LaTeX → "projection": commands, math, comments, citations and labels are
//            dropped, \emph{x}-style wrappers keep their content.
//   both  → "normalization": Unicode NFKD without accents, ligatures split,
//            quotes and dashes unified, end-of-line hyphenation removed,
//            whitespace collapsed, lower-cased.
// A quote from one side is then found on the other side exactly, or within an
// edit distance of 25% of its length, and the match is mapped back to raw
// offsets.

import { approxSearch, type Span } from "./anchor.ts";

export interface TextIndex {
  /** Normalized text. */
  norm: string;
  /** For each char of `norm`, its offset in the raw text. */
  toRaw: number[];
}

// ---------- LaTeX projection ----------

/** Commands whose arguments never reach the PDF as running text. */
const DROP_WITH_ARGS = new Set([
  "cite", "citep", "citet", "citealp", "citeauthor", "citeyear", "nocite", "parencite", "textcite", "autocite",
  "ref", "eqref", "autoref", "cref", "Cref", "pageref", "nameref", "label",
  "usepackage", "RequirePackage", "documentclass", "input", "include", "includegraphics", "includeonly",
  "bibliography", "bibliographystyle", "addbibresource", "printbibliography",
  "newcommand", "renewcommand", "providecommand", "newenvironment", "renewenvironment", "DeclareMathOperator",
  "def", "let", "newtheorem", "setlength", "setcounter", "addtocounter", "vspace", "hspace", "vskip", "hskip",
  "pagestyle", "thispagestyle", "pagenumbering", "maketitle", "tableofcontents", "listoffigures", "listoftables",
  "centering", "raggedright", "raggedleft", "noindent", "newpage", "clearpage", "cleardoublepage", "linebreak",
  "pagebreak", "nolinebreak", "smallskip", "medskip", "bigskip", "appendix", "frontmatter", "mainmatter",
  "backmatter", "small", "footnotesize", "scriptsize", "tiny", "large", "Large", "LARGE", "huge", "Huge",
  "normalsize", "bfseries", "itshape", "ttfamily", "rmfamily", "sffamily", "mdseries", "upshape", "scshape",
  "color", "definecolor", "graphicspath", "hypersetup", "geometry", "affil", "thanks", "footnotemark",
  "url", // usually typeset in a mono font that breaks across lines; rarely quoted in review
]);

const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*",
  "displaymath", "math", "split", "flalign", "flalign*", "alignat", "alignat*",
]);

/** Environments whose next {…} argument is a spec, not text. */
const ENV_SPEC_ARG = new Set(["tabular", "tabular*", "tabularx", "array", "longtable", "minipage", "wrapfigure", "subfigure"]);

const WORD_MACROS: Record<string, string> = {
  LaTeX: "LaTeX", TeX: "TeX", ldots: "...", dots: "...", textellipsis: "...", textendash: "-", textemdash: "-",
  textquoteleft: "'", textquoteright: "'", textquotedblleft: "\"", textquotedblright: "\"", ie: "i.e.", eg: "e.g.",
  etal: "et al.", S: "§", P: "¶", copyright: "©", textregistered: "®", texttrademark: "™", dag: "†", ddag: "‡",
};

function skipGroup(src: string, i: number, open: string, close: string): number {
  // `i` is at `open`; return the index after the matching `close`.
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return src.length;
}

function skipSpaces(src: string, i: number): number {
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  return i;
}

/** Project LaTeX to the text a reader would see, with an offset map. */
export function projectLatex(src: string): { text: string; toRaw: number[] } {
  const out: string[] = [];
  const toRaw: number[] = [];
  const emit = (s: string, at: number) => {
    for (const ch of s) { out.push(ch); toRaw.push(at); }
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "%") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "$") {
      const display = src[i + 1] === "$";
      const close = display ? "$$" : "$";
      let j = i + close.length;
      while (j < src.length && !(src.startsWith(close, j) && src[j - 1] !== "\\")) j++;
      emit(" ", i);
      i = j + close.length;
      continue;
    }
    if (c === "{" || c === "}") { i++; continue; }
    if (c === "~") { emit(" ", i); i++; continue; }
    if (c === "`" && src[i + 1] === "`") { emit("\"", i); i += 2; continue; }
    if (c === "'" && src[i + 1] === "'") { emit("\"", i); i += 2; continue; }
    if (c === "-" && src[i + 1] === "-") {
      emit("-", i);
      i += src[i + 2] === "-" ? 3 : 2;
      continue;
    }
    if (c !== "\\") { emit(c, i); i++; continue; }

    // A command.
    const start = i;
    const next = src[i + 1];
    if (next === undefined) { i++; continue; }
    if (!/[A-Za-z@]/.test(next)) {
      i += 2;
      if ("%&_#${}".includes(next)) emit(next, start + 1);
      else if (next === "\\") { emit(" ", start); i = skipSpaces(src, i); if (src[i] === "[") i = skipGroup(src, i, "[", "]"); }
      else if (next === "(") { const j = src.indexOf("\\)", i); emit(" ", start); i = j < 0 ? src.length : j + 2; }
      else if (next === "[") { const j = src.indexOf("\\]", i); emit(" ", start); i = j < 0 ? src.length : j + 2; }
      else if (" ,;:!/".includes(next)) emit(" ", start);
      // Accents (\' \" \^ \` \~ \= \.): drop, the base letter follows.
      continue;
    }
    let j = i + 1;
    while (j < src.length && /[A-Za-z@]/.test(src[j])) j++;
    const name = src.slice(i + 1, j);
    if (src[j] === "*") j++;
    i = j;

    if (name === "begin" || name === "end") {
      i = skipSpaces(src, i);
      if (src[i] !== "{") continue;
      const close = skipGroup(src, i, "{", "}");
      const env = src.slice(i + 1, close - 1).trim();
      i = close;
      if (name === "begin" && MATH_ENVS.has(env)) {
        const endTag = `\\end{${env}}`;
        const k = src.indexOf(endTag, i);
        emit(" ", start);
        i = k < 0 ? src.length : k + endTag.length;
        continue;
      }
      if (name === "begin") {
        i = skipSpaces(src, i);
        while (src[i] === "[") i = skipSpaces(src, skipGroup(src, i, "[", "]"));
        if (ENV_SPEC_ARG.has(env)) {
          if (src[i] === "{") i = skipGroup(src, i, "{", "}");
          if (env === "tabular*" && src[i] === "{") i = skipGroup(src, i, "{", "}");
        }
      }
      emit(" ", start);
      continue;
    }
    if (name in WORD_MACROS) {
      emit(WORD_MACROS[name], start);
      if (src[i] === "{" && src[i + 1] === "}") i += 2;
      continue;
    }
    if (DROP_WITH_ARGS.has(name)) {
      for (;;) {
        const k = skipSpaces(src, i);
        if (src[k] === "[") i = skipGroup(src, k, "[", "]");
        else if (src[k] === "{") i = skipGroup(src, k, "{", "}");
        else break;
      }
      continue;
    }
    if (name === "href") {
      // \href{url}{text}: keep only the text.
      const k = skipSpaces(src, i);
      if (src[k] === "{") i = skipGroup(src, k, "{", "}");
      continue;
    }
    // Footnotes and margin notes are typeset elsewhere on the page: start a
    // separate segment so they never fuse with the word before them.
    if (name === "footnote" || name === "footnotetext" || name === "marginpar" || name === "caption") emit(" ", start);
    // Default: drop the command name and optional args; its {…} content is
    // ordinary text and is projected by the main loop.
    let k = skipSpaces(src, i);
    let skippedOptional = false;
    while (src[k] === "[") { k = skipSpaces(src, skipGroup(src, k, "[", "]")); skippedOptional = true; }
    if (skippedOptional || src[k] === "{") i = k;
    // A space after a control word is swallowed by TeX.
    else if (src[i] === " ") i++;
  }
  return { text: out.join(""), toRaw };
}

// ---------- normalization ----------

const QUOTES: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "`": "'", "´": "'",
  "“": "\"", "”": "\"", "„": "\"" };
const DASHES = new Set(["‐", "‑", "‒", "–", "—", "―", "−"]);

/** Normalize text for matching, keeping a map to the input offsets. */
export function normalizeWithMap(raw: string, rawMap?: number[]): TextIndex {
  const norm: string[] = [];
  const toRaw: number[] = [];
  let pendingSpace = -1;
  const push = (ch: string, at: number) => {
    if (pendingSpace >= 0 && norm.length > 0) { norm.push(" "); toRaw.push(pendingSpace); }
    pendingSpace = -1;
    norm.push(ch);
    toRaw.push(at);
  };
  for (let i = 0; i < raw.length; i++) {
    const at = rawMap ? rawMap[i] : i;
    let ch = raw[i];
    // End-of-line hyphenation in PDF text: "Hyperpa-\nrameters".
    if ((ch === "-" || DASHES.has(ch)) && raw[i + 1] === "\n" && /\p{Ll}/u.test(raw[i + 2] ?? "")) {
      i++;
      continue;
    }
    if (/\s/.test(ch) || ch === "\f") {
      if (pendingSpace < 0) pendingSpace = at;
      continue;
    }
    if (QUOTES[ch]) ch = QUOTES[ch];
    else if (DASHES.has(ch)) ch = "-";
    for (const part of ch.normalize("NFKD")) {
      if (/\p{M}/u.test(part)) continue; // combining accents
      for (const lower of part.toLowerCase()) push(lower, at);
    }
  }
  return { norm: norm.join(""), toRaw };
}

export function indexLatex(src: string): TextIndex {
  const projected = projectLatex(src);
  return normalizeWithMap(projected.text, projected.toRaw);
}

export function indexPlain(text: string): TextIndex {
  return normalizeWithMap(text);
}

// ---------- matching ----------

export interface IndexMatch extends Span {
  errors: number;
}

const MAX_PATTERN = 256;

/** Find normalized `needle` in `index`; returns a raw span in the indexed text.
 *  `nearRaw` breaks ties toward a raw offset (e.g. a SyncTeX line). */
export function locate(index: TextIndex, needle: string, nearRaw?: number): IndexMatch | null {
  if (needle.length < 3 || index.norm.length === 0) return null;
  const toRawSpan = (s: number, e: number, errors: number): IndexMatch => ({
    start: index.toRaw[s],
    end: index.toRaw[e - 1] + 1,
    errors,
  });
  const nearNorm = nearRaw === undefined ? undefined : nearestNorm(index, nearRaw);
  const dist = (s: number) => (nearNorm === undefined ? 0 : Math.abs(s - nearNorm));

  // Exact first.
  let best: { s: number; e: number; errors: number } | null = null;
  for (let from = 0; ;) {
    const s = index.norm.indexOf(needle, from);
    if (s < 0) break;
    if (!best || dist(s) < dist(best.s)) best = { s, e: s + needle.length, errors: 0 };
    from = s + 1;
  }
  if (best) return toRawSpan(best.s, best.e, 0);

  if (needle.length <= MAX_PATTERN) {
    const k = Math.floor(needle.length / 4);
    for (const hit of approxSearch(index.norm, needle, k)) {
      if (!best || hit.errors < best.errors || (hit.errors === best.errors && dist(hit.start) < dist(best.s))) {
        best = { s: hit.start, e: hit.end, errors: hit.errors };
      }
    }
    return best ? toRawSpan(best.s, best.e, best.errors) : null;
  }
  const head = needle.slice(0, MAX_PATTERN / 2);
  const tail = needle.slice(-MAX_PATTERN / 2);
  const heads = approxSearch(index.norm, head, Math.floor(head.length / 4));
  const tails = approxSearch(index.norm, tail, Math.floor(tail.length / 4));
  for (const h of heads) {
    for (const t of tails) {
      const length = t.end - h.start;
      if (t.start < h.end || length < needle.length * 0.6 || length > needle.length * 1.4) continue;
      const errors = h.errors + t.errors + Math.floor(Math.abs(length - needle.length) / 8);
      if (!best || errors < best.errors || (errors === best.errors && dist(h.start) < dist(best.s))) {
        best = { s: h.start, e: t.end, errors };
      }
    }
  }
  return best ? toRawSpan(best.s, best.e, best.errors) : null;
}

function nearestNorm(index: TextIndex, raw: number): number {
  // toRaw is non-decreasing; binary search.
  let lo = 0;
  let hi = index.toRaw.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.toRaw[mid] < raw) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Normalized form of a raw span of an index's source (e.g. a LaTeX source
 *  selection, as a reader would see it). */
export function normalizedSlice(index: TextIndex, span: Span): string {
  let s = nearestNorm(index, span.start);
  let e = s;
  while (e < index.toRaw.length && index.toRaw[e] < span.end) e++;
  while (s < e && index.norm[s] === " ") s++;
  while (e > s && index.norm[e - 1] === " ") e--;
  return index.norm.slice(s, e);
}

export function offsetOfLine(text: string, line: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf("\n", offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
  }
  return offset;
}

/** Expand a raw source span to whole words, so a match that lost a letter
 *  to the edit budget never splits a word. */
export function tidySourceSpan(src: string, span: Span): Span {
  let { start, end } = span;
  while (start > 0 && /[\p{L}\p{N}]/u.test(src[start - 1]) && /[\p{L}\p{N}]/u.test(src[start])) start--;
  while (end < src.length && /[\p{L}\p{N}]/u.test(src[end]) && /[\p{L}\p{N}]/u.test(src[end - 1])) end++;
  return { start, end };
}
