// Durable compile queue in SQLite.
//
// A version waiting for a PDF has compile_status = 'queued'. Any process with
// a compiler claims one atomically (UPDATE … RETURNING), marks it 'compiling',
// and heartbeats while it works. If a process dies mid-compile its heartbeat
// stops and another process (or the same one after a restart) reclaims the
// job once the lease expires. So jobs survive restarts and are never run twice
// concurrently, however many processes share the database.

import { randomUUID } from "node:crypto";

import type { Compiler } from "./compile.ts";
import { get, run, type Db, type User } from "./db.ts";
import { log } from "./log.ts";
import { ingestPdf, loadProject, setCompileStatus } from "./paper.ts";
import { getUser } from "./review.ts";

export interface CompileQueue {
  readonly owner: string;
  /** Queue a version (marks older queued versions of the same paper superseded). */
  enqueue(documentId: string, version: number, requestedBy: string | null): void;
  /** Look for work now instead of at the next tick. */
  kick(): void;
  /** Resolve when this process has no running jobs and nothing is queued. */
  idle(): Promise<void>;
  stop(): Promise<void>;
}

export function createCompileQueue(opts: {
  db: Db;
  compiler: Compiler;
  concurrency: number;
  /** A job whose heartbeat is older than this is reclaimed. */
  leaseMs?: number;
  pollMs?: number;
  onDone: (job: { documentId: string; version: number; ok: boolean; requestedBy: User | null }) => void;
}): CompileQueue {
  const { db, compiler } = opts;
  const owner = randomUUID();
  const leaseMs = opts.leaseMs ?? 30_000;
  const heartbeatMs = Math.max(250, Math.floor(leaseMs / 3));
  const running = new Set<Promise<void>>();
  let stopped = false;

  function claim(): { document_id: string; version: number; compile_requested_by: string | null } | null {
    const now = Date.now();
    return get(
      db,
      `UPDATE versions SET compile_status = 'compiling', compile_owner = ?, compile_heartbeat = ?
       WHERE rowid = (
         SELECT rowid FROM versions
         WHERE compile_status = 'queued' OR (compile_status = 'compiling' AND (compile_heartbeat IS NULL OR compile_heartbeat < ?))
         ORDER BY created_at LIMIT 1
       )
       RETURNING document_id, version, compile_requested_by`,
      owner, now, now - leaseMs,
    ) ?? null;
  }

  async function runJob(job: { document_id: string; version: number; compile_requested_by: string | null }): Promise<void> {
    const { document_id: documentId, version } = job;
    const beat = setInterval(() => {
      run(db, "UPDATE versions SET compile_heartbeat = ? WHERE document_id = ? AND version = ? AND compile_owner = ?", Date.now(), documentId, version, owner);
    }, heartbeatMs);
    let ok = false;
    try {
      const main = get<{ main_path: string | null }>(db, "SELECT main_path FROM documents WHERE id = ?", documentId)?.main_path;
      if (!main) {
        setCompileStatus(db, documentId, version, "failed", "the paper has no main .tex file");
        return;
      }
      const result = await compiler.compile(loadProject(db, documentId, version), main);
      log("info", "compile", { document: documentId, version, ok: result.ok, ms: result.ms, owner });
      // Another process may have reclaimed this job if we stalled; only the
      // current owner writes the result.
      const still = get(db, "SELECT 1 AS x FROM versions WHERE document_id = ? AND version = ? AND compile_owner = ?", documentId, version, owner);
      if (!still) return;
      if (result.ok && result.pdf) {
        await ingestPdf(db, documentId, version, result.pdf, result.synctex ?? null, result.log);
        ok = true;
      } else {
        setCompileStatus(db, documentId, version, "failed", result.log);
      }
    } catch (err) {
      log("error", "compile_crashed", { document: documentId, version, error: (err as Error).message });
      setCompileStatus(db, documentId, version, "failed", `Internal error while compiling: ${(err as Error).message}`);
    } finally {
      clearInterval(beat);
      run(db, "UPDATE versions SET compile_owner = NULL, compile_heartbeat = NULL WHERE document_id = ? AND version = ? AND compile_owner = ?", documentId, version, owner);
      opts.onDone({
        documentId, version, ok,
        requestedBy: job.compile_requested_by ? getUser(db, job.compile_requested_by) ?? null : null,
      });
    }
  }

  function pump(): void {
    if (stopped) return;
    while (running.size < opts.concurrency) {
      let job;
      try {
        job = claim();
      } catch (err) {
        log("warn", "compile_claim_failed", { error: (err as Error).message });
        return;
      }
      if (!job) return;
      const p = runJob(job).finally(() => {
        running.delete(p);
        pump();
      });
      running.add(p);
    }
  }

  const timer = setInterval(pump, opts.pollMs ?? 1000);
  timer.unref();
  setImmediate(pump);

  return {
    owner,
    enqueue(documentId, version, requestedBy) {
      run(
        db,
        `UPDATE versions SET compile_status = 'superseded' WHERE document_id = ? AND version < ? AND compile_status = 'queued'`,
        documentId, version,
      );
      run(
        db,
        `UPDATE versions SET compile_status = 'queued', compile_log = '', compile_owner = NULL, compile_heartbeat = NULL,
           compile_requested_by = ? WHERE document_id = ? AND version = ?`,
        requestedBy, documentId, version,
      );
      setImmediate(pump);
    },
    kick() {
      setImmediate(pump);
    },
    async idle() {
      for (;;) {
        await Promise.all([...running]);
        pump();
        const queued = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM versions WHERE compile_status IN ('queued', 'compiling')")!.n;
        if (running.size === 0 && queued === 0) return;
        if (running.size === 0) await new Promise((r) => setTimeout(r, 50));
      }
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.all([...running]);
    },
  };
}
