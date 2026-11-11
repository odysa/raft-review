import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type Config } from "./config.ts";
import { all, get, openDb, run, type Db, type User } from "./db.ts";
import { log } from "./log.ts";
import { createLimiter } from "./ratelimit.ts";
import { createCompileQueue, type CompileQueue } from "./jobs.ts";
import { SCHEMA_VERSION } from "./db.ts";
import { buildManifest } from "./manifest.ts";
import { createTectonicCompiler, findTectonic, safeProjectPath, type Compiler, type ProjectFile } from "./compile.ts";
import {
  addPaperSources,
  createPaper,
  ingestPdf,
  loadProject,
  mapPdfToSource,
  paperPatch,
  readTextFile,
  setCompileStatus,
  versionFiles,
} from "./paper.ts";
import { isTextPath, unzipProject, ZipError, zipProject } from "./zip.ts";
import { lineOf, pageOf } from "./anchor.ts";
import { createRaftNotifier, recentAgentEvents, type Notifier, type NotifyReason } from "./notify.ts";
import { newPkce, RaftClient, RaftError, type RaftUserinfo } from "./raft.ts";
import { handleWebhook, SUBSCRIBED_EVENTS, verifyWebhook, WebhookError } from "./webhooks.ts";
import {
  addComment,
  addVersion,
  agentInbox,
  agentToNotify,
  createDocument,
  createSuggestion,
  createThread,
  decideSuggestion,
  deleteDocument,
  documentView,
  getFile,
  getUser,
  listAgents,
  listDocuments,
  ReviewError,
  setReviewer,
  setThreadStatus,
  threadDetail,
  upsertUser,
} from "./review.ts";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const PDFJS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/pdfjs-dist/build");
const VERSION = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version as string;

// Strict CSP: scripts only from this origin (PDF.js is served locally), no
// eval, no framing. Inline styles are allowed for PDF.js's text layer.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
const SESSION_COOKIE = "rr_session";
const LOGIN_STATE_COOKIE = "rr_login";
// Raft access tokens last an hour and there is no refresh token, so an app
// session cannot outlive the token it re-verifies with.
const MAX_SESSION_SECONDS = 3600;
const DEV_SESSION_SECONDS = 7 * 24 * 3600;
const STATE_TTL_MS = 10 * 60 * 1000;
// A 50 MB project zip is ~67 MB as base64.
const MAX_JSON_BYTES = 80 * 1024 * 1024;

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

interface Ctx {
  req: Req;
  res: Res;
  url: URL;
  params: Record<string, string>;
  user: User | null;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

class HttpError extends Error {
  status: number;
  code: string;
  hint?: string;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(res: Res, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readJson(req: Req): Promise<Record<string, any>> {
  const type = req.headers["content-type"] ?? "";
  // Requiring JSON keeps cross-site HTML forms from reaching state-changing
  // routes (they cannot send application/json without a CORS preflight).
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "send application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "too_large", "request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "invalid_json", "body must be a JSON object");
  }
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !value) return null;
  return new Uint8Array(Buffer.from(value, "base64"));
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

export interface AppDeps {
  db?: Db;
  fetchImpl?: typeof fetch;
  notifier?: Notifier;
  /** Override the LaTeX compiler (tests); null disables compiling. */
  compiler?: Compiler | null;
}

export function createApp(config: Config, deps: AppDeps = {}) {
  const db = deps.db ?? openDb(config.dataDir);
  function raftServerHint(): string | null {
    const servers = all<{ server_id: string }>(db, "SELECT DISTINCT server_id FROM users WHERE id NOT LIKE 'dev-%'");
    return servers.length === 1 ? servers[0].server_id : null;
  }
  const raft = new RaftClient(config, deps.fetchImpl, raftServerHint);
  const notifier = deps.notifier ?? createRaftNotifier(db, config, raft);
  let compileQueue: CompileQueue | null = null;
  const compiler: Compiler | null = deps.compiler !== undefined ? deps.compiler : (() => {
    if (config.compiler === "none") return null;
    const binary = findTectonic(config.tectonicPath);
    if (!binary) {
      if (config.compiler === "tectonic") throw new Error("COMPILER=tectonic but no tectonic binary was found (set TECTONIC_PATH)");
      return null;
    }
    return createTectonicCompiler({
      binary,
      timeoutMs: config.compileTimeoutMs,
      concurrency: config.compileConcurrency,
      onlyCached: config.tectonicOnlyCached,
    });
  })();
  const instance = randomBytes(8).toString("hex");
  const secureCookies = config.publicUrl.startsWith("https://");
  const membershipTtlMs = config.membershipTtlMs ?? 60_000;
  const pendingNotifications = new Set<Promise<unknown>>();

  // ---------- live updates (SSE) ----------
  // Changes go to this process's viewers at once and, through the `changes`
  // table, to viewers connected to any other process sharing the database.
  const listeners = new Map<string, Set<Res>>();
  function deliver(documentId: string, event: string): void {
    for (const res of listeners.get(documentId) ?? []) res.write(`event: change\ndata: ${JSON.stringify({ event })}\n\n`);
  }
  function broadcast(documentId: string, event: string): void {
    deliver(documentId, event);
    run(db, "INSERT INTO changes (document_id, event, origin, created_at) VALUES (?, ?, ?, ?)", documentId, event, instance, Date.now());
  }
  let lastChange = get<{ id: number | null }>(db, "SELECT MAX(id) AS id FROM changes")?.id ?? 0;
  let lastPrune = 0;
  const changePoll = setInterval(() => {
    try {
      const rows = all<{ id: number; document_id: string; event: string; origin: string }>(
        db, "SELECT id, document_id, event, origin FROM changes WHERE id > ? ORDER BY id LIMIT 1000", lastChange,
      );
      for (const r of rows) {
        lastChange = r.id;
        if (r.origin !== instance) deliver(r.document_id, r.event);
      }
      if (Date.now() - lastPrune > 60_000) {
        lastPrune = Date.now();
        run(db, "DELETE FROM changes WHERE created_at < ?", Date.now() - 10 * 60_000);
      }
    } catch (err) {
      log("warn", "change_poll_failed", { error: (err as Error).message });
    }
  }, config.changePollMs ?? 250);
  changePoll.unref();

  // ---------- sessions ----------
  function sessionCookie(value: string, maxAge: number): string {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;
  }

  /** Session bound to the principal's Raft access token, kept server-side so
   *  identity and membership can be re-checked (Raft allows caching them for
   *  at most 60 seconds). Dev sessions have no token. */
  function startSession(user: User, accessToken: string | null, tokenSeconds: number): string {
    const seconds = accessToken ? Math.max(60, Math.min(tokenSeconds - 30, MAX_SESSION_SECONDS)) : DEV_SESSION_SECONDS;
    const token = randomBytes(32).toString("base64url");
    run(db, "INSERT INTO sessions (id_hash, user_id, expires_at, access_token, verified_at) VALUES (?, ?, ?, ?, ?)",
      sha256(token), user.id, Date.now() + seconds * 1000, accessToken, Date.now());
    run(db, "DELETE FROM sessions WHERE expires_at < ?", Date.now());
    return sessionCookie(token, seconds);
  }

  async function sessionUser(req: Req): Promise<User | null> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const idHash = sha256(token);
    const row = get<{ user_id: string; expires_at: number; access_token: string | null; verified_at: number }>(
      db, "SELECT user_id, expires_at, access_token, verified_at FROM sessions WHERE id_hash = ?", idHash,
    );
    if (!row || row.expires_at < Date.now()) return null;
    if (row.access_token && Date.now() - row.verified_at > membershipTtlMs) {
      try {
        const info = await raft.userinfo(row.access_token);
        if (info.sub !== row.user_id) throw new RaftError("principal changed", 401, null);
        userFromInfo(info);
        run(db, "UPDATE sessions SET verified_at = ? WHERE id_hash = ?", Date.now(), idHash);
      } catch (err) {
        // Revoked token, lost membership, uninstalled app → end the session.
        // Anything else (Raft unreachable) fails closed for this request only.
        if (err instanceof RaftError && err.status === 401) run(db, "DELETE FROM sessions WHERE id_hash = ?", idHash);
        return null;
      }
    }
    return getUser(db, row.user_id) ?? null;
  }

  function userFromInfo(info: RaftUserinfo): User {
    return upsertUser(db, {
      id: info.sub,
      type: info.type,
      name: info.name || info.preferred_username,
      username: info.preferred_username || info.name,
      avatar_url: info.picture ?? info.avatar_url ?? null,
      server_id: info.server_id,
      server_slug: info.server_slug,
    });
  }

  function requireUser(ctx: Ctx): User {
    if (!ctx.user) {
      throw new HttpError(401, "unauthenticated", "sign in with Raft first",
        `agents: raft integration login --service ${JSON.stringify(config.serviceKey)}`);
    }
    return ctx.user;
  }

  function requireHuman(ctx: Ctx): User {
    const user = requireUser(ctx);
    if (user.type !== "human") throw new HttpError(403, "human_only", "this action is for humans");
    return user;
  }

  // ---------- notifications ----------
  function notifyAgent(input: {
    threadId: string | null;
    documentId: string;
    actor: User;
    reason: NotifyReason;
    body?: string;
    quote?: string;
    dedupeKey: string;
    agentId?: string | null;
  }): void {
    const agentId = input.agentId ?? (input.threadId ? agentToNotify(db, input.threadId, input.actor) : null);
    if (!agentId || agentId === input.actor.id) return;
    const doc = get<{ title: string }>(db, "SELECT title FROM documents WHERE id = ?", input.documentId);
    const p = notifier.notify({
      agentId,
      actor: input.actor,
      reason: input.reason,
      documentId: input.documentId,
      documentTitle: doc?.title ?? "document",
      threadId: input.threadId,
      quote: input.quote,
      body: input.body,
      dedupeKey: input.dedupeKey,
    }).then(() => broadcast(input.documentId, "agent_notified")).catch(() => {});
    pendingNotifications.add(p);
    p.finally(() => pendingNotifications.delete(p));
  }

  if (compiler) {
    compileQueue = createCompileQueue({
      db,
      compiler,
      concurrency: config.compileConcurrency,
      leaseMs: config.compileLeaseMs,
      pollMs: config.compilePollMs,
      onDone: ({ documentId, version, ok, requestedBy }) => {
        broadcast(documentId, "compile");
        const doc = get<{ reviewer_agent_id: string | null }>(db, "SELECT reviewer_agent_id FROM documents WHERE id = ?", documentId);
        if (!ok && requestedBy && doc?.reviewer_agent_id) {
          notifyAgent({ threadId: null, documentId, actor: requestedBy, reason: "compile_failed", agentId: doc.reviewer_agent_id, dedupeKey: `compile:${documentId}:${version}` });
        }
      },
    });
  }

  const docUrl = (id: string) => `${config.publicUrl}/#/doc/${id}`;

  // ---------- App Notifications ----------
  let subscribed: Promise<void> | null = null;
  function ensureSubscribed(): void {
    if (subscribed || config.webhookSecrets.length === 0 || !config.clientSecret) return;
    const serverId = config.raftServerId || raftServerHint();
    if (!serverId) return; // retried after the first human sign-in
    subscribed = raft.subscribe(serverId, SUBSCRIBED_EVENTS).then((r) => {
      log(r.ok ? "info" : "warn", "app_notifications_subscribe", { ok: r.ok, detail: r.detail });
      if (!r.ok) subscribed = null;
    }, (err) => {
      log("warn", "app_notifications_subscribe", { ok: false, detail: (err as Error).message });
      subscribed = null;
    });
  }
  ensureSubscribed();

  async function readRaw(req: Req): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) throw new HttpError(413, "too_large", "webhook body is too large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  // ---------- routes ----------
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];
  function route(method: string, pathPattern: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(`^${pathPattern.replace(/:([a-z_]+)/g, (_m, key) => {
      keys.push(key);
      return "([^/]+)";
    })}$`);
    routes.push({ method, pattern, keys, handler });
  }

  route("GET", "/.well-known/raft-agent-manifest.json", ({ res }) => {
    json(res, 200, buildManifest(config));
  });

  route("GET", "/healthz", ({ res }) => {
    try {
      get(db, "SELECT 1 AS ok");
      json(res, 200, { ok: true, version: VERSION, schema: SCHEMA_VERSION, compiler: compiler?.name ?? "none" });
    } catch (err) {
      json(res, 503, { ok: false, error: (err as Error).message });
    }
  });

  // PDF.js, served from this origin so the CSP needs no CDN.
  route("GET", "/vendor/pdfjs/:file", ({ res, params }) => {
    if (params.file !== "pdf.min.mjs" && params.file !== "pdf.worker.min.mjs") return json(res, 404, { error: "not_found" });
    const file = path.join(PDFJS_DIR, params.file);
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=604800, immutable", "x-content-type-options": "nosniff" });
    fs.createReadStream(file).pipe(res);
  });

  // Human sign-in: PKCE + state, then Raft's consent screen.
  route("GET", "/auth/login", ({ res, url }) => {
    if (config.devLogin && !config.clientId) {
      res.writeHead(302, { location: "/#/dev-login" });
      res.end();
      return;
    }
    const state = randomBytes(24).toString("base64url");
    const { verifier, challenge } = newPkce();
    const returnTo = url.searchParams.get("return_to") ?? "/";
    run(db, "DELETE FROM oauth_states WHERE created_at < ?", Date.now() - STATE_TTL_MS);
    run(db, "INSERT INTO oauth_states (state, verifier, return_to, created_at) VALUES (?, ?, ?, ?)",
      state, verifier, returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/", Date.now());
    // Bind the pending login to this browser so a callback URL cannot be
    // replayed into someone else's browser (login CSRF).
    res.writeHead(302, {
      location: raft.authorizeUrl(state, challenge),
      "cache-control": "no-store",
      "set-cookie": `${LOGIN_STATE_COOKIE}=${state}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_MS / 1000}${secureCookies ? "; Secure" : ""}`,
    });
    res.end();
  });

  // One callback for both swimlanes. A browser arrives with code+state;
  // `raft integration login` arrives with only ?code=<request id> and needs
  // a Set-Cookie session that covers every action path (Path=/).
  route("GET", "/auth/callback", async ({ req, res, url }) => {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) throw new HttpError(400, "authorization_denied", `Raft returned ${error}`);
    if (!code) throw new HttpError(400, "missing_code", "callback needs ?code");

    if (state) {
      const row = get<{ verifier: string; return_to: string; created_at: number }>(
        db, "SELECT verifier, return_to, created_at FROM oauth_states WHERE state = ?", state,
      );
      run(db, "DELETE FROM oauth_states WHERE state = ?", state);
      const browserState = parseCookies(req.headers.cookie)[LOGIN_STATE_COOKIE];
      if (!row || row.created_at < Date.now() - STATE_TTL_MS || browserState !== state) {
        throw new HttpError(400, "invalid_state", "sign-in expired or was started in another browser; start again", "/auth/login");
      }
      const token = await raft.exchangeHumanCode(code, row.verifier);
      const info = await raft.userinfo(token.access_token);
      if (info.type !== "human") throw new HttpError(400, "unexpected_principal", "browser sign-in must be a human");
      const user = userFromInfo(info);
      ensureSubscribed();
      res.writeHead(302, {
        location: row.return_to,
        "set-cookie": [
          startSession(user, token.access_token, token.expires_in),
          `${LOGIN_STATE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies ? "; Secure" : ""}`,
        ],
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    const token = await raft.exchangeAgentCode(code);
    const info = await raft.userinfo(token.access_token);
    if (info.type !== "agent") {
      throw new HttpError(400, "unexpected_principal", "a callback without state is reserved for Agent Login");
    }
    const user = userFromInfo(info);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": startSession(user, token.access_token, token.expires_in),
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, principal: { id: user.id, type: user.type, name: user.name } }));
  });

  route("POST", "/auth/logout", ({ req, res }) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) run(db, "DELETE FROM sessions WHERE id_hash = ?", sha256(token));
    res.writeHead(204, { "set-cookie": sessionCookie("", 0) });
    res.end();
  });

  // Local development only: impersonate a human or agent without Raft.
  route("POST", "/auth/dev-login", async ({ req, res }) => {
    if (!config.devLogin) throw new HttpError(404, "not_found", "not found");
    const body = await readJson(req);
    const type = body.type === "agent" ? "agent" : "human";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : type === "agent" ? "Reviewer Bot" : "Dev Human";
    const user = upsertUser(db, {
      id: `dev-${type}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      type, name, username: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      avatar_url: null, server_id: "dev-server", server_slug: "dev",
    });
    res.writeHead(200, { "content-type": "application/json", "set-cookie": startSession(user, null, 0) });
    res.end(JSON.stringify({ ok: true, user }));
  });

  route("GET", "/api/me", (ctx) => {
    json(ctx.res, 200, {
      user: ctx.user,
      server_id: ctx.user?.server_id ?? null,
      dev_login: config.devLogin,
      service_key: config.serviceKey,
    });
  });

  route("GET", "/api/agents", (ctx) => {
    const user = requireUser(ctx);
    json(ctx.res, 200, { agents: listAgents(db, user.server_id) });
  });

  route("GET", "/api/documents", (ctx) => {
    const user = requireUser(ctx);
    json(ctx.res, 200, { documents: listDocuments(db, user) });
  });

  route("POST", "/api/documents", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const doc = createDocument(db, user, {
      title: body.title,
      filename: body.filename,
      text: body.text ?? body.content,
      file: decodeBase64(body.file_base64),
      reviewerAgentId: body.reviewer_agent_id,
    });
    if (doc.reviewer_agent_id && user.type === "human") {
      notifyAgent({ threadId: null, documentId: doc.id, actor: user, reason: "review_requested", agentId: doc.reviewer_agent_id, dedupeKey: `review:${doc.id}:${doc.reviewer_agent_id}` });
    }
    json(ctx.res, 201, { ...documentView(db, user, doc.id, { includeText: false }), document_url: docUrl(doc.id) });
  });

  route("GET", "/api/documents/:document_id", (ctx) => {
    const user = requireUser(ctx);
    const view = documentView(db, user, ctx.params.document_id, { includeText: ctx.url.searchParams.get("include_text") !== "false" });
    json(ctx.res, 200, { ...view, document_url: docUrl(view.id) });
  });

  route("PATCH", "/api/documents/:document_id", async (ctx) => {
    const user = requireHuman(ctx);
    const body = await readJson(ctx.req);
    const before = get<{ reviewer_agent_id: string | null }>(db, "SELECT reviewer_agent_id FROM documents WHERE id = ?", ctx.params.document_id);
    const doc = setReviewer(db, user, ctx.params.document_id, body.reviewer_agent_id ?? null);
    if (doc.reviewer_agent_id && doc.reviewer_agent_id !== before?.reviewer_agent_id) {
      notifyAgent({ threadId: null, documentId: doc.id, actor: user, reason: "review_requested", agentId: doc.reviewer_agent_id, dedupeKey: `review:${doc.id}:${doc.reviewer_agent_id}:${Date.now()}` });
    }
    broadcast(doc.id, "reviewer");
    json(ctx.res, 200, documentView(db, user, doc.id, { includeText: false }));
  });

  route("DELETE", "/api/documents/:document_id", (ctx) => {
    const user = requireUser(ctx);
    deleteDocument(db, user, ctx.params.document_id);
    json(ctx.res, 200, { ok: true });
  });

  route("GET", "/api/documents/:document_id/raw", (ctx) => {
    const user = requireUser(ctx);
    const v = ctx.url.searchParams.get("version");
    const { doc, version } = getFile(db, user, ctx.params.document_id, v ? Number(v) : undefined);
    const filename = encodeURIComponent(doc.filename);
    if (version.file) {
      ctx.res.writeHead(200, {
        "content-type": doc.kind === "pdf" ? "application/pdf" : "application/octet-stream",
        "content-disposition": `inline; filename*=UTF-8''${filename}`,
        "cache-control": "private, max-age=60",
        "x-content-type-options": "nosniff",
      });
      ctx.res.end(Buffer.from(version.file));
      return;
    }
    const type = doc.kind === "markdown" ? "text/markdown" : doc.kind === "latex" ? "application/x-tex" : "text/plain";
    ctx.res.writeHead(200, {
      "content-type": `${type}; charset=utf-8`,
      "content-disposition": `attachment; filename*=UTF-8''${filename}`,
      "x-content-type-options": "nosniff",
    });
    ctx.res.end(version.text);
  });

  route("POST", "/api/documents/:document_id/versions", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const doc = addVersion(db, user, ctx.params.document_id, {
      text: body.text ?? body.content,
      file: decodeBase64(body.file_base64),
      note: body.note,
    });
    broadcast(doc.id, "version");
    json(ctx.res, 201, documentView(db, user, doc.id, { includeText: false }));
  });

  route("POST", "/api/documents/:document_id/threads", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const thread = createThread(db, user, ctx.params.document_id, body);
    broadcast(thread.document_id, "thread");
    notifyAgent({ threadId: thread.id, documentId: thread.document_id, actor: user, reason: "new_thread", body: body.body, quote: thread.quote, dedupeKey: `thread:${thread.id}` });
    json(ctx.res, 201, threadDetail(db, user, thread.id));
  });

  route("GET", "/api/threads/:thread_id", (ctx) => {
    const user = requireUser(ctx);
    const detail = threadDetail(db, user, ctx.params.thread_id);
    json(ctx.res, 200, { ...detail, agent_notifications: user.type === "human" ? recentAgentEvents(db, ctx.params.thread_id) : undefined });
  });

  route("POST", "/api/threads/:thread_id/comments", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const comment = addComment(db, user, ctx.params.thread_id, body.body);
    const detail = threadDetail(db, user, ctx.params.thread_id);
    broadcast(detail.document.id, "comment");
    notifyAgent({ threadId: comment.thread_id, documentId: detail.document.id, actor: user, reason: "comment", body: comment.body, quote: detail.thread.anchor.quote, dedupeKey: `comment:${comment.id}` });
    json(ctx.res, 201, detail);
  });

  route("POST", "/api/threads/:thread_id/suggestions", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    createSuggestion(db, user, ctx.params.thread_id, body);
    const detail = threadDetail(db, user, ctx.params.thread_id);
    broadcast(detail.document.id, "suggestion");
    json(ctx.res, 201, detail);
  });

  for (const [action, status] of [["resolve", "resolved"], ["reopen", "open"]] as const) {
    route("POST", `/api/threads/:thread_id/${action}`, (ctx) => {
      const user = requireUser(ctx);
      const thread = setThreadStatus(db, user, ctx.params.thread_id, status);
      broadcast(thread.document_id, action);
      json(ctx.res, 200, threadDetail(db, user, thread.id));
    });
  }

  for (const decision of ["accept", "reject"] as const) {
    route("POST", `/api/suggestions/:suggestion_id/${decision}`, (ctx) => {
      const user = requireHuman(ctx);
      const { suggestion, document, compileVersion } = decideSuggestion(db, user, ctx.params.suggestion_id, decision, { compilerAvailable: Boolean(compiler) });
      broadcast(document.id, decision);
      const author = getUser(db, suggestion.author_id);
      if (compileVersion) schedulePdf(document.id, compileVersion, user);
      if (author?.type === "agent" && !(compileVersion && !compiler)) {
        notifyAgent({
          threadId: suggestion.thread_id, documentId: document.id, actor: user,
          reason: decision === "accept" ? "suggestion_accepted" : "suggestion_rejected",
          quote: suggestion.original, agentId: author.id, dedupeKey: `decision:${suggestion.id}`,
        });
      }
      json(ctx.res, 200, { suggestion: { id: suggestion.id, status: suggestion.status }, document: documentView(db, user, document.id) });
    });
  }

  // ---------- papers (LaTeX projects) ----------

  /** Queue a compile (or ask the agent for a PDF when there's no compiler). */
  function schedulePdf(documentId: string, version: number, actor: User | null): void {
    if (!compileQueue) {
      setCompileStatus(db, documentId, version, "needs_pdf");
      broadcast(documentId, "compile");
      const doc = get<{ reviewer_agent_id: string | null }>(db, "SELECT reviewer_agent_id FROM documents WHERE id = ?", documentId);
      if (actor && doc?.reviewer_agent_id) {
        notifyAgent({ threadId: null, documentId, actor, reason: "pdf_needed", agentId: doc.reviewer_agent_id, dedupeKey: `pdf:${documentId}:${version}` });
      }
      return;
    }
    compileQueue.enqueue(documentId, version, actor?.id ?? null);
    broadcast(documentId, "compile");
  }

  /** Project files from a request: a zip (base64) or explicit files. */
  function projectFromBody(body: Record<string, any>): ProjectFile[] {
    if (typeof body.zip_base64 === "string" && body.zip_base64) {
      try {
        return unzipProject(new Uint8Array(Buffer.from(body.zip_base64, "base64")));
      } catch (err) {
        throw new HttpError(400, "bad_zip", (err as Error).message);
      }
    }
    const files = typeof body.files === "string" ? (() => { try { return JSON.parse(body.files); } catch { return null; } })() : body.files;
    if (!Array.isArray(files) || files.length === 0) {
      throw new HttpError(400, "invalid_request", "send zip_base64 (a .zip of the LaTeX project) or files: [{path, content}]");
    }
    return files.map((f: any) => {
      const p = typeof f?.path === "string" ? safeProjectPath(f.path) : null;
      if (!p) throw new HttpError(400, "bad_path", `invalid file path ${JSON.stringify(f?.path)}`);
      if (typeof f.content === "string") return { path: p, data: new TextEncoder().encode(f.content) };
      if (typeof f.content_base64 === "string") return { path: p, data: new Uint8Array(Buffer.from(f.content_base64, "base64")) };
      throw new HttpError(400, "invalid_request", `file ${p} needs content or content_base64`);
    });
  }

  function requirePaper(user: User, documentId: string) {
    const view = documentView(db, user, documentId, { includeText: false });
    if (view.kind !== "paper") throw new HttpError(400, "not_a_paper", "this document is not a LaTeX project");
    return view;
  }

  async function pdfFromBody(body: Record<string, any>, documentId: string, version: number): Promise<boolean> {
    if (typeof body.pdf_base64 !== "string" || !body.pdf_base64) return false;
    const pdf = new Uint8Array(Buffer.from(body.pdf_base64, "base64"));
    const synctex = typeof body.synctex_base64 === "string" && body.synctex_base64 ? new Uint8Array(Buffer.from(body.synctex_base64, "base64")) : null;
    await ingestPdf(db, documentId, version, pdf, synctex, "PDF uploaded by the agent");
    return true;
  }

  route("POST", "/api/papers", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const files = projectFromBody(body);
    const hasPdf = typeof body.pdf_base64 === "string" && body.pdf_base64.length > 0;
    const doc = createPaper(db, user, {
      title: body.title, filename: body.filename, files, mainPath: body.main_path,
      reviewerAgentId: body.reviewer_agent_id, hasPdf, compilerAvailable: Boolean(compiler),
    });
    if (hasPdf) {
      try {
        await pdfFromBody(body, doc.id, 1);
      } catch (err) {
        setCompileStatus(db, doc.id, 1, "failed", (err as Error).message);
      }
    } else {
      schedulePdf(doc.id, 1, user);
    }
    if (doc.reviewer_agent_id && user.type === "human") {
      notifyAgent({ threadId: null, documentId: doc.id, actor: user, reason: "review_requested", agentId: doc.reviewer_agent_id, dedupeKey: `review:${doc.id}:${doc.reviewer_agent_id}` });
    }
    json(ctx.res, 201, { ...documentView(db, user, doc.id, { includeText: false }), document_url: docUrl(doc.id) });
  });

  route("POST", "/api/documents/:document_id/sources", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    requirePaper(user, ctx.params.document_id);
    const files = projectFromBody(body);
    const hasPdf = typeof body.pdf_base64 === "string" && body.pdf_base64.length > 0;
    const { doc, version } = addPaperSources(db, user, ctx.params.document_id, {
      files, mainPath: body.main_path, note: body.note, hasPdf, compilerAvailable: Boolean(compiler),
    });
    if (hasPdf) await pdfFromBody(body, doc.id, version);
    else schedulePdf(doc.id, version, user.type === "human" ? user : null);
    broadcast(doc.id, "version");
    json(ctx.res, 201, { ...documentView(db, user, doc.id, { includeText: false }), document_url: docUrl(doc.id) });
  });

  route("POST", "/api/documents/:document_id/pdf", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const view = requirePaper(user, ctx.params.document_id);
    const version = Number(body.version ?? view.current_version);
    if (version !== view.current_version) throw new HttpError(409, "stale_version", `the current version is v${view.current_version}; compile that one`);
    if (!(await pdfFromBody(body, view.id, version))) throw new HttpError(400, "invalid_request", "pdf_base64 is required");
    broadcast(view.id, "compile");
    json(ctx.res, 200, documentView(db, user, view.id, { includeText: false }));
  });

  route("POST", "/api/documents/:document_id/compile", (ctx) => {
    const user = requireUser(ctx);
    const view = requirePaper(user, ctx.params.document_id);
    if (!compiler) throw new HttpError(409, "no_compiler", "this server has no LaTeX compiler; the agent uploads PDFs with upload_pdf");
    schedulePdf(view.id, view.current_version, user);
    json(ctx.res, 202, { status: "compiling", version: view.current_version });
  });

  route("GET", "/api/documents/:document_id/compile-log", (ctx) => {
    const user = requireUser(ctx);
    const view = requirePaper(user, ctx.params.document_id);
    const version = Number(ctx.url.searchParams.get("version") ?? view.current_version);
    const row = get<{ compile_status: string; compile_log: string }>(db, "SELECT compile_status, compile_log FROM versions WHERE document_id = ? AND version = ?", view.id, version);
    if (!row) throw new HttpError(404, "not_found", "version not found");
    json(ctx.res, 200, { version, status: row.compile_status, log: row.compile_log });
  });

  route("GET", "/api/documents/:document_id/files", (ctx) => {
    const user = requireUser(ctx);
    const view = requirePaper(user, ctx.params.document_id);
    const version = Number(ctx.url.searchParams.get("version") ?? view.current_version);
    json(ctx.res, 200, {
      version,
      main_path: view.paper?.main_path,
      files: versionFiles(db, view.id, version).map((f) => ({ path: f.path, size: f.size, text: isTextPath(f.path) })),
    });
  });

  route("GET", "/api/documents/:document_id/file", (ctx) => {
    const user = requireUser(ctx);
    const view = requirePaper(user, ctx.params.document_id);
    const version = Number(ctx.url.searchParams.get("version") ?? view.current_version);
    const p = ctx.url.searchParams.get("path") ?? "";
    const content = readTextFile(db, view.id, version, p);
    if (content === null || !isTextPath(p)) throw new HttpError(404, "file_not_found", `no text file ${p} in v${version}`);
    const threads = view.threads.filter((t) => t.source?.path === p).map((t) => ({ thread_id: t.id, line: t.source?.line, quote: t.source?.quote, status: t.status }));
    json(ctx.res, 200, { path: p, version, content, threads });
  });

  route("GET", "/api/documents/:document_id/patch", (ctx) => {
    const user = requireUser(ctx);
    const view = requirePaper(user, ctx.params.document_id);
    const to = Number(ctx.url.searchParams.get("to") ?? view.current_version);
    const from = Number(ctx.url.searchParams.get("from") ?? ctx.url.searchParams.get("since_version") ?? 1);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > view.current_version || from > to) {
      throw new HttpError(400, "invalid_range", `versions must satisfy 1 <= from <= to <= ${view.current_version}`);
    }
    const patch = paperPatch(db, view.id, from, to);
    ctx.res.writeHead(200, {
      "content-type": "text/x-diff; charset=utf-8",
      "content-disposition": `inline; filename="${view.id}-v${from}-v${to}.patch"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    ctx.res.end(patch || `# no source changes between v${from} and v${to}\n`);
  });

  route("GET", "/api/documents/:document_id/sources.zip", (ctx) => {
    const user = requireUser(ctx);
    const view = requirePaper(user, ctx.params.document_id);
    const version = Number(ctx.url.searchParams.get("version") ?? view.current_version);
    const zip = zipProject(loadProject(db, view.id, version));
    const name = `${view.title.replace(/[^\w.-]+/g, "-").slice(0, 60) || "paper"}-v${version}.zip`;
    ctx.res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${name}"`,
      "x-content-type-options": "nosniff",
    });
    ctx.res.end(Buffer.from(zip));
  });

  /** Preview where a PDF selection lands in the LaTeX, for the comment box. */
  route("POST", "/api/documents/:document_id/map", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    requirePaper(user, ctx.params.document_id);
    const doc = get<import("./db.ts").DocumentRow>(db, "SELECT * FROM documents WHERE id = ?", ctx.params.document_id)!;
    const version = get<import("./db.ts").VersionRow>(db, "SELECT * FROM versions WHERE document_id = ? AND version = ?", doc.id, doc.current_version)!;
    const start = Number(body.start);
    const end = Number(body.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || end > version.text.length) {
      throw new HttpError(400, "invalid_anchor", "start/end must select text in the current PDF");
    }
    const src = mapPdfToSource(db, doc, version, {
      quote: version.text.slice(start, end), span: { start, end }, page: pageOf(version.text, start),
      x: typeof body.x === "number" ? body.x : undefined, y: typeof body.y === "number" ? body.y : undefined,
    });
    if (!src) return json(ctx.res, 200, { source: null });
    const content = readTextFile(db, doc.id, version.version, src.path)!;
    json(ctx.res, 200, { source: { path: src.path, line: lineOf(content, src.start), quote: src.quote, method: src.method } });
  });

  route("GET", "/api/inbox", (ctx) => {
    const user = requireUser(ctx);
    if (user.type !== "agent") throw new HttpError(403, "agent_only", "the inbox lists threads waiting on an agent");
    json(ctx.res, 200, { pending: agentInbox(db, user) });
  });

  route("GET", "/api/documents/:document_id/events", (ctx) => {
    const user = requireUser(ctx);
    documentView(db, user, ctx.params.document_id, { includeText: false }); // access check
    const id = ctx.params.document_id;
    ctx.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    ctx.res.write(": connected\n\n");
    const set = listeners.get(id) ?? new Set<Res>();
    set.add(ctx.res);
    listeners.set(id, set);
    const ping = setInterval(() => ctx.res.write(": ping\n\n"), 25_000);
    ctx.req.on("close", () => {
      clearInterval(ping);
      set.delete(ctx.res);
      if (set.size === 0) listeners.delete(id);
    });
  });

  // Signed Raft-to-App webhook (App Notifications). Authenticated by HMAC,
  // not by session; Raft sends no Origin header.
  route("POST", "/webhooks/raft", async ({ req, res }) => {
    const body = await readRaw(req);
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    try {
      verifyWebhook({ secrets: config.webhookSecrets, body, timestamp: header("x-raft-timestamp"), signature: header("x-raft-signature") });
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new WebhookError(400, "bad_json", "body must be JSON");
      }
      json(res, 200, handleWebhook(db, header("x-raft-delivery"), payload));
    } catch (err) {
      if (err instanceof WebhookError) {
        json(res, err.status, { error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  route("GET", "/docs/agents", ({ res }) => {
    sendFile(res, path.join(PUBLIC_DIR, "agents.md"));
  });

  function sendFile(res: Res, filePath: string): void {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      json(res, 404, { error: "not_found" });
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(resolved).pipe(res);
  }

  const authLimiter = createLimiter(db, { name: "auth", capacity: 20, perMinute: 20 });
  const writeLimiter = createLimiter(db, { name: "write", capacity: 120, perMinute: 120 });
  const heavyLimiter = createLimiter(db, { name: "heavy", capacity: 10, perMinute: 6 });
  function clientKey(req: Req): string {
    const fwd = config.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return fwd || req.socket.remoteAddress || "unknown";
  }
  function limit(req: Req, pathname: string): void {
    if (req.method === "GET" || req.method === "HEAD" || pathname === "/webhooks/raft") return;
    const key = clientKey(req);
    const check = (limiter: ReturnType<typeof createLimiter>, _bucket: string) => {
      if (!limiter.take(key)) {
        throw new HttpError(429, "rate_limited", `too many requests; retry in ${limiter.retryAfterSeconds(key)} s`);
      }
    };
    if (pathname.startsWith("/auth/")) check(authLimiter, "auth");
    else check(writeLimiter, "write");
    if (pathname === "/api/papers" || /\/(sources|compile|pdf)$/.test(pathname)) check(heavyLimiter, "heavy");
  }

  async function handle(req: Req, res: Res): Promise<void> {
    const url = new URL(req.url ?? "/", config.publicUrl);
    const started = Date.now();
    res.setHeader("content-security-policy", CSP);
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cross-origin-opener-policy", "same-origin");
    if (secureCookies) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (url.pathname !== "/healthz" && !url.pathname.endsWith("/events")) {
      res.on("finish", () => log("info", "request", { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started }));
    }
    try {
      limit(req, url.pathname);
      // Reject cross-origin state changes outright (defense in depth on top
      // of SameSite=Lax and the JSON-only body rule).
      const origin = req.headers.origin;
      if (req.method !== "GET" && req.method !== "HEAD" && origin && origin !== new URL(config.publicUrl).origin) {
        throw new HttpError(403, "cross_origin", "cross-origin request refused");
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
        await r.handler({ req, res, url, params, user: await sessionUser(req) });
        return;
      }
      if (req.method === "GET") {
        const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (url.pathname.startsWith("/static/") || url.pathname === "/") {
          sendFile(res, path.join(PUBLIC_DIR, rel.replace(/^static\//, "")));
          return;
        }
      }
      json(res, 404, { error: "not_found" });
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        json(res, err.status, { error: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) });
      } else if (err instanceof ReviewError) {
        json(res, err.status, { error: err.code, message: err.message });
      } else if (err instanceof RaftError) {
        // Surface Raft's own reason: the CLI prints `Service response: <code> — <hint>`.
        const upstream = (err.body as any)?.error ?? `HTTP ${err.status}`;
        if (err.status === 400 && /Server ID/.test(err.message)) {
          json(res, 409, { error: "server_id_unknown", hint: err.message });
          return;
        }
        json(res, 502, { error: "raft_exchange_failed", hint: `${err.message}: ${String(upstream).slice(0, 200)}` });
      } else {
        log("error", "unhandled", { method: req.method, path: url.pathname, error: (err as Error)?.stack ?? String(err) });
        json(res, 500, { error: "internal_error" });
      }
    }
  }

  return {
    db,
    handle,
    compilerName: compiler?.name ?? "none",
    /** Graceful shutdown: end live streams, let running compiles finish. */
    async close(timeoutMs = 30_000): Promise<void> {
      clearInterval(changePoll);
      for (const set of listeners.values()) for (const r of set) r.end();
      listeners.clear();
      await Promise.race([
        Promise.all([compileQueue?.stop(), ...pendingNotifications]),
        new Promise((r) => setTimeout(r, timeoutMs)),
      ]);
      db.close();
    },
    /** Test hook: wait for fire-and-forget agent notifications. */
    async settle(): Promise<void> {
      await compileQueue?.idle();
      await Promise.all([...pendingNotifications]);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = createApp(config);
  const server = http.createServer((req, res) => void app.handle(req, res));
  server.requestTimeout = 5 * 60_000; // large uploads
  server.headersTimeout = 60_000;
  server.listen(config.port, () => {
    log("info", "listening", {
      version: VERSION, public_url: config.publicUrl, port: config.port, compiler: app.compilerName,
      dev_login: config.devLogin, webhooks: config.webhookSecrets.length > 0, data_dir: config.dataDir,
    });
    if (!config.devLogin && !config.publicUrl.startsWith("https://")) {
      log("warn", "insecure_public_url", { hint: "PUBLIC_URL should be https in production; cookies are not marked Secure" });
    }
  });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "shutting_down", { signal });
    server.close();
    server.closeIdleConnections();
    app.close().then(() => process.exit(0), () => process.exit(1));
    setTimeout(() => process.exit(1), 40_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
