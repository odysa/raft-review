import { randomUUID } from "node:crypto";

import {
  applyEdit,
  contextAround,
  findQuote,
  isValidSpan,
  lineOf,
  mapSpanThroughEdit,
  pageOf,
  reanchor,
  type Span,
} from "./anchor.ts";
import {
  all,
  get,
  run,
  tx,
  type CommentRow,
  type Db,
  type DocKind,
  type DocumentRow,
  type SuggestionRow,
  type ThreadRow,
  type User,
  type VersionRow,
} from "./db.ts";

export class ReviewError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_BODY = 20_000;
const MAX_TITLE = 200;

function now(): number {
  return Date.now();
}

function requireText(value: unknown, field: string, max = MAX_BODY): string {
  if (typeof value !== "string" || !value.trim()) throw new ReviewError(400, "invalid_request", `${field} is required`);
  if (value.length > max) throw new ReviewError(400, "invalid_request", `${field} is too long (max ${max} characters)`);
  return value;
}

export function kindFromFilename(filename: string): DocKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".tex") || lower.endsWith(".latex") || lower.endsWith(".bib")) return "latex";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return "text";
}

// ---------- users ----------

export function upsertUser(db: Db, user: User): User {
  run(
    db,
    `INSERT INTO users (id, type, name, username, avatar_url, server_id, server_slug, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name, username=excluded.username,
       avatar_url=excluded.avatar_url, server_id=excluded.server_id, server_slug=excluded.server_slug,
       updated_at=excluded.updated_at`,
    user.id, user.type, user.name, user.username, user.avatar_url, user.server_id, user.server_slug, now(),
  );
  return user;
}

export function getUser(db: Db, id: string): User | undefined {
  return get<User>(db, "SELECT id, type, name, username, avatar_url, server_id, server_slug FROM users WHERE id = ?", id);
}

export function listAgents(db: Db, serverId: string): User[] {
  return all<User>(
    db,
    "SELECT id, type, name, username, avatar_url, server_id, server_slug FROM users WHERE type = 'agent' AND server_id = ? ORDER BY name",
    serverId,
  );
}

// ---------- documents ----------

function loadDocument(db: Db, user: User, documentId: string): DocumentRow {
  const doc = get<DocumentRow & { server_id: string }>(
    db,
    `SELECT d.*, u.server_id AS server_id FROM documents d JOIN users u ON u.id = d.created_by WHERE d.id = ?`,
    documentId,
  );
  // Same 404 for "missing" and "other server" so IDs cannot be probed.
  if (!doc || doc.server_id !== user.server_id) throw new ReviewError(404, "not_found", "document not found");
  return doc;
}

function currentVersion(db: Db, doc: DocumentRow): VersionRow {
  const version = get<VersionRow>(
    db,
    "SELECT * FROM versions WHERE document_id = ? AND version = ?",
    doc.id, doc.current_version,
  );
  if (!version) throw new ReviewError(500, "corrupt", "document has no current version");
  return version;
}

function requireReviewer(db: Db, user: User, agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  const agent = getUser(db, agentId);
  if (!agent || agent.type !== "agent" || agent.server_id !== user.server_id) {
    throw new ReviewError(400, "invalid_request", "reviewer_agent_id must be an agent that has signed in to this app");
  }
  return agent.id;
}

export function createDocument(db: Db, user: User, input: {
  title: unknown;
  filename: unknown;
  text: unknown;
  file?: Uint8Array | null;
  reviewerAgentId?: string | null;
}): DocumentRow {
  const filename = requireText(input.filename, "filename", 255);
  const kind = kindFromFilename(filename);
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, MAX_TITLE) : filename;
  const text = typeof input.text === "string" ? input.text : "";
  if (kind === "pdf" && !input.file) throw new ReviewError(400, "invalid_request", "a PDF upload needs the file bytes");
  if (kind !== "pdf" && !text) throw new ReviewError(400, "invalid_request", "text is required");
  if (text.length > 5_000_000) throw new ReviewError(413, "too_large", "document text is too large");
  // An agent that uploads a draft is its natural reviewer.
  const reviewer = requireReviewer(db, user, input.reviewerAgentId ?? (user.type === "agent" ? user.id : null));
  const id = randomUUID();
  const t = now();
  tx(db, () => {
    run(
      db,
      `INSERT INTO documents (id, title, kind, filename, created_by, reviewer_agent_id, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id, title, kind, filename, user.id, reviewer, t, t,
    );
    run(
      db,
      "INSERT INTO versions (document_id, version, text, file, created_by, note, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)",
      id, text, input.file ?? null, user.id, "Initial upload", t,
    );
  });
  return loadDocument(db, user, id);
}

export function listDocuments(db: Db, user: User): Array<DocumentRow & { open_threads: number; pending_suggestions: number }> {
  return all(
    db,
    `SELECT d.*,
       (SELECT COUNT(*) FROM threads t WHERE t.document_id = d.id AND t.status = 'open') AS open_threads,
       (SELECT COUNT(*) FROM suggestions s JOIN threads t ON t.id = s.thread_id
          WHERE t.document_id = d.id AND s.status = 'pending') AS pending_suggestions
     FROM documents d JOIN users u ON u.id = d.created_by
     WHERE u.server_id = ?
     ORDER BY d.updated_at DESC`,
    user.server_id,
  );
}

export function setReviewer(db: Db, user: User, documentId: string, agentId: string | null): DocumentRow {
  const doc = loadDocument(db, user, documentId);
  const reviewer = requireReviewer(db, user, agentId);
  run(db, "UPDATE documents SET reviewer_agent_id = ?, updated_at = ? WHERE id = ?", reviewer, now(), doc.id);
  return loadDocument(db, user, documentId);
}

export function deleteDocument(db: Db, user: User, documentId: string): void {
  const doc = loadDocument(db, user, documentId);
  if (doc.created_by !== user.id && user.type !== "human") {
    throw new ReviewError(403, "forbidden", "only a human or the uploader can delete a document");
  }
  run(db, "DELETE FROM documents WHERE id = ?", doc.id);
}

export function getFile(db: Db, user: User, documentId: string, version?: number): { doc: DocumentRow; version: VersionRow } {
  const doc = loadDocument(db, user, documentId);
  const row = get<VersionRow>(
    db,
    "SELECT * FROM versions WHERE document_id = ? AND version = ?",
    doc.id, version ?? doc.current_version,
  );
  if (!row) throw new ReviewError(404, "not_found", "version not found");
  return { doc, version: row };
}

/** Upload a whole new version (e.g. an agent's full rewrite, or a recompiled
 *  PDF). Open threads are re-anchored by quote; ones whose text vanished are
 *  marked orphaned, and pending suggestions that no longer apply go stale. */
export function addVersion(db: Db, user: User, documentId: string, input: {
  text: unknown;
  file?: Uint8Array | null;
  note?: unknown;
}): DocumentRow {
  const doc = loadDocument(db, user, documentId);
  const text = typeof input.text === "string" ? input.text : "";
  if (doc.kind === "pdf" && !input.file) throw new ReviewError(400, "invalid_request", "a PDF version needs the file bytes");
  if (doc.kind !== "pdf" && !text) throw new ReviewError(400, "invalid_request", "text is required");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : "New version";
  const t = now();
  tx(db, () => {
    const version = doc.current_version + 1;
    run(
      db,
      "INSERT INTO versions (document_id, version, text, file, created_by, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      doc.id, version, text, input.file ?? null, user.id, note, t,
    );
    run(db, "UPDATE documents SET current_version = ?, updated_at = ? WHERE id = ?", version, t, doc.id);
    for (const thread of all<ThreadRow>(db, "SELECT * FROM threads WHERE document_id = ? AND status != 'resolved'", doc.id)) {
      const span = reanchor(text, thread);
      if (span) {
        run(db, `UPDATE threads SET start = ?, "end" = ?, status = 'open', updated_at = ? WHERE id = ?`, span.start, span.end, t, thread.id);
      } else {
        run(db, "UPDATE threads SET status = 'orphaned', updated_at = ? WHERE id = ?", t, thread.id);
      }
    }
    for (const s of pendingSuggestions(db, doc.id)) {
      const span = reanchor(text, { start: s.start, end: s.end, quote: s.original });
      if (span) run(db, `UPDATE suggestions SET start = ?, "end" = ? WHERE id = ?`, span.start, span.end, s.id);
      else run(db, "UPDATE suggestions SET status = 'stale', decided_at = ? WHERE id = ?", t, s.id);
    }
  });
  return loadDocument(db, user, documentId);
}

// ---------- threads ----------

function loadThread(db: Db, user: User, threadId: string): { thread: ThreadRow; doc: DocumentRow } {
  const thread = get<ThreadRow>(db, "SELECT * FROM threads WHERE id = ?", threadId);
  if (!thread) throw new ReviewError(404, "not_found", "thread not found");
  const doc = loadDocument(db, user, thread.document_id);
  return { thread, doc };
}

export interface AnchorInput {
  start?: unknown;
  end?: unknown;
  quote?: unknown;
  occurrence?: unknown;
}

/** Resolve an anchor from explicit offsets (the web UI) or a quote (agents,
 *  who should not have to count characters). */
function resolveAnchor(text: string, input: AnchorInput): Span {
  if (typeof input.start === "number" && typeof input.end === "number") {
    const span = { start: input.start, end: input.end };
    if (!isValidSpan(text, span) || span.start === span.end) {
      throw new ReviewError(400, "invalid_anchor", "start/end must select a non-empty range of the current text");
    }
    if (typeof input.quote === "string" && input.quote && text.slice(span.start, span.end) !== input.quote) {
      throw new ReviewError(409, "anchor_moved", "the selected text changed; reload and select again");
    }
    return span;
  }
  if (typeof input.quote === "string" && input.quote) {
    const occurrence = input.occurrence === undefined || input.occurrence === "" ? undefined : Number(input.occurrence);
    if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 1)) {
      throw new ReviewError(400, "invalid_anchor", "occurrence must be a positive integer");
    }
    const span = findQuote(text, input.quote, { occurrence });
    if (!span) throw new ReviewError(404, "quote_not_found", "quote does not appear in the current text (match it exactly)");
    return span;
  }
  throw new ReviewError(400, "invalid_anchor", "give either start/end offsets or an exact quote");
}

export function createThread(db: Db, user: User, documentId: string, input: AnchorInput & {
  body?: unknown;
  replacement?: unknown;
  rationale?: unknown;
}): ThreadRow {
  const doc = loadDocument(db, user, documentId);
  const { text } = currentVersion(db, doc);
  const span = resolveAnchor(text, input);
  const body = requireText(input.body, "body");
  const id = randomUUID();
  const t = now();
  tx(db, () => {
    run(
      db,
      `INSERT INTO threads (id, document_id, start, "end", quote, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      id, doc.id, span.start, span.end, text.slice(span.start, span.end), user.id, t, t,
    );
    insertComment(db, id, user.id, body, t);
    if (typeof input.replacement === "string") {
      insertSuggestion(db, id, user.id, span, text.slice(span.start, span.end), input.replacement, input.rationale, t);
    }
    run(db, "UPDATE documents SET updated_at = ? WHERE id = ?", t, doc.id);
  });
  return get<ThreadRow>(db, "SELECT * FROM threads WHERE id = ?", id)!;
}

function insertComment(db: Db, threadId: string, authorId: string, body: string, t: number): CommentRow {
  const id = randomUUID();
  run(db, "INSERT INTO comments (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)", id, threadId, authorId, body, t);
  return { id, thread_id: threadId, author_id: authorId, body, created_at: t };
}

function insertSuggestion(
  db: Db, threadId: string, authorId: string, span: Span, original: string,
  replacement: string, rationale: unknown, t: number,
): string {
  if (replacement.length > 200_000) throw new ReviewError(400, "invalid_request", "replacement is too long");
  if (replacement === original) throw new ReviewError(400, "invalid_request", "replacement is identical to the original text");
  const id = randomUUID();
  run(
    db,
    `INSERT INTO suggestions (id, thread_id, author_id, start, "end", original, replacement, rationale, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    id, threadId, authorId, span.start, span.end, original, replacement,
    typeof rationale === "string" ? rationale.slice(0, MAX_BODY) : "", t,
  );
  return id;
}

export function addComment(db: Db, user: User, threadId: string, body: unknown): CommentRow {
  const { thread, doc } = loadThread(db, user, threadId);
  const text = requireText(body, "body");
  const t = now();
  return tx(db, () => {
    const comment = insertComment(db, thread.id, user.id, text, t);
    // Replying to a resolved thread reopens it, as in most doc tools.
    run(db, `UPDATE threads SET status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END, updated_at = ? WHERE id = ?`, t, thread.id);
    run(db, "UPDATE documents SET updated_at = ? WHERE id = ?", t, doc.id);
    return comment;
  });
}

export function setThreadStatus(db: Db, user: User, threadId: string, status: "open" | "resolved"): ThreadRow {
  const { thread, doc } = loadThread(db, user, threadId);
  if (thread.status === "orphaned" && status === "open") {
    throw new ReviewError(409, "orphaned", "the anchored text no longer exists; start a new thread instead");
  }
  const t = now();
  run(db, "UPDATE threads SET status = ?, updated_at = ? WHERE id = ?", status, t, thread.id);
  run(db, "UPDATE documents SET updated_at = ? WHERE id = ?", t, doc.id);
  return get<ThreadRow>(db, "SELECT * FROM threads WHERE id = ?", thread.id)!;
}

// ---------- suggestions ----------

function pendingSuggestions(db: Db, documentId: string): SuggestionRow[] {
  return all<SuggestionRow>(
    db,
    `SELECT s.* FROM suggestions s JOIN threads t ON t.id = s.thread_id WHERE t.document_id = ? AND s.status = 'pending'`,
    documentId,
  );
}

/** Suggest replacing text. Defaults to the thread's whole anchor; `quote`
 *  narrows it to an exact sub-string (searched inside the anchor first). */
export function createSuggestion(db: Db, user: User, threadId: string, input: {
  replacement?: unknown;
  quote?: unknown;
  occurrence?: unknown;
  rationale?: unknown;
}): SuggestionRow {
  const { thread, doc } = loadThread(db, user, threadId);
  if (thread.status === "orphaned") throw new ReviewError(409, "orphaned", "the thread's text no longer exists");
  if (typeof input.replacement !== "string") throw new ReviewError(400, "invalid_request", "replacement is required (may be empty to delete)");
  const { text } = currentVersion(db, doc);
  let span: Span = { start: thread.start, end: thread.end };
  if (typeof input.quote === "string" && input.quote) {
    const inside = findQuote(text.slice(thread.start, thread.end), input.quote);
    span = inside && input.occurrence === undefined
      ? { start: thread.start + inside.start, end: thread.start + inside.end }
      : resolveAnchor(text, { quote: input.quote, occurrence: input.occurrence });
  }
  const t = now();
  const id = tx(db, () => {
    const sid = insertSuggestion(db, thread.id, user.id, span, text.slice(span.start, span.end), input.replacement as string, input.rationale, t);
    run(db, `UPDATE threads SET status = 'open', updated_at = ? WHERE id = ?`, t, thread.id);
    run(db, "UPDATE documents SET updated_at = ? WHERE id = ?", t, doc.id);
    return sid;
  });
  return get<SuggestionRow>(db, "SELECT * FROM suggestions WHERE id = ?", id)!;
}

export function decideSuggestion(db: Db, user: User, suggestionId: string, decision: "accept" | "reject"): {
  suggestion: SuggestionRow;
  document: DocumentRow;
} {
  const suggestion = get<SuggestionRow>(db, "SELECT * FROM suggestions WHERE id = ?", suggestionId);
  if (!suggestion) throw new ReviewError(404, "not_found", "suggestion not found");
  const { thread, doc } = loadThread(db, user, suggestion.thread_id);
  if (user.type !== "human") {
    throw new ReviewError(403, "human_decision", "only a human reviewer can accept or reject suggestions");
  }
  if (suggestion.status !== "pending") throw new ReviewError(409, "already_decided", `suggestion is already ${suggestion.status}`);
  const t = now();

  if (decision === "reject") {
    run(db, "UPDATE suggestions SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", user.id, t, suggestion.id);
    run(db, "UPDATE documents SET updated_at = ? WHERE id = ?", t, doc.id);
  } else if (doc.kind === "pdf") {
    // A PDF cannot be edited in place: accepting records the decision so the
    // change can be applied to the source (the agent sees it as accepted).
    run(db, "UPDATE suggestions SET status = 'accepted', decided_by = ?, decided_at = ? WHERE id = ?", user.id, t, suggestion.id);
    run(db, "UPDATE documents SET updated_at = ? WHERE id = ?", t, doc.id);
  } else {
    const version = currentVersion(db, doc);
    const span = { start: suggestion.start, end: suggestion.end };
    if (!isValidSpan(version.text, span) || version.text.slice(span.start, span.end) !== suggestion.original) {
      run(db, "UPDATE suggestions SET status = 'stale', decided_at = ? WHERE id = ?", t, suggestion.id);
      throw new ReviewError(409, "stale", "the text this suggestion changes was edited since; ask for a new suggestion");
    }
    tx(db, () => {
      const next = applyEdit(version.text, span, suggestion.replacement);
      const edit = { start: span.start, end: span.end, insertLength: suggestion.replacement.length };
      const nextVersion = doc.current_version + 1;
      run(
        db,
        "INSERT INTO versions (document_id, version, text, file, created_by, note, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        doc.id, nextVersion, next, user.id, `Accepted suggestion on “${clip(thread.quote, 60)}”`, t,
      );
      run(db, "UPDATE documents SET current_version = ?, updated_at = ? WHERE id = ?", nextVersion, t, doc.id);
      run(db, "UPDATE suggestions SET status = 'accepted', decided_by = ?, decided_at = ? WHERE id = ?", user.id, t, suggestion.id);
      for (const other of all<ThreadRow>(db, "SELECT * FROM threads WHERE document_id = ? AND status != 'orphaned'", doc.id)) {
        const mapped = mapSpanThroughEdit(other, edit);
        run(db, `UPDATE threads SET start = ?, "end" = ?, quote = ? WHERE id = ?`, mapped.start, mapped.end, next.slice(mapped.start, mapped.end), other.id);
      }
      for (const other of pendingSuggestions(db, doc.id)) {
        const overlaps = other.start < span.end && span.start < other.end;
        if (overlaps) {
          run(db, "UPDATE suggestions SET status = 'stale', decided_at = ? WHERE id = ?", t, other.id);
          continue;
        }
        const mapped = mapSpanThroughEdit(other, edit);
        run(db, `UPDATE suggestions SET start = ?, "end" = ? WHERE id = ?`, mapped.start, mapped.end, other.id);
      }
    });
  }
  return {
    suggestion: get<SuggestionRow>(db, "SELECT * FROM suggestions WHERE id = ?", suggestion.id)!,
    document: loadDocument(db, user, doc.id),
  };
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------- views ----------

function authorView(db: Db, id: string) {
  const u = getUser(db, id);
  return u ? { id: u.id, type: u.type, name: u.name, username: u.username, avatar_url: u.avatar_url } : { id, type: "human", name: "Unknown", username: "unknown", avatar_url: null };
}

export function threadView(db: Db, thread: ThreadRow, text: string, kind: DocKind) {
  const comments = all<CommentRow>(db, "SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at, rowid", thread.id);
  const suggestions = all<SuggestionRow>(db, "SELECT * FROM suggestions WHERE thread_id = ? ORDER BY created_at, rowid", thread.id);
  return {
    id: thread.id,
    document_id: thread.document_id,
    status: thread.status,
    anchor: {
      start: thread.start,
      end: thread.end,
      quote: thread.quote,
      ...(kind === "pdf" ? { page: pageOf(text, thread.start) } : { line: lineOf(text, thread.start) }),
    },
    created_by: authorView(db, thread.created_by),
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    comments: comments.map((c) => ({ id: c.id, author: authorView(db, c.author_id), body: c.body, created_at: c.created_at })),
    suggestions: suggestions.map((s) => ({
      id: s.id,
      author: authorView(db, s.author_id),
      start: s.start,
      end: s.end,
      original: s.original,
      replacement: s.replacement,
      rationale: s.rationale,
      status: s.status,
      decided_by: s.decided_by ? authorView(db, s.decided_by) : null,
      decided_at: s.decided_at,
      created_at: s.created_at,
    })),
  };
}

export function documentView(db: Db, user: User, documentId: string, opts: { includeText?: boolean } = {}) {
  const doc = loadDocument(db, user, documentId);
  const version = currentVersion(db, doc);
  const threads = all<ThreadRow>(db, "SELECT * FROM threads WHERE document_id = ? ORDER BY start, created_at", doc.id);
  const versions = all<{ version: number; note: string; created_by: string; created_at: number }>(
    db, "SELECT version, note, created_by, created_at FROM versions WHERE document_id = ? ORDER BY version DESC", doc.id,
  );
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    filename: doc.filename,
    created_by: authorView(db, doc.created_by),
    reviewer: doc.reviewer_agent_id ? authorView(db, doc.reviewer_agent_id) : null,
    current_version: doc.current_version,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    ...(opts.includeText === false ? {} : { text: version.text }),
    versions: versions.map((v) => ({ version: v.version, note: v.note, created_by: authorView(db, v.created_by), created_at: v.created_at })),
    threads: threads.map((thread) => threadView(db, thread, version.text, doc.kind)),
  };
}

/** A thread plus surrounding text: everything an agent needs to answer it. */
export function threadDetail(db: Db, user: User, threadId: string) {
  const { thread, doc } = loadThread(db, user, threadId);
  const { text } = currentVersion(db, doc);
  return {
    document: { id: doc.id, title: doc.title, kind: doc.kind, filename: doc.filename, current_version: doc.current_version },
    context: contextAround(text, thread),
    thread: threadView(db, thread, text, doc.kind),
  };
}

/** Open threads that are waiting on this agent: the agent reviews the
 *  document or took part in the thread, and the latest comment is not its own. */
export function agentInbox(db: Db, agent: User) {
  const rows = all<ThreadRow & { last_author: string; kind: DocKind; title: string }>(
    db,
    `SELECT t.*, d.kind AS kind, d.title AS title,
       (SELECT author_id FROM (
          SELECT c.author_id, c.created_at, c.rowid AS r, 0 AS k FROM comments c WHERE c.thread_id = t.id
          UNION ALL SELECT s.author_id, s.created_at, s.rowid AS r, 1 AS k FROM suggestions s WHERE s.thread_id = t.id
        ) ORDER BY created_at DESC, k DESC, r DESC LIMIT 1) AS last_author
     FROM threads t JOIN documents d ON d.id = t.document_id JOIN users u ON u.id = d.created_by
     WHERE t.status = 'open' AND u.server_id = ?
       AND (d.reviewer_agent_id = ? OR EXISTS (SELECT 1 FROM comments c2 WHERE c2.thread_id = t.id AND c2.author_id = ?))
     ORDER BY t.updated_at`,
    agent.server_id, agent.id, agent.id,
  );
  return rows
    .filter((row) => row.last_author !== agent.id)
    .map((row) => {
      const last = get<CommentRow>(db, "SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", row.id)!;
      return {
        thread_id: row.id,
        document_id: row.document_id,
        document_title: row.title,
        quote: row.quote,
        last_comment: { author: authorView(db, last.author_id), body: last.body, created_at: last.created_at },
      };
    });
}

/** Which agent should hear about activity on a thread by `actor`. */
export function agentToNotify(db: Db, threadId: string, actor: User): string | null {
  if (actor.type !== "human") return null;
  const row = get<{ reviewer_agent_id: string | null }>(
    db, "SELECT d.reviewer_agent_id FROM threads t JOIN documents d ON d.id = t.document_id WHERE t.id = ?", threadId,
  );
  if (row?.reviewer_agent_id) return row.reviewer_agent_id;
  const participant = get<{ author_id: string }>(
    db,
    `SELECT c.author_id FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.thread_id = ? AND u.type = 'agent' ORDER BY c.created_at DESC LIMIT 1`,
    threadId,
  );
  return participant?.author_id ?? null;
}
