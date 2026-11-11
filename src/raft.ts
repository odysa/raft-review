// Client for the Raft endpoints this App uses.
//
//   Humans:  browser → GET {api}/api/oauth/authorize (PKCE S256) → our
//            /auth/callback?code&state → POST /api/oauth/token → /userinfo
//   Agents:  `raft integration login` → GET our /auth/callback?code=<request>
//            (no state, no PKCE) → same token exchange → session cookie
//   Wake an agent: POST /api/oauth/requests/agent (client credentials; an
//            agent with a remembered grant is approved at once) → token with
//            agent:event:write bound to the agent-inbound resource →
//            POST /api/oauth/agent-events

import { createHash, randomBytes } from "node:crypto";

import { callbackUrl, type Config } from "./config.ts";
import type { PrincipalType } from "./db.ts";

export const HUMAN_SCOPES = "openid profile";
// Least privilege, and it matters for coverage: Raft auto-approves only when an
// existing grant's scopes cover every requested scope, so asking for more than
// the event route needs could leave the request pending forever.
export const AGENT_EVENT_SCOPES = ["agent:event:write"];

export interface RaftUserinfo {
  sub: string;
  type: PrincipalType;
  name: string;
  preferred_username: string;
  avatar_url?: string | null;
  picture?: string | null;
  server_id: string;
  server_slug: string;
  server_role?: string;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  resource?: string;
}

export class RaftError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function agentInboundResource(serverId: string): string {
  return `urn:raft:server:${serverId}:agent-inbound`;
}

export class RaftClient {
  private config: Config;
  private fetchImpl: typeof fetch;

  constructor(config: Config, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  authorizeUrl(state: string, challenge: string): string {
    const url = new URL("/api/oauth/authorize", this.config.raftApiUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", callbackUrl(this.config));
    url.searchParams.set("scope", HUMAN_SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  private basicAuth(): string {
    return `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`;
  }

  private async post(pathname: string, body: Record<string, unknown>, auth: string): Promise<{ status: number; json: any }> {
    const res = await this.fetchImpl(new URL(pathname, this.config.raftApiUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  /** Exchange a browser authorization code (PKCE) for a token. */
  async exchangeHumanCode(code: string, verifier: string): Promise<TokenResponse> {
    const { status, json } = await this.post("/api/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(this.config),
      code_verifier: verifier,
    }, this.basicAuth());
    if (status !== 200 || !json?.access_token) throw new RaftError("token exchange failed", status, json);
    return json;
  }

  /** Exchange the one-time request id from `raft integration login`. Raw
   *  agent codes carry no PKCE challenge, so no verifier is sent. When the
   *  grant includes a resource-bound scope (agent:event:write) Raft insists on
   *  the resource indicator; that failure happens before the request is
   *  consumed, so one retry with the resource is safe. */
  async exchangeAgentCode(code: string): Promise<TokenResponse> {
    const attempt = (resource?: string) => this.post("/api/oauth/token", {
      grant_type: "urn:slock:grant-type:agent_request",
      request_id: code,
      ...(resource ? { resource } : {}),
    }, this.basicAuth());
    let { status, json } = await attempt();
    if (status === 400 && /resource/i.test(String(json?.error ?? "")) && this.config.raftServerId) {
      ({ status, json } = await attempt(agentInboundResource(this.config.raftServerId)));
    }
    if (status !== 200 || !json?.access_token) throw new RaftError("agent token exchange failed", status, json);
    return json;
  }

  async userinfo(accessToken: string): Promise<RaftUserinfo> {
    const res = await this.fetchImpl(new URL("/api/oauth/userinfo", this.config.raftApiUrl), {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => null);
    if (res.status !== 200 || !json?.sub || (json.type !== "human" && json.type !== "agent")) {
      throw new RaftError("userinfo failed", res.status, json);
    }
    return json;
  }

  /** Get a token that can post events to `agentId`. Works without a human in
   *  the loop only while the agent holds a remembered grant for this App that
   *  includes agent:event:write; otherwise Raft answers `pending` and the
   *  caller falls back to the agent's polling inbox. */
  async agentEventToken(agent: { id: string; server_id: string; server_slug: string }): Promise<string | null> {
    const req = await this.post("/api/oauth/requests/agent", {
      serverSlug: agent.server_slug,
      agentId: agent.id,
      scopes: AGENT_EVENT_SCOPES,
    }, this.basicAuth());
    if (req.status !== 200 || req.json?.status !== "approved" || !req.json?.requestId) return null;
    const token = await this.post("/api/oauth/token", {
      grant_type: "urn:slock:grant-type:agent_request",
      request_id: req.json.requestId,
      resource: agentInboundResource(agent.server_id),
    }, this.basicAuth());
    if (token.status !== 200 || !token.json?.access_token) return null;
    return token.json.access_token;
  }

  async postAgentEvent(accessToken: string, event: {
    summary: string;
    payload: Record<string, unknown>;
    externalEventId: string;
  }): Promise<{ status: number; json: any }> {
    return this.post("/api/oauth/agent-events", {
      kind: "event",
      summary: event.summary,
      payload: event.payload,
      externalEventId: event.externalEventId,
      ttlSeconds: 7 * 24 * 3600,
    }, `Bearer ${accessToken}`);
  }
}
