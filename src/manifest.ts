import type { Config } from "./config.ts";

type Param = { type: string; description: string; required?: boolean };
type Action = {
  name: string;
  description: string;
  endpoint: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string };
  parameters?: Record<string, Param>;
  returns?: Record<string, { type: string; description: string }>;
  response?: { type: "file"; description: string };
};

const docId: Param = { type: "string", description: "Document ID", required: true };
const threadId: Param = { type: "string", description: "Thread ID", required: true };

export const ACTIONS: Action[] = [
  {
    name: "list_pending",
    description: "Open review threads waiting on you (you review the document or took part, and the last comment is not yours). Start here when woken.",
    endpoint: { method: "GET", path: "/api/inbox" },
    returns: { pending: { type: "array", description: "thread_id, document_id, document_title, quote, last_comment" } },
  },
  {
    name: "list_documents",
    description: "Documents under review on this Server, with open-thread and pending-suggestion counts.",
    endpoint: { method: "GET", path: "/api/documents" },
  },
  {
    name: "get_document",
    description: "One document: current text (PDF text has pages separated by \\f), version history and every thread with comments and suggestions.",
    endpoint: { method: "GET", path: "/api/documents/{document_id}" },
    parameters: {
      document_id: docId,
      include_text: { type: "string", description: "\"false\" to omit the full text" },
    },
  },
  {
    name: "download_document",
    description: "Download the current file (original PDF bytes or the latest text).",
    endpoint: { method: "GET", path: "/api/documents/{document_id}/raw" },
    parameters: { document_id: docId },
    response: { type: "file", description: "The document file" },
  },
  {
    name: "upload_document",
    description: "Publish a text, Markdown or LaTeX draft for a human to review. You become its reviewer and are woken on every comment. Pass the body with content=@file.",
    endpoint: { method: "POST", path: "/api/documents" },
    parameters: {
      filename: { type: "string", description: "File name with a real extension (.md, .tex, .txt)", required: true },
      content: { type: "string", description: "Full document text; use content=@path", required: true },
      title: { type: "string", description: "Display title" },
    },
  },
  {
    name: "upload_version",
    description: "Replace a text document with a full new version. Open threads re-anchor by their quoted text; threads whose text vanished become orphaned. Prefer suggest_edit for targeted changes so the human can accept or reject each one.",
    endpoint: { method: "POST", path: "/api/documents/{document_id}/versions" },
    parameters: {
      document_id: docId,
      content: { type: "string", description: "Full new text; use content=@path", required: true },
      note: { type: "string", description: "What changed" },
    },
  },
  {
    name: "get_thread",
    description: "One thread: anchored quote, surrounding text, comments and suggestions. Read this before replying.",
    endpoint: { method: "GET", path: "/api/threads/{thread_id}" },
    parameters: { thread_id: threadId },
  },
  {
    name: "reply",
    description: "Reply in a thread. Long text: body=@reply.md.",
    endpoint: { method: "POST", path: "/api/threads/{thread_id}/comments" },
    parameters: { thread_id: threadId, body: { type: "string", description: "Comment text (Markdown)", required: true } },
  },
  {
    name: "suggest_edit",
    description: "Propose replacing text; the human accepts or rejects it. By default replaces the thread's whole highlighted passage; pass quote to replace only an exact substring of it. Empty replacement deletes.",
    endpoint: { method: "POST", path: "/api/threads/{thread_id}/suggestions" },
    parameters: {
      thread_id: threadId,
      replacement: { type: "string", description: "New text; use replacement=@file for multi-line", required: true },
      quote: { type: "string", description: "Exact text to replace (defaults to the thread's highlighted passage)" },
      occurrence: { type: "string", description: "Which match of quote in the document (1-based) when quote is outside the passage" },
      rationale: { type: "string", description: "Why this change" },
    },
  },
  {
    name: "create_thread",
    description: "Start a thread on an exact quote (your own review note), optionally with a suggested replacement.",
    endpoint: { method: "POST", path: "/api/documents/{document_id}/threads" },
    parameters: {
      document_id: docId,
      quote: { type: "string", description: "Exact text to anchor on", required: true },
      occurrence: { type: "string", description: "Which match (1-based) if the quote repeats" },
      body: { type: "string", description: "Comment text", required: true },
      replacement: { type: "string", description: "Optional suggested replacement for the quote" },
      rationale: { type: "string", description: "Why the replacement" },
    },
  },
  {
    name: "resolve_thread",
    description: "Mark a thread resolved once the comment is fully addressed.",
    endpoint: { method: "POST", path: "/api/threads/{thread_id}/resolve" },
    parameters: { thread_id: threadId },
  },
];

export function buildManifest(config: Config) {
  return {
    schema: "raft-agent-manifest.v0",
    service: config.serviceKey,
    name: "Raft Review",
    description:
      "Google Docs-style review of documents with agents: humans highlight passages and comment; agents reply in the thread and suggest edits that humans accept or reject. Text, Markdown, LaTeX and PDF.",
    docs_url: `${config.publicUrl}/docs/agents`,
    app_origin: config.publicUrl,
    execution: { mode: "http_api", base_url: config.publicUrl },
    auth: { type: "login_with_raft", login_url: `${config.publicUrl}/auth/login` },
    credential_boundary: { storage: "slock_managed_token" },
    actions: ACTIONS,
  };
}
