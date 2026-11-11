import path from "node:path";

export interface Config {
  port: number;
  /** Public origin of this app, e.g. https://review.example.com (no trailing slash). */
  publicUrl: string;
  /** Raft API origin, e.g. https://api.raft.build */
  raftApiUrl: string;
  clientId: string;
  clientSecret: string;
  /** Server ID the App is registered on; used for the agent-inbound resource. */
  raftServerId: string;
  dataDir: string;
  /** Local development only: enables /auth/dev-login, which skips Raft. */
  devLogin: boolean;
  /** Service key agents pass to `raft integration invoke --service`. */
  serviceKey: string;
  /** How long a verified identity/membership may be trusted (Raft: ≤ 60 s). */
  membershipTtlMs?: number;
  /** App Notifications signing secrets (current first; previous during rotation). */
  webhookSecrets: string[];
  /** LaTeX compiler: "auto" (Tectonic if installed), "tectonic", or "none"
   *  (agents compile and upload PDFs). */
  compiler: "auto" | "tectonic" | "none";
  tectonicPath?: string;
  compileTimeoutMs: number;
  compileConcurrency: number;
  /** Tectonic: use only locally cached TeX packages (no network). */
  tectonicOnlyCached: boolean;
  /** Behind a reverse proxy: take the client IP from X-Forwarded-For. */
  trustProxy?: boolean;
  /** A compile whose worker stopped heartbeating this long ago is reclaimed. */
  compileLeaseMs?: number;
  /** How often each process checks the shared change feed for live updates. */
  changePollMs?: number;
  /** How often each process looks for queued compiles (it also looks at once when it queues one). */
  compilePollMs?: number;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  const publicUrl = trimSlash(env.PUBLIC_URL ?? `http://localhost:${port}`);
  const devLogin = env.RAFT_REVIEW_DEV_LOGIN === "1";
  const config: Config = {
    port,
    publicUrl,
    raftApiUrl: trimSlash(env.RAFT_API_URL ?? "https://api.raft.build"),
    clientId: env.RAFT_CLIENT_ID ?? "",
    clientSecret: env.RAFT_CLIENT_SECRET ?? "",
    raftServerId: env.RAFT_SERVER_ID ?? "",
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    devLogin,
    serviceKey: env.RAFT_SERVICE_KEY ?? env.RAFT_CLIENT_ID ?? "raft-review",
    webhookSecrets: (env.RAFT_WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    compiler: env.COMPILER === "none" || env.COMPILER === "tectonic" ? env.COMPILER : "auto",
    tectonicPath: env.TECTONIC_PATH || undefined,
    compileTimeoutMs: Number(env.COMPILE_TIMEOUT_MS ?? 120_000),
    compileConcurrency: Number(env.COMPILE_CONCURRENCY ?? 2),
    tectonicOnlyCached: env.TECTONIC_ONLY_CACHED === "1",
    trustProxy: env.TRUST_PROXY === "1",
    compileLeaseMs: env.COMPILE_LEASE_MS ? Number(env.COMPILE_LEASE_MS) : undefined,
  };
  if (!devLogin && (!config.clientId || !config.clientSecret)) {
    throw new Error("RAFT_CLIENT_ID and RAFT_CLIENT_SECRET are required (or set RAFT_REVIEW_DEV_LOGIN=1 for local development)");
  }
  if (devLogin && new URL(publicUrl).hostname !== "localhost" && new URL(publicUrl).hostname !== "127.0.0.1") {
    throw new Error("RAFT_REVIEW_DEV_LOGIN=1 is only allowed when PUBLIC_URL is localhost");
  }
  return config;
}

export function callbackUrl(config: Config): string {
  return `${config.publicUrl}/auth/callback`;
}
