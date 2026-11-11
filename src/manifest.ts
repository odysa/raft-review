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
      replacement: { type: "string", description: "New text; use replacement=@file for multi-line. For papers this is LaTeX.", required: true },
      quote: { type: "string", description: "Exact text to replace (defaults to the thread's highlighted passage; for papers, its LaTeX source span)" },
      path: { type: "string", description: "Papers: source file to edit when it isn't the thread's own (e.g. sections/intro.tex)" },
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
      quote: { type: "string", description: "Exact text to anchor on (papers: quote the LaTeX source; it is found in the PDF too)", required: true },
      path: { type: "string", description: "Papers: limit the quote search to this source file" },
      occurrence: { type: "string", description: "Which match (1-based) if the quote repeats" },
      body: { type: "string", description: "Comment text", required: true },
      replacement: { type: "string", description: "Optional suggested replacement for the quote" },
      rationale: { type: "string", description: "Why the replacement" },
    },
  },
  {
    name: "upload_paper",
    description: "Publish a LaTeX paper for review: a zip of the project (main .tex, sections, .bib, figures). The server compiles it (or send pdf_base64 compiled by you). You become the reviewer and are woken on every comment. Make the zip with `zip -r paper.zip . -x '.git/*'` and base64 it.",
    endpoint: { method: "POST", path: "/api/papers" },
    parameters: {
      zip_base64: { type: "string", description: "Base64 of the project zip; use zip_base64=@paper.zip.b64", required: true },
      title: { type: "string", description: "Paper title" },
      filename: { type: "string", description: "e.g. paper.zip" },
      main_path: { type: "string", description: "Root .tex if not main.tex / the one with \\documentclass" },
      pdf_base64: { type: "string", description: "Optional PDF you compiled (needed when the server has no compiler)" },
      synctex_base64: { type: "string", description: "Optional .synctex.gz for precise PDF→source mapping" },
    },
  },
  {
    name: "upload_sources",
    description: "Push a new state of the paper's LaTeX project (e.g. after you committed other changes). Comments re-anchor; the PDF is recompiled.",
    endpoint: { method: "POST", path: "/api/documents/{document_id}/sources" },
    parameters: {
      document_id: docId,
      zip_base64: { type: "string", description: "Base64 of the project zip", required: true },
      note: { type: "string", description: "What changed" },
      pdf_base64: { type: "string", description: "Optional PDF you compiled" },
      synctex_base64: { type: "string", description: "Optional .synctex.gz" },
    },
  },
  {
    name: "list_files",
    description: "Files in a paper's LaTeX project (current version unless version is given).",
    endpoint: { method: "GET", path: "/api/documents/{document_id}/files" },
    parameters: { document_id: docId, version: { type: "string", description: "Version number" } },
  },
  {
    name: "get_file",
    description: "One source file of a paper, plus the review threads anchored in it with their line numbers.",
    endpoint: { method: "GET", path: "/api/documents/{document_id}/file" },
    parameters: { document_id: docId, path: { type: "string", description: "e.g. sections/method.tex", required: true }, version: { type: "string", description: "Version number" } },
  },
  {
    name: "get_patch",
    description: "Unified diff of the paper's sources between two versions (default: v1 → current). Save it with --output review.patch, then `git apply review.patch` in your repo and commit. Pass from=<last version you synced>.",
    endpoint: { method: "GET", path: "/api/documents/{document_id}/patch" },
    parameters: { document_id: docId, from: { type: "string", description: "Base version (default 1)" }, to: { type: "string", description: "Target version (default current)" } },
    response: { type: "file", description: "Unified diff (git apply)" },
  },
  {
    name: "download_sources",
    description: "Zip of the paper's LaTeX project at the current (or given) version.",
    endpoint: { method: "GET", path: "/api/documents/{document_id}/sources.zip" },
    parameters: { document_id: docId, version: { type: "string", description: "Version number" } },
    response: { type: "file", description: "Project zip" },
  },
  {
    name: "upload_pdf",
    description: "Upload the PDF you compiled for the paper's current version (when the server has no compiler, or to replace its build). Include synctex for precise mapping.",
    endpoint: { method: "POST", path: "/api/documents/{document_id}/pdf" },
    parameters: {
      document_id: docId,
      pdf_base64: { type: "string", description: "Base64 of the PDF; use pdf_base64=@main.pdf.b64", required: true },
      synctex_base64: { type: "string", description: "Base64 of main.synctex.gz (compile with -synctex=1)" },
    },
  },
  {
    name: "recompile",
    description: "Recompile the paper's current version on the server.",
    endpoint: { method: "POST", path: "/api/documents/{document_id}/compile" },
    parameters: { document_id: docId },
  },
  {
    name: "get_compile_log",
    description: "Compile status and TeX log for the paper's current (or given) version. Read this when you're told a compile failed.",
    endpoint: { method: "GET", path: "/api/documents/{document_id}/compile-log" },
    parameters: { document_id: docId, version: { type: "string", description: "Version number" } },
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
      "Google Docs-style review of documents and research papers with agents: humans comment on the PDF; agents reply and suggest LaTeX edits that humans accept; the paper recompiles and agents pull a git patch. Text, Markdown, LaTeX projects and PDF.",
    docs_url: `${config.publicUrl}/docs/agents`,
    app_origin: config.publicUrl,
    execution: { mode: "http_api", base_url: config.publicUrl },
    auth: { type: "login_with_raft", login_url: `${config.publicUrl}/auth/login` },
    credential_boundary: { storage: "slock_managed_token" },
    actions: ACTIONS,
  };
}
