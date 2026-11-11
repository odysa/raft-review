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
  "nonumber", "notag", "tag", "hline", "toprule", "midrule", "bottomrule", "cmidrule", "cline", "arraystretch",
]);

/** Math commands → the glyph a PDF shows for them. Anything else in math
 *  drops its name and keeps its argument (\mathbb{R} → R, \frac{a}{b} → ab). */
const MATH_SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ",
  varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", oint: "∮", infty: "∞", times: "×", cdot: "·", pm: "±", mp: "∓",
  div: "÷", leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", simeq: "≃", cong: "≅",
  equiv: "≡", propto: "∝", ll: "≪", gg: "≫", in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃",
  supseteq: "⊇", cup: "∪", cap: "∩", setminus: "\\", emptyset: "∅", varnothing: "∅", mid: "|", vert: "|", lvert: "|",
  rvert: "|", Vert: "‖", lVert: "‖", rVert: "‖", to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⇒", iff: "⇔", mapsto: "↦", partial: "∂", nabla: "∇",
  forall: "∀", exists: "∃", neg: "¬", land: "∧", wedge: "∧", lor: "∨", vee: "∨", cdots: "⋯", ldots: "...", dots: "...",
  vdots: "⋮", ddots: "⋱", langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋", ell: "ℓ",
  hbar: "ℏ", top: "⊤", bot: "⊥", perp: "⊥", prime: "′", circ: "∘", odot: "⊙", otimes: "⊗", oplus: "⊕", star: "⋆",
  ast: "∗", dagger: "†", angle: "∠", triangle: "△", square: "□", sqrt: "√",
  log: "log", ln: "ln", exp: "exp", max: "max", min: "min", argmax: "argmax", argmin: "argmin", sup: "sup", inf: "inf",
  lim: "lim", limsup: "limsup", liminf: "liminf", det: "det", dim: "dim", ker: "ker", sin: "sin", cos: "cos", tan: "tan",
  sinh: "sinh", cosh: "cosh", tanh: "tanh", arg: "arg", deg: "deg", gcd: "gcd", Pr: "Pr", mod: "mod", bmod: "mod",
};

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

/** Project LaTeX to the text a reader would see, with an offset map. Math
 *  is projected to the glyphs a PDF shows (`x_t` → "xt", `\sum` → "∑"). */
export function projectLatex(src: string): { text: string; toRaw: number[] } {
  const out: string[] = [];
  const toRaw: number[] = [];
  const emit = (s: string, at: number) => {
    for (const ch of s) { out.push(ch); toRaw.push(at); }
  };
  let i = 0;
  let inDollar = false;
  let mathDepth = 0;
  const inMath = () => inDollar || mathDepth > 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "%") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "$") {
      inDollar = !inDollar;
      emit(" ", i);
      i += src[i + 1] === "$" ? 2 : 1;
      continue;
    }
    if (c === "{" || c === "}") { i++; continue; }
    if (c === "~") { emit(" ", i); i++; continue; }
    // Table cell separators.
    if (c === "&") { emit(" ", i); i++; continue; }
    if (inMath() && (c === "_" || c === "^")) { i++; continue; }
    if (!inMath() && c === "`" && src[i + 1] === "`") { emit("\"", i); i += 2; continue; }
    if (!inMath() && c === "'" && src[i + 1] === "'") { emit("\"", i); i += 2; continue; }
    if (!inMath() && c === "-" && src[i + 1] === "-") {
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
      else if (next === "(" || next === "[") { mathDepth++; emit(" ", start); }
      else if (next === ")" || next === "]") { mathDepth = Math.max(0, mathDepth - 1); emit(" ", start); }
      else if (next === "|" && inMath()) emit("‖", start);
      else if (" ,;:!/>".includes(next)) emit(" ", start);
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
      if (MATH_ENVS.has(env)) {
        if (name === "begin") mathDepth++;
        else mathDepth = Math.max(0, mathDepth - 1);
        emit(" ", start);
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
    if (inMath() && name in MATH_SYMBOLS) {
      emit(MATH_SYMBOLS[name], start);
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
  /** How well the surrounding text matched the requested context (0..1). */
  context: number;
}

export interface MatchContext {
  /** Normalized text just before / after the quote on the other side. */
  before: string;
  after: string;
}

const MAX_PATTERN = 256;
const CONTEXT_CHARS = 80;

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Share of `want`'s trigrams found in `have`: tolerant of the small
 *  differences between PDF text and projected LaTeX (citations, numbering). */
function similarity(have: string, want: string): number {
  const w = trigrams(want);
  if (w.size === 0) return 0;
  const h = trigrams(have);
  let hit = 0;
  for (const t of w) if (h.has(t)) hit++;
  return hit / w.size;
}

interface Hit { s: number; e: number; errors: number }

function searchNorm(norm: string, needle: string): Hit[] {
  const exact: Hit[] = [];
  for (let from = 0; ;) {
    const s = norm.indexOf(needle, from);
    if (s < 0) break;
    exact.push({ s, e: s + needle.length, errors: 0 });
    from = s + 1;
  }
  if (exact.length) return exact;
  if (needle.length <= MAX_PATTERN) {
    return approxSearch(norm, needle, Math.floor(needle.length / 4)).map((h) => ({ s: h.start, e: h.end, errors: h.errors }));
  }
  const head = needle.slice(0, MAX_PATTERN / 2);
  const tail = needle.slice(-MAX_PATTERN / 2);
  const heads = approxSearch(norm, head, Math.floor(head.length / 4));
  const tails = approxSearch(norm, tail, Math.floor(tail.length / 4));
  const out: Hit[] = [];
  for (const h of heads) {
    for (const t of tails) {
      const length = t.end - h.start;
      if (t.start < h.end || length < needle.length * 0.6 || length > needle.length * 1.4) continue;
      out.push({ s: h.start, e: t.end, errors: h.errors + t.errors + Math.floor(Math.abs(length - needle.length) / 8) });
    }
  }
  return out;
}

/** The same index without spaces: PDF math spacing is arbitrary. */
function compact(index: TextIndex): TextIndex {
  const cached = (index as TextIndex & { _compact?: TextIndex })._compact;
  if (cached) return cached;
  const norm: string[] = [];
  const toRaw: number[] = [];
  for (let i = 0; i < index.norm.length; i++) {
    if (index.norm[i] === " ") continue;
    norm.push(index.norm[i]);
    toRaw.push(index.toRaw[i]);
  }
  const out = { norm: norm.join(""), toRaw };
  (index as TextIndex & { _compact?: TextIndex })._compact = out;
  return out;
}

/** Find normalized `needle` in `index`; returns a raw span in the indexed text.
 *  Candidates are ranked by edit errors, then by how well the text around
 *  them matches `context` (so a repeated phrase resolves to the right
 *  occurrence), then by distance from `nearRaw` (e.g. a SyncTeX line). */
export function locate(index: TextIndex, needle: string, nearRaw?: number, context?: MatchContext): IndexMatch | null {
  if (needle.length < 3 || index.norm.length === 0) return null;
  const pick = (idx: TextIndex, hits: Hit[], ctxBefore: string, ctxAfter: string): IndexMatch | null => {
    if (!hits.length) return null;
    const nearNorm = nearRaw === undefined ? undefined : nearestNorm(idx, nearRaw);
    let best: (Hit & { ctx: number; dist: number }) | null = null;
    for (const h of hits) {
      const ctx = context
        ? (similarity(idx.norm.slice(Math.max(0, h.s - CONTEXT_CHARS), h.s), ctxBefore) + similarity(idx.norm.slice(h.e, h.e + CONTEXT_CHARS), ctxAfter)) / 2
        : 0;
      const dist = nearNorm === undefined ? 0 : Math.abs(h.s - nearNorm);
      // Context outranks a single edit: one typo shouldn't beat the right place.
      const better = !best
        || h.errors - ctx * 2 < best.errors - best.ctx * 2 - 1e-9
        || (Math.abs((h.errors - ctx * 2) - (best.errors - best.ctx * 2)) < 1e-9
          && (dist < best.dist || (dist === best.dist && h.e - h.s > best.e - best.s)));
      if (better) best = { ...h, ctx, dist };
    }
    return best ? { start: idx.toRaw[best.s], end: idx.toRaw[best.e - 1] + 1, errors: best.errors, context: best.ctx } : null;
  };
  const hits = searchNorm(index.norm, needle);
  const c = compact(index);
  const strip = (s: string) => s.replace(/ /g, "");
  // Only approximate matches? An exact match ignoring spaces is better:
  // typeset math and table cells differ from LaTeX mostly in spacing.
  if (!hits.some((h) => h.errors === 0)) {
    const compactNeedle = strip(needle);
    const exact = compactNeedle.length >= 3 ? searchNorm(c.norm, compactNeedle).filter((h) => h.errors === 0) : [];
    if (exact.length) return pick(c, exact, strip(context?.before ?? ""), strip(context?.after ?? ""));
  }
  const found = pick(index, hits, context?.before ?? "", context?.after ?? "");
  if (found) return found;
  return pick(c, searchNorm(c.norm, strip(needle)), strip(context?.before ?? ""), strip(context?.after ?? ""));
}

/** Normalized text around a raw span, for use as a MatchContext. */
export function contextOf(index: TextIndex, span: Span): MatchContext {
  const s = nearestNorm(index, span.start);
  let e = s;
  while (e < index.toRaw.length && index.toRaw[e] < span.end) e++;
  return {
    before: index.norm.slice(Math.max(0, s - CONTEXT_CHARS), s),
    after: index.norm.slice(e, e + CONTEXT_CHARS),
  };
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

/** The display-math block ($$…$$, \[…\], or a math environment) that
 *  contains or neighbours (±2 lines) a source line; else that line's text. */
export function mathSpanAround(src: string, line: number): Span | null {
  const blocks: Span[] = [];
  const envRe = /\\begin\{([a-zA-Z]+\*?)\}/g;
  for (const m of src.matchAll(envRe)) {
    if (!MATH_ENVS.has(m[1])) continue;
    const endTag = `\\end{${m[1]}}`;
    const close = src.indexOf(endTag, m.index! + m[0].length);
    if (close >= 0) blocks.push({ start: m.index!, end: close + endTag.length });
  }
  for (const [open, close] of [["$$", "$$"], ["\\[", "\\]"]] as const) {
    for (let from = 0; ;) {
      const a = src.indexOf(open, from);
      if (a < 0) break;
      const b = src.indexOf(close, a + open.length);
      if (b < 0) break;
      blocks.push({ start: a, end: b + close.length });
      from = b + close.length;
    }
  }
  const lineStart = offsetOfLine(src, line);
  const lineOfOffset = (o: number) => src.slice(0, o).split("\n").length;
  let best: Span | null = null;
  let bestDist = Infinity;
  for (const b of blocks) {
    const first = lineOfOffset(b.start);
    const last = lineOfOffset(b.end);
    const dist = line < first ? first - line : line > last ? line - last : 0;
    if (dist <= 2 && dist < bestDist) { best = b; bestDist = dist; }
  }
  if (best) return best;
  const nl = src.indexOf("\n", lineStart);
  const lineEnd = nl < 0 ? src.length : nl;
  let s = lineStart;
  let e = lineEnd;
  while (s < e && /\s/.test(src[s])) s++;
  while (e > s && /\s/.test(src[e - 1])) e--;
  return e > s ? { start: s, end: e } : null;
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

/** Make a raw LaTeX span whole: never split a word or a command name,
 *  balance braces and $…$, and include the command whose argument the span
 *  starts in (so `L} = …` becomes `\mathcal{L} = …`). */
export function tidySourceSpan(src: string, span: Span): Span {
  let { start, end } = span;
  const word = /[\p{L}\p{N}]/u;
  while (start > 0 && word.test(src[start - 1]) && word.test(src[start])) start--;
  while (end < src.length && word.test(src[end]) && word.test(src[end - 1])) end++;
  // A command name cut short at either end.
  const lastSlash = src.lastIndexOf("\\", end - 1);
  if (lastSlash >= start && /^\\[A-Za-z]*$/.test(src.slice(lastSlash, end))) {
    while (end < src.length && /[A-Za-z]/.test(src[end])) end++;
  }
  for (let guard = 0; guard < 8; guard++) {
    const before = { start, end };
    // Unmatched braces: extend outward to their partners.
    let depth = 0;
    let minDepth = 0;
    for (let i = start; i < end; i++) {
      if (src[i] === "\\") { i++; continue; }
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; minDepth = Math.min(minDepth, depth); }
    }
    for (let need = -minDepth; need > 0 && start > 0;) {
      start--;
      if (src[start - 1] === "\\") continue;
      if (src[start] === "}") need++;
      else if (src[start] === "{") need--;
    }
    for (let need = depth - minDepth; need > 0 && end < src.length; end++) {
      if (src[end] === "\\") { end++; continue; }
      if (src[end] === "{") need++;
      else if (src[end] === "}") need--;
    }
    // A span opening at `{` belongs to the command before it (with options).
    const cmd = /\\[A-Za-z]+\*?(?:\[[^\]]*\])?$/.exec(src.slice(Math.max(0, start - 80), start));
    if (src[start] === "{" && cmd) start -= cmd[0].length;
    // Odd number of unescaped $: close the math.
    const dollars = [...src.slice(start, end).matchAll(/(?<!\\)\$/g)].length;
    if (dollars % 2 === 1) {
      const next = src.slice(end, end + 200).search(/(?<!\\)\$/);
      if (next >= 0) end += next + 1;
      else {
        const prev = src.slice(Math.max(0, start - 200), start).lastIndexOf("$");
        if (prev >= 0) start = Math.max(0, start - 200) + prev;
      }
    }
    if (before.start === start && before.end === end) break;
  }
  return { start, end };
}
