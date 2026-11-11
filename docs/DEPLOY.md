# Deploying Raft Review

One container, one SQLite volume, a TLS reverse proxy in front. The image
includes Tectonic with a pre-warmed TeX package cache, so papers compile on the
server.

## 1. Build and run

```bash
git clone https://github.com/odysa/raft-review.git && cd raft-review
cp .env.example .env          # fill in after step 2
docker compose up -d --build
docker compose logs -f        # look for {"event":"listening", ..., "compiler":"tectonic"}
```

Or plain Docker:

```bash
docker build -t raft-review .
docker run -d --name raft-review --env-file .env -e TRUST_PROXY=1 \
  -v raft-review-data:/data -p 127.0.0.1:8787:8787 raft-review
```

The container runs as an unprivileged user (uid 10001), keeps all state in
`/data`, exposes port 8787, and has a `HEALTHCHECK` on `/healthz`.

## 2. TLS and a public hostname

Agents fetch the manifest over HTTPS only, and the OAuth callback must match
`PUBLIC_URL` byte for byte. Put any TLS proxy in front, for example Caddy:

```
review.example.com {
  reverse_proxy 127.0.0.1:8787
  request_body {
    max_size 100MB
  }
}
```

Set `TRUST_PROXY=1` (compose does) so rate limits use the client's IP from
`X-Forwarded-For`. Don't set it when the app is exposed directly.

## 3. Register the app in Raft

An agent in your Raft server prepares the registration, and an owner or admin approves the card:

```bash
raft integration app prepare register \
  --client-key raft-review \
  --name "Raft Review" \
  --description "Review papers and documents with agents: comment on the PDF, accept LaTeX edits" \
  --homepage-url https://review.example.com \
  --redirect-url https://review.example.com/auth/callback \
  --agent-manifest-url https://review.example.com/.well-known/raft-agent-manifest.json \
  --scope openid --scope profile --scope agent:event:write \
  --target "#your-channel"
```

The client secret is delivered once, to the owning agent. Put it in `.env` and nowhere else.

Optional, for instant access removal: in the app's settings in Raft, enable
**App Notifications** with the `server` group, set the webhook URL to
`https://review.example.com/webhooks/raft`, and put the signing secret in
`RAFT_WEBHOOK_SECRET`.

## 4. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | — | `https://review.example.com`, no trailing slash. Must match the registration. |
| `RAFT_CLIENT_ID` / `RAFT_CLIENT_SECRET` | — | From registration (required) |
| `RAFT_API_URL` | `https://api.raft.build` | Raft API origin |
| `RAFT_SERVICE_KEY` | client ID | What agents pass to `--service` |
| `RAFT_SERVER_ID` | learned | Server ID for agent-event tokens; learned from the first human sign-in |
| `RAFT_WEBHOOK_SECRET` | — | App Notifications signing secret(s), comma-separated during rotation |
| `COMPILER` | `auto` | `tectonic`, `none` (agents upload PDFs), or `auto` (Tectonic if installed). The image sets `tectonic`. |
| `COMPILE_TIMEOUT_MS` | `120000` | Per-compile time limit |
| `COMPILE_CONCURRENCY` | `2` | Parallel compiles |
| `TECTONIC_ONLY_CACHED` | — | `1` = never download TeX packages (air-gapped); only the pre-warmed set is available |
| `TRUST_PROXY` | — | `1` behind a reverse proxy |
| `DATA_DIR` | `/data` (image) | SQLite database and nothing else |
| `PORT` | `8787` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |

## 5. Operate

**Health:** `GET /healthz` returns `{"ok":true,"version","schema","compiler"}` and 503 if the database is unavailable.

**Logs:** one JSON object per line. Useful events:
- `request`: method, path, status, ms
- `compile`: document, version, ok, ms
- `app_notifications_subscribe`
- `unhandled`: stack traces

**Backups:** online and safe while the app runs:

```bash
docker compose exec raft-review npm run backup -- /data/backups/latest.sqlite
docker compose cp raft-review:/data/backups/latest.sqlite ./raft-review-$(date +%F).sqlite
```

To restore, stop the app, replace `/data/raft-review.sqlite` with the backup, and start it.

**Upgrades:** `git pull && docker compose up -d --build`. Migrations run at
startup and are tracked in `PRAGMA user_version`; take a backup first. Shutdown
is graceful: on `SIGTERM` the server stops accepting connections, closes live
updates, lets running compiles finish (up to 30 s), and closes the database.

**Scaling:** one instance per database. Rate limits and live-update streams are
in memory. Compiles are the heavy part; raise `COMPILE_CONCURRENCY` with CPU.

## Security model

- **Untrusted LaTeX:**
  - Tectonic runs with `--untrusted`, which disables shell-escape and other known-insecure features.
  - Before compiling, sources whose file-reading commands (`\input`, `\include`, `\includegraphics`,
    `\lstinputlisting`, `\bibliography`, …) point at absolute paths or `..` are refused.
  - Each compile runs in its own temp directory, with a minimal environment and a hard timeout.
  - Keep the container unprivileged (the default) for defense in depth.
- **Uploads:** zip entries are path-checked, junk is dropped, and unpacked size (50 MB) and file
  count (2,000) are capped before extraction.
- **Auth:**
  - Sessions are hashed server-side and last at most 1 hour (the Raft token's lifetime).
  - Identity and membership are re-checked with Raft every ≤ 60 s.
  - Removals arrive by signed webhook.
- **Browser:** strict CSP, no eval, no framing, HSTS, JSON-only writes with an `Origin` check, and
  rate limits on sign-in, writes and uploads/compiles.
- **Tenancy:** documents are scoped to the Raft server of the signed-in principal; other servers get 404.
