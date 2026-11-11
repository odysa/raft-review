import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type PrincipalType = "human" | "agent";
export type DocKind = "text" | "markdown" | "latex" | "pdf" | "paper";

export interface User {
  id: string;
  type: PrincipalType;
  name: string;
  username: string;
  avatar_url: string | null;
  server_id: string;
  server_slug: string;
}

export interface DocumentRow {
  id: string;
  title: string;
  kind: DocKind;
  filename: string;
  created_by: string;
  reviewer_agent_id: string | null;
  current_version: number;
  /** Paper projects: the root .tex file. */
  main_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  document_id: string;
  version: number;
  text: string;
  file: Uint8Array | null;
  created_by: string;
  note: string;
  created_at: number;
  synctex: Uint8Array | null;
  /** Papers: "" (n/a) | queued | compiling | ok | failed | needs_pdf */
  compile_status: string;
  compile_log: string;
  pdf_sha: string | null;
  compile_owner: string | null;
  compile_heartbeat: number | null;
  compile_requested_by: string | null;
}

export type ThreadStatus = "open" | "resolved" | "orphaned";

export interface ThreadRow {
  id: string;
  document_id: string;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  /** "" | "fuzzy" | "context": set when a new version edited the passage. */
  reanchored: string;
  /** Papers: where the PDF selection lives in the LaTeX source. */
  src_path: string | null;
  src_start: number | null;
  src_end: number | null;
  src_quote: string | null;
  src_prefix: string | null;
  src_suffix: string | null;
  src_method: string | null;
  status: ThreadStatus;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface CommentRow {
  id: string;
  thread_id: string;
  author_id: string;
  body: string;
  created_at: number;
}

export type SuggestionStatus = "pending" | "accepted" | "rejected" | "stale";

export interface SuggestionRow {
  id: string;
  thread_id: string;
  author_id: string;
  start: number;
  end: number;
  original: string;
  replacement: string;
  rationale: string;
  /** Papers: the source file this suggestion edits. */
  path: string | null;
  status: SuggestionStatus;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
}

export interface AgentEventRow {
  id: string;
  agent_id: string;
  thread_id: string | null;
  status: string;
  detail: string;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  avatar_url TEXT,
  server_id TEXT NOT NULL,
  server_slug TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  access_token TEXT,
  verified_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  reviewer_agent_id TEXT REFERENCES users(id),
  current_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  file BLOB,
  created_by TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, version)
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  start INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  quote TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  reanchored TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_document ON threads(document_id);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_thread ON comments(thread_id);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  original TEXT NOT NULL,
  replacement TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS suggestions_thread ON suggestions(thread_id);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  thread_id TEXT,
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export type Db = DatabaseSync;

/** Switch to WAL once (it persists in the file). SQLite can report the
 *  conversion as busy without waiting while another process is opening the
 *  same new database, so retry briefly. */
function enableWal(db: DatabaseSync): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
      if (mode.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (err) {
      if (attempt >= 100 || !/locked|busy/i.test((err as Error).message)) throw err;
      Atomics.wait(pause, 0, 0, 50 + Math.floor(Math.random() * 50));
    }
  }
}

export function openDb(dataDir: string): Db {
  if (dataDir === ":memory:") {
    const db = new DatabaseSync(":memory:");
    init(db);
    return db;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  // Wait (instead of failing) while another process holds the lock.
  const db = new DatabaseSync(path.join(dataDir, "raft-review.sqlite"), { timeout: 10_000 });
  db.exec("PRAGMA busy_timeout = 10000;");
  enableWal(db);
  init(db);
  return db;
}

// Columns added after the first release, before versioned migrations.
const ADDITIVE_COLUMNS: Array<[string, string]> = [
  ["sessions", "access_token TEXT"],
  ["sessions", "verified_at INTEGER NOT NULL DEFAULT 0"],
  ["threads", "prefix TEXT NOT NULL DEFAULT ''"],
  ["threads", "suffix TEXT NOT NULL DEFAULT ''"],
  ["threads", "reanchored TEXT NOT NULL DEFAULT ''"],
];

/** Versioned migrations, tracked in PRAGMA user_version. Append only. */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS blobs (
        sha256 TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_files (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES blobs(sha256),
        PRIMARY KEY (document_id, version, path)
      );
      ALTER TABLE documents ADD COLUMN main_path TEXT;
      ALTER TABLE versions ADD COLUMN synctex BLOB;
      ALTER TABLE versions ADD COLUMN compile_status TEXT NOT NULL DEFAULT '';
      ALTER TABLE versions ADD COLUMN compile_log TEXT NOT NULL DEFAULT '';
      ALTER TABLE versions ADD COLUMN pdf_sha TEXT;
      ALTER TABLE threads ADD COLUMN src_path TEXT;
      ALTER TABLE threads ADD COLUMN src_start INTEGER;
      ALTER TABLE threads ADD COLUMN src_end INTEGER;
      ALTER TABLE threads ADD COLUMN src_quote TEXT;
      ALTER TABLE threads ADD COLUMN src_prefix TEXT;
      ALTER TABLE threads ADD COLUMN src_suffix TEXT;
      ALTER TABLE threads ADD COLUMN src_method TEXT;
      ALTER TABLE suggestions ADD COLUMN path TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        event TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        at INTEGER NOT NULL
      );
      ALTER TABLE versions ADD COLUMN compile_owner TEXT;
      ALTER TABLE versions ADD COLUMN compile_heartbeat INTEGER;
      ALTER TABLE versions ADD COLUMN compile_requested_by TEXT;
      CREATE INDEX IF NOT EXISTS versions_compile ON versions(compile_status);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

function init(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 10000;");
  // Several processes may start at once on a fresh database: do all schema
  // work under one write lock and decide what to apply only after taking it.
  tx(db, () => {
    db.exec(SCHEMA);
    for (const [table, column] of ADDITIVE_COLUMNS) {
      const name = column.split(" ")[0];
      const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!existing.some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    }
    let current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (current < 1) {
      db.exec("PRAGMA user_version = 1");
      current = 1;
    }
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      current = m.version;
    }
  });
}

/** Run `fn` inside a transaction; rolls back on throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function all<T>(db: Db, sql: string, ...params: Array<string | number | null | Uint8Array>): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(db: Db, sql: string, ...params: Array<string | number | null | Uint8Array>): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Db, sql: string, ...params: Array<string | number | null | Uint8Array>): void {
  db.prepare(sql).run(...params);
}
