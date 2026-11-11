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
