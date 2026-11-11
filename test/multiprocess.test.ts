// Several app instances on one SQLite database (each with its own
// connection, as separate processes would have): compiles run exactly once,
// survive a crashed worker, live updates and rate limits are shared.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { createTectonicCompiler, findTectonic, type Compiler } from "../src/compile.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/server.ts";

const tectonic = findTectonic();
const enc = new TextEncoder();
const MAIN = "\\documentclass{article}\\begin{document}\nHello from the shared queue.\n\\end{document}\n";

let dir = "";
let pdf: Uint8Array;

async function startApp(compiler: Compiler | null, extra: Partial<Config> = {}) {
  let app!: ReturnType<typeof createApp>;
  const server = http.createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  app = createApp({
    port: 0, publicUrl: base, raftApiUrl: "http://127.0.0.1:9", clientId: "", clientSecret: "", raftServerId: "",
    dataDir: dir, devLogin: true, serviceKey: "raft-review", webhookSecrets: [],
    compiler: "none", compileTimeoutMs: 60_000, compileConcurrency: 1, tectonicOnlyCached: false,
    compileLeaseMs: 400, changePollMs: 50, compilePollMs: 50, ...extra,
  }, { db: openDb(dir), compiler });
  return { base, app, close: async () => { server.close(); await app.close(1000); } };
}

function fakeCompiler(counter: { n: number }, delayMs = 150): Compiler {
  return {
    name: "fake",
    async compile() {
      counter.n++;
      await new Promise((r) => setTimeout(r, delayMs));
      return { ok: true, pdf, log: "fake", ms: delayMs };
    },
  };
}

async function login(base: string, type: "human" | "agent", name: string) {
  const res = await fetch(`${base}/auth/dev-login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ type, name }) });
  return { status: res.status, cookie: res.headers.getSetCookie()[0]?.split(";")[0] ?? "" };
}

async function call(base: string, cookie: string, method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: { cookie, origin: base, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function waitFor<T>(fn: () => Promise<T | null | false | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("several instances on one database", { skip: tectonic ? false : "tectonic not installed (builds the test PDF)" }, () => {
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-multi-"));
    const r = await createTectonicCompiler({ binary: tectonic!, timeoutMs: 60_000 }).compile([{ path: "main.tex", data: enc.encode(MAIN) }], "main.tex");
    assert.ok(r.ok, r.log);
    pdf = r.pdf!;
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("a queued compile runs exactly once across instances", async () => {
    const countA = { n: 0 };
    const countB = { n: 0 };
    const a = await startApp(fakeCompiler(countA, 400));
    const b = await startApp(fakeCompiler(countB, 400));
    try {
      const { cookie } = await login(a.base, "human", "Ada");
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await call(a.base, cookie, "POST", "/api/papers", { title: `P${i}`, files: [{ path: "main.tex", content: MAIN }] });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        ids.push(r.body.id);
      }
      for (const id of ids) {
        await waitFor(async () => (await call(b.base, cookie, "GET", `/api/documents/${id}`)).body.paper.compile.status === "ok");
      }
      assert.equal(countA.n + countB.n, 4, `each paper compiled once (A ${countA.n}, B ${countB.n})`);
      assert.ok(countB.n > 0, "the other instance picked up work too");
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("a compile abandoned by a crashed instance is reclaimed", async () => {
    const a = await startApp(null); // no compiler: just creates the paper
    const { cookie } = await login(a.base, "human", "Ada");
    const created = await call(a.base, cookie, "POST", "/api/papers", { title: "Crash", files: [{ path: "main.tex", content: MAIN }] });
    const id = created.body.id;
    await a.close();
    // What a process that died mid-compile leaves behind.
    const raw = openDb(dir);
    raw.prepare("UPDATE versions SET compile_status = 'compiling', compile_owner = 'dead-process', compile_heartbeat = ? WHERE document_id = ?")
      .run(Date.now() - 60_000, id);
    raw.close();

    const counter = { n: 0 };
    const b = await startApp(fakeCompiler(counter, 10));
    try {
      const doc = await waitFor(async () => {
        const d = (await call(b.base, cookie, "GET", `/api/documents/${id}`)).body;
        return d.paper.compile.status === "ok" ? d : null;
      });
      assert.equal(counter.n, 1);
      assert.match(doc.text, /shared queue/);
    } finally {
      await b.close();
    }
  });

  test("a live job is not stolen while its worker heartbeats", async () => {
    const slow = { n: 0 };
    const other = { n: 0 };
    const a = await startApp(fakeCompiler(slow, 1500));
    const b = await startApp(fakeCompiler(other, 10));
    try {
      const { cookie } = await login(a.base, "human", "Ada");
      const created = await call(a.base, cookie, "POST", "/api/papers", { title: "Slow", files: [{ path: "main.tex", content: MAIN }] });
      await waitFor(async () => (await call(b.base, cookie, "GET", `/api/documents/${created.body.id}`)).body.paper.compile.status === "ok");
      assert.equal(slow.n + other.n, 1, "1.5 s compile with a 0.4 s lease still ran once");
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("live updates reach viewers connected to another instance", async () => {
    const a = await startApp(null);
    const b = await startApp(null);
    try {
      const { cookie } = await login(a.base, "human", "Ada");
      const created = await call(a.base, cookie, "POST", "/api/documents", { filename: "n.md", text: "Shared live updates work." });
      const id = created.body.id;
      // Viewer on B.
      const got: string[] = [];
      const ctrl = new AbortController();
      const stream = await fetch(`${b.base}/api/documents/${id}/events`, { headers: { cookie }, signal: ctrl.signal });
      const reader = stream.body!.getReader();
      const reading = (async () => {
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) return;
          got.push(dec.decode(value));
        }
      })();
      // Comment through A.
      const t = await call(a.base, cookie, "POST", `/api/documents/${id}/threads`, { quote: "live updates", body: "Seen on B?" });
      assert.equal(t.status, 201);
      await waitFor(async () => got.join("").includes('"event":"thread"'), 5_000);
      ctrl.abort();
      await reading;
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("rate limits are shared", async () => {
    const raw = openDb(dir);
    raw.exec("DELETE FROM rate_limits"); // earlier tests in this database signed in too
    raw.close();
    const a = await startApp(null);
    const b = await startApp(null);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await login(a.base, "human", `u${i}`)).status);
      for (let i = 0; i < 8; i++) statuses.push((await login(b.base, "human", `v${i}`)).status);
      assert.ok(statuses.every((s) => s === 200), statuses.join(","));
      assert.equal((await login(a.base, "human", "one-too-many")).status, 429, "the 21st sign-in across both instances is limited");
    } finally {
      await a.close();
      await b.close();
    }
  });
});
