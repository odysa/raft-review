#!/usr/bin/env node
// Play the reviewer agent against a local dev instance (RAFT_REVIEW_DEV_LOGIN=1).
// Mirrors the actions a real Raft agent calls with `raft integration invoke`.
//
//   node scripts/dev-agent.mjs pending
//   node scripts/dev-agent.mjs thread <thread_id>
//   node scripts/dev-agent.mjs reply <thread_id> "text"
//   node scripts/dev-agent.mjs suggest <thread_id> "replacement" ["rationale"]
//   node scripts/dev-agent.mjs patch <document_id> [from_version]
//   node scripts/dev-agent.mjs publish <folder-with-main.tex> ["title"]
//
// Env: RAFT_REVIEW_URL (default http://localhost:8787), AGENT_NAME (default Scribe).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.env.RAFT_REVIEW_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const NAME = process.env.AGENT_NAME ?? "Scribe";

async function session() {
  const res = await fetch(`${BASE}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ type: "agent", name: NAME }),
  });
  if (!res.ok) throw new Error(`dev login failed (HTTP ${res.status}); is the app running with RAFT_REVIEW_DEV_LOGIN=1 at ${BASE}?`);
  return res.headers.getSetCookie()[0].split(";")[0];
}

async function api(cookie, method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { cookie, origin: BASE, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

const [cmd, ...args] = process.argv.slice(2);
const usage = () => {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(cmd ? 1 : 0);
};

const cookie = cmd && cmd !== "help" ? await session() : usage();

switch (cmd) {
  case "pending": {
    const { pending } = await api(cookie, "GET", "/api/inbox");
    if (!pending.length) console.log("Nothing waiting on you.");
    for (const p of pending) {
      console.log(`• ${p.thread_id}  (${p.document_title})\n  “${p.quote.replace(/\s+/g, " ").slice(0, 90)}”\n  ${p.last_comment.author.name}: ${p.last_comment.body}\n`);
    }
    break;
  }
  case "thread": {
    const d = await api(cookie, "GET", `/api/threads/${args[0]}`);
    const t = d.thread;
    console.log(`Document: ${d.document.title} (v${d.document.current_version})`);
    console.log(`PDF text: “${t.anchor.quote.replace(/\s+/g, " ")}”${t.anchor.page ? ` (page ${t.anchor.page})` : ""}`);
    if (t.source) {
      console.log(`LaTeX:    ${t.source.path}:${t.source.line}\n          ${t.source.quote}`);
      if (d.source_context) console.log(`Context:  …${d.source_context.before.slice(-160)}⟦${t.source.quote}⟧${d.source_context.after.slice(0, 160)}…`);
    }
    for (const c of t.comments) console.log(`\n${c.author.name}: ${c.body}`);
    for (const s of t.suggestions) console.log(`\n[${s.status}] ${s.author.name} suggested${s.path ? ` in ${s.path}:${s.line}` : ""}:\n  - ${s.original}\n  + ${s.replacement}`);
    break;
  }
  case "reply":
    await api(cookie, "POST", `/api/threads/${args[0]}/comments`, { body: args[1] });
    console.log("Replied.");
    break;
  case "suggest": {
    const d = await api(cookie, "POST", `/api/threads/${args[0]}/suggestions`, { replacement: args[1], rationale: args[2] ?? "" });
    const s = d.thread.suggestions.at(-1);
    console.log(`Suggested${s.path ? ` an edit to ${s.path}:${s.line}` : ""}. The human accepts or rejects it in the browser.`);
    break;
  }
  case "patch": {
    const from = args[1] ?? "1";
    const res = await fetch(`${BASE}/api/documents/${args[0]}/patch?from=${from}`, { headers: { cookie } });
    process.stdout.write(await res.text());
    break;
  }
  case "publish": {
    const dir = path.resolve(args[0] ?? ".");
    const zip = path.join(os.tmpdir(), `raft-review-${Date.now()}.zip`);
    execFileSync("zip", ["-qr", zip, ".", "-x", ".git/*"], { cwd: dir });
    const d = await api(cookie, "POST", "/api/papers", {
      title: args[1] ?? path.basename(dir), filename: path.basename(dir) + ".zip",
      zip_base64: fs.readFileSync(zip).toString("base64"),
    });
    fs.rmSync(zip, { force: true });
    console.log(`Published: ${d.document_url}`);
    break;
  }
  default:
    usage();
}
