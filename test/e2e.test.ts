// End to end against a mock Raft API that enforces the contracts this App
// relies on (see raft-source packages/server/src/routes/oauth.ts):
//   - token exchange needs client credentials; agent_request with a
//     resource-bound scope needs the agent-inbound resource
//   - human authorization_code needs the PKCE verifier
//   - agent events need a resource-bound agent token
// The "agent" side replays what `raft integration login` / `invoke` do:
// GET <return_url>?code=<request id> with redirect: manual, keep Set-Cookie,
// send the cookie on manifest action calls.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/server.ts";

const CLIENT_ID = "raft-review-test";
const CLIENT_SECRET = "s3cret";
const SERVER_ID = "srv-1";
const RESOURCE = `urn:raft:server:${SERVER_ID}:agent-inbound`;

const events: any[] = [];
let lastChallenge = "";

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

const identities: Record<string, any> = {
  "tok-human": { sub: "human-1", type: "human", name: "Ada", preferred_username: "ada", server_id: SERVER_ID, server_slug: "acme" },
  "tok-agent": { sub: "agent-1", type: "agent", name: "Scribe", preferred_username: "scribe", server_id: SERVER_ID, server_slug: "acme" },
};

const mockRaft = http.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://raft");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const basicOk = req.headers.authorization === `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
  const body = req.method === "POST" ? await readBody(req) : {};

  if (url.pathname === "/api/oauth/token") {
    if (!basicOk) return send(401, { error: "Invalid client credentials" });
    if (body.grant_type === "authorization_code" && body.code === "human-code") {
      const challenge = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
      if (challenge !== lastChallenge) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: "tok-human", token_type: "Bearer", expires_in: 3600 });
    }
    if (body.grant_type === "urn:slock:grant-type:agent_request" && (body.request_id === "login-req" || body.request_id === "event-req")) {
      if (!body.resource) return send(400, { error: "resource is required for requested scopes" });
      if (body.resource !== RESOURCE) return send(400, { error: "resource does not match requested server" });
      return send(200, { access_token: body.request_id === "login-req" ? "tok-agent" : "tok-event", expires_in: 3600, resource: RESOURCE });
    }
    return send(400, { error: "invalid_grant" });
  }
  if (url.pathname === "/api/oauth/userinfo") {
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    const identity = identities[token];
    return identity ? send(200, identity) : send(401, { error: "Invalid or expired access token" });
  }
  if (url.pathname === "/api/oauth/requests/agent") {
    if (!basicOk) return send(401, { error: "Invalid client credentials" });
    assert.deepEqual(body.scopes, ["openid", "profile", "agent:event:write"]);
    return send(200, { requestId: "event-req", status: body.agentId === "agent-1" ? "approved" : "pending" });
  }
  if (url.pathname === "/api/oauth/agent-events") {
    if (req.headers.authorization !== "Bearer tok-event") return send(403, { error: "resource-bound token required" });
    assert.equal(body.kind, "event");
    assert.ok(body.summary.length <= 500);
    assert.ok(Buffer.byteLength(JSON.stringify(body.payload)) <= 32 * 1024);
    events.push(body);
    return send(202, { id: `evt-${events.length}`, status: "queued" });
  }
  if (url.pathname === "/api/oauth/authorize") return send(200, {});
  send(404, { error: "not_found" });
});

let appServer: http.Server;
let app: ReturnType<typeof createApp>;
let base = "";

before(async () => {
  await new Promise<void>((r) => mockRaft.listen(0, "127.0.0.1", r));
  const raftUrl = `http://127.0.0.1:${(mockRaft.address() as AddressInfo).port}`;
  appServer = http.createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  const config: Config = {
    port: 0, publicUrl: base, raftApiUrl: raftUrl, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    raftServerId: SERVER_ID, dataDir: ":memory:", devLogin: false, serviceKey: CLIENT_ID,
  };
  app = createApp(config, { db: openDb(":memory:") });
});

after(() => {
  appServer.close();
  mockRaft.close();
});

function cookieFrom(res: Response): string {
  const set = res.headers.getSetCookie();
  assert.ok(set.length > 0, "callback must set a session cookie");
  assert.match(set[0], /Path=\//, "cookie must cover every action path");
  return set[0].split(";")[0];
}

async function call(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("agent login handoff, human login, comment → event → agent suggestion → accept", async () => {
  // Agent: what `raft integration login` does.
  const agentRes = await fetch(`${base}/auth/callback?code=login-req`, { redirect: "manual", headers: { accept: "text/html,application/json" } });
  assert.equal(agentRes.status, 200);
  const agentCookie = cookieFrom(agentRes);
  assert.equal((await agentRes.json()).principal.type, "agent");

  // Human: browser login with state + PKCE.
  const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get("location")!);
  assert.equal(authorize.pathname, "/api/oauth/authorize");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("redirect_uri"), `${base}/auth/callback`);
  lastChallenge = authorize.searchParams.get("code_challenge")!;
  const cb = await fetch(`${base}/auth/callback?code=human-code&state=${authorize.searchParams.get("state")}`, { redirect: "manual" });
  assert.equal(cb.status, 302);
  const humanCookie = cookieFrom(cb);

  // A replayed state is refused.
  const replay = await fetch(`${base}/auth/callback?code=human-code&state=${authorize.searchParams.get("state")}`, { redirect: "manual" });
  assert.equal(replay.status, 400);

  // Agent publishes its draft (upload_document action).
  const draft = "Our product utilizes cutting-edge AI to revolutionize workflows.\n\nPricing starts at $10.";
  const up = await call(agentCookie, "POST", "/api/documents", { filename: "launch.md", content: draft, title: "Launch post" });
  assert.equal(up.status, 201);
  const docId = up.json.id;
  assert.equal(up.json.reviewer.id, "agent-1");

  // Human highlights and comments.
  const quote = "utilizes cutting-edge AI to revolutionize workflows";
  const start = draft.indexOf(quote);
  const th = await call(humanCookie, "POST", `/api/documents/${docId}/threads`, { start, end: start + quote.length, quote, body: "Sounds like marketing fluff. Be concrete." });
  assert.equal(th.status, 201);
  const threadId = th.json.thread.id;
  await app.settle();
  assert.equal(events.length, 1, "reviewer agent is woken");
  assert.equal(events[0].payload.thread_id, threadId);
  assert.match(events[0].summary, /get_thread --param thread_id=/);

  // Agent: list_pending → get_thread → reply + suggest_edit.
  const pending = await call(agentCookie, "GET", "/api/inbox");
  assert.equal(pending.json.pending.length, 1);
  const detail = await call(agentCookie, "GET", `/api/threads/${threadId}`);
  assert.equal(detail.json.thread.anchor.quote, quote);
  assert.ok(detail.json.context.after.startsWith("."));
  await call(agentCookie, "POST", `/api/threads/${threadId}/comments`, { body: "Fair. Proposed a concrete rewrite." });
  const sug = await call(agentCookie, "POST", `/api/threads/${threadId}/suggestions`, { replacement: "drafts release notes from your merged PRs", rationale: "concrete" });
  assert.equal(sug.status, 201);
  const suggestionId = sug.json.thread.suggestions[0].id;
  await app.settle();
  assert.equal(events.length, 1, "agent's own activity does not wake itself");

  // Agents cannot accept their own suggestions.
  const selfAccept = await call(agentCookie, "POST", `/api/suggestions/${suggestionId}/accept`, {});
  assert.equal(selfAccept.status, 403);

  // Human accepts.
  const acc = await call(humanCookie, "POST", `/api/suggestions/${suggestionId}/accept`, {});
  assert.equal(acc.status, 200);
  assert.equal(acc.json.document.text, "Our product drafts release notes from your merged PRs.\n\nPricing starts at $10.");
  assert.equal(acc.json.document.current_version, 2);
  await app.settle();
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.reason, "suggestion_accepted");

  // Download reflects the accepted change.
  const raw = await fetch(`${base}/api/documents/${docId}/raw`, { headers: { cookie: agentCookie } });
  assert.equal(await raw.text(), acc.json.document.text);
});

test("unauthenticated and cross-origin requests are refused", async () => {
  const anon = await fetch(`${base}/api/documents`);
  assert.equal(anon.status, 401);
  const body = await anon.json();
  assert.match(body.hint, /raft integration login/);
  const xo = await fetch(`${base}/api/documents`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(xo.status, 403);
  const form = await fetch(`${base}/api/documents`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b" });
  assert.equal(form.status, 401);
});

test("manifest is a valid v0 http_api manifest with path params declared", async () => {
  const m = await (await fetch(`${base}/.well-known/raft-agent-manifest.json`)).json();
  assert.equal(m.schema, "raft-agent-manifest.v0");
  assert.equal(m.execution.mode, "http_api");
  assert.equal(m.auth.type, "login_with_raft");
  const names = new Set<string>();
  for (const action of m.actions) {
    assert.match(action.name, /^[A-Za-z0-9._:-]{1,80}$/);
    assert.ok(!names.has(action.name));
    names.add(action.name);
    for (const [, key] of action.endpoint.path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
      assert.ok(action.parameters?.[key]?.required, `${action.name} declares path param ${key}`);
    }
    assert.ok(!action.parameters?.id, "a param named id would be duplicated into the query string by the CLI");
  }
});
