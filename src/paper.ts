// Research papers: a LaTeX project + its compiled PDF, reviewed on the PDF and
// edited in the source.
//
//   comment on PDF text ──SyncTeX hint + text match──▶ exact LaTeX span
//   agent suggests an edit to that span ──human accepts──▶ new source version
//   ──compile (server Tectonic, or the agent uploads a PDF)──▶ new PDF, comments
//   re-placed from their source spans ──get_patch──▶ unified diff for the repo

import { createHash, randomUUID } from "node:crypto";

import {
  contextAround,
  contextFor,
  findQuote,
  isValidSpan,
  lineOf,
  mapSpanThroughEdit,
  pageOf,
  reanchorDetailed,
  type Span,
} from "./anchor.ts";
import type { ProjectFile } from "./compile.ts";
import { all, get, run, tx, type Db, type DocumentRow, type SuggestionRow, type ThreadRow, type User, type VersionRow } from "./db.ts";
import { projectPatch } from "./diff.ts";
import { indexLatex, indexPlain, locate, normalizedSlice, offsetOfLine, tidySourceSpan, type TextIndex } from "./latex.ts";
import { extractPdfText } from "./pdftext.ts";
import {
  clip,
  currentVersion,
  insertComment,
  insertSuggestion,
  loadDocument,
  now,
  pendingSuggestions,
  requireReviewer,
  requireText,
  ReviewError,
} from "./review.ts";
import { parseSyncTex, syncTexLookup, type SyncTex } from "./synctex.ts";
import { detectMainFile, isTextPath, MAX_PROJECT_BYTES, MAX_PROJECT_FILES } from "./zip.ts";

// ---------- blobs & files ----------

export function putBlob(db: Db, data: Uint8Array): string {
  const sha = createHash("sha256").update(data).digest("hex");
  run(db, "INSERT OR IGNORE INTO blobs (sha256, data, size) VALUES (?, ?, ?)", sha, data, data.length);
  return sha;
}

export function getBlob(db: Db, sha: string): Uint8Array {
  const row = get<{ data: Uint8Array }>(db, "SELECT data FROM blobs WHERE sha256 = ?", sha);
  if (!row) throw new ReviewError(500, "corrupt", "missing file content");
  return row.data;
}

export function deleteOrphanBlobs(db: Db): void {
  run(db, "DELETE FROM blobs WHERE sha256 NOT IN (SELECT sha256 FROM paper_files)");
}

export function versionFiles(db: Db, documentId: string, version: number): Array<{ path: string; sha256: string; size: number }> {
  return all(
    db,
    `SELECT f.path, f.sha256, b.size FROM paper_files f JOIN blobs b ON b.sha256 = f.sha256
     WHERE f.document_id = ? AND f.version = ? ORDER BY f.path`,
    documentId, version,
  );
}

export function loadProject(db: Db, documentId: string, version: number): ProjectFile[] {
  return versionFiles(db, documentId, version).map((f) => ({ path: f.path, data: getBlob(db, f.sha256) }));
}

const decoder = new TextDecoder("utf-8", { fatal: false });

export function readTextFile(db: Db, documentId: string, version: number, path: string): string | null {
  const row = get<{ sha256: string }>(db, "SELECT sha256 FROM paper_files WHERE document_id = ? AND version = ? AND path = ?", documentId, version, path);
  return row ? decoder.decode(getBlob(db, row.sha256)) : null;
}

function textFiles(db: Db, documentId: string, version: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of versionFiles(db, documentId, version)) {
    if (isTextPath(f.path)) out.set(f.path, decoder.decode(getBlob(db, f.sha256)));
  }
  return out;
}

function validateProject(files: ProjectFile[], mainPath?: unknown): string {
  if (files.length === 0) throw new ReviewError(400, "invalid_request", "the project has no files");
  if (files.length > MAX_PROJECT_FILES) throw new ReviewError(413, "too_large", `too many files (max ${MAX_PROJECT_FILES})`);
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > MAX_PROJECT_BYTES) throw new ReviewError(413, "too_large", `project is too large (max ${MAX_PROJECT_BYTES / 1024 / 1024} MB)`);
  const main = typeof mainPath === "string" && mainPath ? mainPath : detectMainFile(files);
  if (!main || !files.some((f) => f.path === main)) {
    throw new ReviewError(400, "no_main_file", "couldn't find the main .tex file (one with \\documentclass); pass main_path");
  }
  return main;
}

// ---------- caches ----------

const indexCache = new Map<string, TextIndex>();
function latexIndex(content: string): TextIndex {
  const key = createHash("sha1").update(content).digest("hex");
  let idx = indexCache.get(key);
  if (!idx) {
    idx = indexLatex(content);
    indexCache.set(key, idx);
    if (indexCache.size > 200) indexCache.delete(indexCache.keys().next().value!);
  }
  return idx;
}

const syncCache = new Map<string, SyncTex>();
function syncFor(version: VersionRow): SyncTex | null {
  if (!version.synctex || !version.pdf_sha) return null;
  const key = `${version.document_id}:${version.version}:${version.pdf_sha}`;
  let sync = syncCache.get(key);
  if (!sync) {
    try {
      sync = parseSyncTex(version.synctex, "/");
    } catch {
      return null;
    }
    syncCache.set(key, sync);
    if (syncCache.size > 20) syncCache.delete(syncCache.keys().next().value!);
  }
  return sync;
}

/** SyncTeX stores absolute paths from wherever it was compiled; match them to
 *  project paths by the longest path suffix. */
function resolveSyncPath(input: string, projectPaths: string[]): string | null {
  const norm = `/${input.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  let best: string | null = null;
  for (const p of projectPaths) {
    if ((norm === `/${p}` || norm.endsWith(`/${p}`)) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

// ---------- mapping ----------

export interface SourceAnchor extends Span {
  path: string;
  quote: string;
  method: "synctex" | "text" | "source";
}

/** Map a PDF selection to the LaTeX that produced it. */
export function mapPdfToSource(
  db: Db,
  doc: DocumentRow,
  version: VersionRow,
  input: { quote: string; page?: number; x?: number; y?: number },
): SourceAnchor | null {
  const files = textFiles(db, doc.id, version.version);
  const tex = [...files.entries()].filter(([p]) => /\.tex$/i.test(p));
  const needle = indexPlain(input.quote).norm;
  if (needle.length < 3) return null;

  let hint: { path: string; line: number } | null = null;
  const sync = syncFor(version);
  if (sync && input.page && Number.isFinite(input.x) && Number.isFinite(input.y)) {
    const hit = syncTexLookup(sync, input.page, input.x!, input.y!);
    const path = hit ? resolveSyncPath(hit.path, [...files.keys()]) : null;
    if (hit && path) hint = { path, line: hit.line };
  }

  let best: { path: string; span: Span; errors: number } | null = null;
  const consider = (path: string, content: string, near?: number) => {
    const m = locate(latexIndex(content), needle, near);
    if (m && (!best || m.errors < best.errors)) best = { path, span: m, errors: m.errors };
  };
  if (hint) {
    const content = files.get(hint.path);
    if (content !== undefined) {
      consider(hint.path, content, offsetOfLine(content, hint.line));
      // A good match in the file SyncTeX points at wins outright.
      if (best && (best as { errors: number }).errors <= Math.floor(needle.length / 8)) {
        const b = best as { path: string; span: Span };
        return finish(b.path, content, b.span, "synctex");
      }
    }
  }
  for (const [path, content] of tex) {
    if (path === hint?.path) continue;
    consider(path, content);
  }
  if (!best) return null;
  const b = best as { path: string; span: Span };
  return finish(b.path, files.get(b.path)!, b.span, hint?.path === b.path ? "synctex" : "text");

  function finish(path: string, content: string, span: Span, method: SourceAnchor["method"]): SourceAnchor {
    const tidy = tidySourceSpan(content, span);
    return { path, ...tidy, quote: content.slice(tidy.start, tidy.end), method };
  }
}

/** Where a LaTeX span shows up in the PDF text. */
export function mapSourceToPdf(pdfText: string, content: string, span: Span, nearPdf?: number): Span | null {
  const needle = normalizedSlice(latexIndex(content), span);
  if (needle.length < 3) return null;
  const m = locate(indexPlain(pdfText), needle, nearPdf);
  return m ? { start: m.start, end: m.end } : null;
}

// ---------- create / update ----------

export function createPaper(db: Db, user: User, input: {
  title?: unknown;
  filename?: unknown;
  files: ProjectFile[];
  mainPath?: unknown;
  reviewerAgentId?: string | null;
  hasPdf: boolean;
  compilerAvailable: boolean;
}): DocumentRow {
  const main = validateProject(input.files, input.mainPath);
  const filename = typeof input.filename === "string" && input.filename.trim() ? input.filename.trim().slice(0, 255) : "paper.zip";
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 200) : filename.replace(/\.zip$/i, "");
  const reviewer = requireReviewer(db, user, input.reviewerAgentId ?? (user.type === "agent" ? user.id : null));
  const id = randomUUID();
  const t = now();
  const status = input.hasPdf ? "processing" : input.compilerAvailable ? "queued" : "needs_pdf";
  tx(db, () => {
    run(
      db,
      `INSERT INTO documents (id, title, kind, filename, created_by, reviewer_agent_id, current_version, created_at, updated_at, main_path)
       VALUES (?, ?, 'paper', ?, ?, ?, 1, ?, ?, ?)`,
      id, title, filename, user.id, reviewer, t, t, main,
    );
    run(
      db,
      `INSERT INTO versions (document_id, version, text, file, created_by, note, created_at, compile_status)
       VALUES (?, 1, '', NULL, ?, 'Initial upload', ?, ?)`,
      id, user.id, t, status,
    );
    for (const f of input.files) {
      run(db, "INSERT INTO paper_files (document_id, version, path, sha256) VALUES (?, 1, ?, ?)", id, f.path, putBlob(db, f.data));
    }
  });
  return loadDocument(db, user, id);
}

/** New source version (agent pushes its repo state, or a human uploads a new
 *  zip). Source anchors re-anchor by quote; PDF anchors follow after compile. */
export function addPaperSources(db: Db, user: User, documentId: string, input: {
  files: ProjectFile[];
  mainPath?: unknown;
  note?: unknown;
  hasPdf: boolean;
  compilerAvailable: boolean;
}): { doc: DocumentRow; version: number } {
  const doc = loadDocument(db, user, documentId);
  if (doc.kind !== "paper") throw new ReviewError(400, "not_a_paper", "this document is not a LaTeX project");
  const main = validateProject(input.files, input.mainPath ?? doc.main_path);
  const cur = currentVersion(db, doc);
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : "New sources";
  const t = now();
  const version = doc.current_version + 1;
  const contents = new Map(input.files.filter((f) => isTextPath(f.path)).map((f) => [f.path, decoder.decode(f.data)]));
  tx(db, () => {
    run(
      db,
      `INSERT INTO versions (document_id, version, text, file, created_by, note, created_at, synctex, compile_status, pdf_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      doc.id, version, cur.text, cur.file, user.id, note, t, cur.synctex,
      input.hasPdf ? "processing" : input.compilerAvailable ? "queued" : "needs_pdf", cur.pdf_sha,
    );
    for (const f of input.files) {
      run(db, "INSERT INTO paper_files (document_id, version, path, sha256) VALUES (?, ?, ?, ?)", doc.id, version, f.path, putBlob(db, f.data));
    }
    run(db, "UPDATE documents SET current_version = ?, main_path = ?, updated_at = ? WHERE id = ?", version, main, t, doc.id);
    for (const thread of all<ThreadRow>(db, "SELECT * FROM threads WHERE document_id = ? AND src_path IS NOT NULL", doc.id)) {
      const content = contents.get(thread.src_path!);
      const found = content === undefined ? null : reanchorDetailed(content, {
        start: thread.src_start!, end: thread.src_end!, quote: thread.src_quote!,
        prefix: thread.src_prefix ?? "", suffix: thread.src_suffix ?? "",
      });
      if (found) updateSourceAnchor(db, thread.id, content!, found.span);
      else run(db, "UPDATE threads SET src_path = NULL, src_start = NULL, src_end = NULL WHERE id = ?", thread.id);
    }
    for (const s of pendingSuggestions(db, doc.id)) {
      if (!s.path) continue;
      const content = contents.get(s.path);
      const found = content === undefined ? null : reanchorDetailed(content, { start: s.start, end: s.end, quote: s.original });
      if (found?.match === "exact") run(db, `UPDATE suggestions SET start = ?, "end" = ? WHERE id = ?`, found.span.start, found.span.end, s.id);
      else run(db, "UPDATE suggestions SET status = 'stale', decided_at = ? WHERE id = ?", t, s.id);
    }
  });
  return { doc: loadDocument(db, user, documentId), version };
}

function updateSourceAnchor(db: Db, threadId: string, content: string, span: Span): void {
  const ctx = contextFor(content, span);
  run(
    db,
    `UPDATE threads SET src_start = ?, src_end = ?, src_quote = ?, src_prefix = ?, src_suffix = ? WHERE id = ?`,
    span.start, span.end, content.slice(span.start, span.end), ctx.prefix, ctx.suffix, threadId,
  );
}

export function setCompileStatus(db: Db, documentId: string, version: number, status: string, log = ""): void {
  run(db, "UPDATE versions SET compile_status = ?, compile_log = ? WHERE document_id = ? AND version = ?", status, log, documentId, version);
}

/** Store a compiled (or agent-uploaded) PDF for a version. When it is the
 *  current version, every comment's PDF highlight is re-placed: from its
 *  source span first (the source is the truth after an edit), then by quote. */
export async function ingestPdf(db: Db, documentId: string, version: number, pdf: Uint8Array, synctex: Uint8Array | null, log = ""): Promise<void> {
  if (pdf.length < 5 || Buffer.from(pdf.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    throw new ReviewError(400, "not_a_pdf", "the uploaded file is not a PDF");
  }
  const text = await extractPdfText(pdf);
  const pdfSha = createHash("sha256").update(pdf).digest("hex");
  const doc = get<DocumentRow>(db, "SELECT * FROM documents WHERE id = ?", documentId);
  if (!doc) return;
  tx(db, () => {
    run(
      db,
      `UPDATE versions SET file = ?, synctex = ?, text = ?, pdf_sha = ?, compile_status = 'ok', compile_log = ?
       WHERE document_id = ? AND version = ?`,
      pdf, synctex, text, pdfSha, log, documentId, version,
    );
    if (doc.current_version !== version) return;
    const files = textFiles(db, documentId, version);
    for (const thread of all<ThreadRow>(db, "SELECT * FROM threads WHERE document_id = ?", documentId)) {
      let span: Span | null = null;
      if (thread.src_path && files.has(thread.src_path)) {
        span = mapSourceToPdf(text, files.get(thread.src_path)!, { start: thread.src_start!, end: thread.src_end! }, thread.start);
      }
      if (!span && thread.quote) span = reanchorDetailed(text, thread)?.span ?? null;
      if (span) {
        const ctx = contextFor(text, span);
        run(
          db,
          `UPDATE threads SET start = ?, "end" = ?, quote = ?, prefix = ?, suffix = ?,
             status = CASE WHEN status = 'orphaned' THEN 'open' ELSE status END WHERE id = ?`,
          span.start, span.end, text.slice(span.start, span.end), ctx.prefix, ctx.suffix, thread.id,
        );
      } else if (!thread.src_path && thread.status === "open") {
        run(db, "UPDATE threads SET status = 'orphaned' WHERE id = ?", thread.id);
      }
    }
    run(db, "UPDATE documents SET updated_at = ? WHERE id = ?", now(), documentId);
  });
}

// ---------- threads & suggestions ----------

export function createPaperThread(db: Db, user: User, doc: DocumentRow, input: {
  start?: unknown;
  end?: unknown;
  quote?: unknown;
  path?: unknown;
  occurrence?: unknown;
  page?: unknown;
  x?: unknown;
  y?: unknown;
  body?: unknown;
  replacement?: unknown;
  rationale?: unknown;
}): ThreadRow {
  const version = currentVersion(db, doc);
  const body = requireText(input.body, "body");
  const pdfText = version.text;
  let pdf: Span | null = null;
  let src: SourceAnchor | null = null;

  if (typeof input.start === "number" && typeof input.end === "number") {
    // A selection in the rendered PDF (web UI).
    const span = { start: input.start, end: input.end };
    if (!isValidSpan(pdfText, span) || span.start === span.end) {
      throw new ReviewError(400, "invalid_anchor", "start/end must select text in the current PDF");
    }
    if (typeof input.quote === "string" && pdfText.slice(span.start, span.end) !== input.quote) {
      throw new ReviewError(409, "anchor_moved", "the PDF changed; reload and select again");
    }
    pdf = span;
    src = mapPdfToSource(db, doc, version, {
      quote: pdfText.slice(span.start, span.end),
      page: pageOf(pdfText, span.start),
      x: typeof input.x === "number" ? input.x : undefined,
      y: typeof input.y === "number" ? input.y : undefined,
    });
  } else if (typeof input.quote === "string" && input.quote) {
    // An agent quoting the source (preferred) or the PDF.
    src = findInSource(db, doc, version, input.quote, input.path, input.occurrence);
    if (src) {
      pdf = mapSourceToPdf(pdfText, readTextFile(db, doc.id, version.version, src.path)!, src);
    } else {
      const m = locate(indexPlain(pdfText), indexPlain(input.quote).norm);
      if (!m) throw new ReviewError(404, "quote_not_found", "quote not found in the LaTeX sources or the PDF text");
      pdf = { start: m.start, end: m.end };
      src = mapPdfToSource(db, doc, version, { quote: pdfText.slice(m.start, m.end), page: pageOf(pdfText, m.start) });
    }
  } else {
    throw new ReviewError(400, "invalid_anchor", "give start/end in the PDF text or an exact quote");
  }

  const id = randomUUID();
  const t = now();
  const pdfSpan = pdf ?? { start: 0, end: 0 };
  const pdfCtx = pdf ? contextFor(pdfText, pdf) : { prefix: "", suffix: "" };
  const srcContent = src ? readTextFile(db, doc.id, version.version, src.path)! : null;
  const srcCtx = src && srcContent !== null ? contextFor(srcContent, src) : null;
  tx(db, () => {
    run(
      db,
      `INSERT INTO threads (id, document_id, start, "end", quote, prefix, suffix, status, created_by, created_at, updated_at,
         src_path, src_start, src_end, src_quote, src_prefix, src_suffix, src_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, doc.id, pdfSpan.start, pdfSpan.end, pdf ? pdfText.slice(pdf.start, pdf.end) : (src?.quote ?? ""),
      pdfCtx.prefix, pdfCtx.suffix, user.id, t, t,
      src?.path ?? null, src?.start ?? null, src?.end ?? null, src?.quote ?? null,
      srcCtx?.prefix ?? null, srcCtx?.suffix ?? null, src?.method ?? null,
    );
    insertComment(db, id, user.id, body, t);
    if (typeof input.replacement === "string") {
      if (!src) throw new ReviewError(422, "unmapped", "couldn't find this text in the LaTeX sources; comment without a replacement");
      insertSuggestion(db, id, user.id, src, src.quote, input.replacement, input.rationale, t, src.path);
    }
    run(db, "UPDATE documents SET updated_at = ? WHERE id = ?", t, doc.id);
  });
  return get<ThreadRow>(db, "SELECT * FROM threads WHERE id = ?", id)!;
}

function findInSource(db: Db, doc: DocumentRow, version: VersionRow, quote: string, path: unknown, occurrence: unknown): SourceAnchor | null {
  const occ = occurrence === undefined || occurrence === "" ? undefined : Number(occurrence);
  const files = textFiles(db, doc.id, version.version);
  const candidates = typeof path === "string" && path ? [[path, files.get(path)] as const] : [...files.entries()].filter(([p]) => /\.(tex|bib)$/i.test(p));
  for (const [p, content] of candidates) {
    if (content === undefined) throw new ReviewError(404, "file_not_found", `no file ${String(p)} in the project`);
    const span = findQuote(content, quote, { occurrence: occ });
    if (span) return { path: p, ...span, quote, method: "source" };
  }
  return null;
}

export function createPaperSuggestion(db: Db, user: User, thread: ThreadRow, doc: DocumentRow, input: {
  replacement?: unknown;
  quote?: unknown;
  occurrence?: unknown;
  path?: unknown;
  rationale?: unknown;
}): SuggestionRow {
  if (typeof input.replacement !== "string") throw new ReviewError(400, "invalid_request", "replacement is required (may be empty to delete)");
  const version = currentVersion(db, doc);
  const path = typeof input.path === "string" && input.path ? input.path : thread.src_path;
  if (!path) {
    throw new ReviewError(422, "unmapped", "this comment isn't mapped to a source file; pass path and quote");
  }
  const content = readTextFile(db, doc.id, version.version, path);
  if (content === null) throw new ReviewError(404, "file_not_found", `no file ${path} in the project`);
  let span: Span | null = path === thread.src_path && thread.src_start !== null ? { start: thread.src_start, end: thread.src_end! } : null;
  if (typeof input.quote === "string" && input.quote) {
    const inside = span ? findQuote(content.slice(span.start, span.end), input.quote) : null;
    span = inside && input.occurrence === undefined
      ? { start: span!.start + inside.start, end: span!.start + inside.end }
      : findQuote(content, input.quote, { occurrence: input.occurrence === undefined ? undefined : Number(input.occurrence) });
    if (!span) throw new ReviewError(404, "quote_not_found", `quote not found in ${path}`);
  }
  if (!span) throw new ReviewError(400, "invalid_request", "pass the exact quote to replace in that file");
  const t = now();
  const id = tx(db, () => {
    const sid = insertSuggestion(db, thread.id, user.id, span!, content.slice(span!.start, span!.end), input.replacement as string, input.rationale, t, path);
    run(db, "UPDATE threads SET status = 'open', updated_at = ? WHERE id = ?", t, thread.id);
    run(db, "UPDATE documents SET updated_at = ? WHERE id = ?", t, doc.id);
    return sid;
  });
  return get<SuggestionRow>(db, "SELECT * FROM suggestions WHERE id = ?", id)!;
}

/** Apply an accepted suggestion to its source file in a new version. The PDF
 *  of the previous version stays visible until the new one is compiled. */
export function acceptPaperSuggestion(db: Db, user: User, doc: DocumentRow, suggestion: SuggestionRow, compilerAvailable: boolean): number {
  const path = suggestion.path!;
  const cur = currentVersion(db, doc);
  const content = readTextFile(db, doc.id, cur.version, path);
  const span = { start: suggestion.start, end: suggestion.end };
  const t = now();
  if (content === null || !isValidSpan(content, span) || content.slice(span.start, span.end) !== suggestion.original) {
    run(db, "UPDATE suggestions SET status = 'stale', decided_at = ? WHERE id = ?", t, suggestion.id);
    throw new ReviewError(409, "stale", "the source this suggestion changes was edited since; ask for a new suggestion");
  }
  const next = content.slice(0, span.start) + suggestion.replacement + content.slice(span.end);
  const edit = { start: span.start, end: span.end, insertLength: suggestion.replacement.length };
  const version = cur.version + 1;
  const where = `${path}:${lineOf(content, span.start)}`;
  tx(db, () => {
    run(
      db,
      `INSERT INTO versions (document_id, version, text, file, created_by, note, created_at, synctex, compile_status, pdf_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      doc.id, version, cur.text, cur.file, user.id, `Accepted edit at ${where}`, t, cur.synctex,
      compilerAvailable ? "queued" : "needs_pdf", cur.pdf_sha,
    );
    run(
      db,
      `INSERT INTO paper_files (document_id, version, path, sha256)
       SELECT document_id, ?, path, sha256 FROM paper_files WHERE document_id = ? AND version = ? AND path != ?`,
      version, doc.id, cur.version, path,
    );
    run(db, "INSERT INTO paper_files (document_id, version, path, sha256) VALUES (?, ?, ?, ?)", doc.id, version, path, putBlob(db, new TextEncoder().encode(next)));
    run(db, "UPDATE documents SET current_version = ?, updated_at = ? WHERE id = ?", version, t, doc.id);
    run(db, "UPDATE suggestions SET status = 'accepted', decided_by = ?, decided_at = ? WHERE id = ?", user.id, t, suggestion.id);
    for (const thread of all<ThreadRow>(db, "SELECT * FROM threads WHERE document_id = ? AND src_path = ?", doc.id, path)) {
      updateSourceAnchor(db, thread.id, next, mapSpanThroughEdit({ start: thread.src_start!, end: thread.src_end! }, edit));
    }
    for (const other of pendingSuggestions(db, doc.id)) {
      if (other.path !== path) continue;
      if (other.start < span.end && span.start < other.end) {
        run(db, "UPDATE suggestions SET status = 'stale', decided_at = ? WHERE id = ?", t, other.id);
      } else {
        const mapped = mapSpanThroughEdit(other, edit);
        run(db, `UPDATE suggestions SET start = ?, "end" = ? WHERE id = ?`, mapped.start, mapped.end, other.id);
      }
    }
  });
  return version;
}

// ---------- views ----------

export function paperPatch(db: Db, documentId: string, from: number, to: number): string {
  return projectPatch(textFiles(db, documentId, from), textFiles(db, documentId, to));
}

export function paperInfo(db: Db, doc: DocumentRow, version: VersionRow) {
  return {
    main_path: doc.main_path,
    compile: {
      status: version.compile_status,
      has_log: Boolean(version.compile_log),
      pdf_ready: Boolean(version.file),
      /** Changes exactly when the PDF bytes change (cache key for viewers). */
      pdf_sha: version.pdf_sha ? version.pdf_sha.slice(0, 16) : null,
    },
    files: versionFiles(db, doc.id, version.version).map((f) => ({ path: f.path, size: f.size, text: isTextPath(f.path) })),
  };
}

export function sourceView(thread: ThreadRow, files: Map<string, string> | null) {
  if (!thread.src_path || thread.src_start === null) return null;
  const content = files?.get(thread.src_path);
  return {
    path: thread.src_path,
    start: thread.src_start,
    end: thread.src_end,
    quote: thread.src_quote,
    line: content ? lineOf(content, thread.src_start) : null,
    method: thread.src_method,
  };
}

export function sourceFilesFor(db: Db, doc: DocumentRow): Map<string, string> | null {
  return doc.kind === "paper" ? textFiles(db, doc.id, doc.current_version) : null;
}

export function sourceContext(db: Db, doc: DocumentRow, thread: ThreadRow) {
  if (!thread.src_path || thread.src_start === null) return null;
  const content = readTextFile(db, doc.id, doc.current_version, thread.src_path);
  if (content === null) return null;
  return contextAround(content, { start: thread.src_start, end: thread.src_end! }, 600);
}

export function suggestionLine(files: Map<string, string> | null, s: SuggestionRow): number | null {
  const content = s.path ? files?.get(s.path) : undefined;
  return content ? lineOf(content, s.start) : null;
}

export { clip };
