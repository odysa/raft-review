# Local setup

Three ways to run Raft Review on your machine, from quickest to most complete:

| | What you get | Needs Raft? | Time |
| --- | --- | --- | --- |
| **A. Dev mode** | Full UI; you play both the human and the agent | No | 2 min |
| **B. Local app + hosted Raft** | Real Login with Raft, real agents, real wake-ups | Your server on raft.build + a tunnel | 15 min |
| **C. Everything local** | Raft itself running from `raft-source` too | Docker | 30+ min |

## Prerequisites

- **Node.js 24** or newer: `node --version` should print `v24.x`. The app uses the
  built-in `node:sqlite` and runs TypeScript directly, so it has no build step and no
  runtime dependencies.
- **git**
- For research papers: **[Tectonic](https://tectonic-typesetting.github.io)**, so
  the server can compile LaTeX (`brew install tectonic`, or see its install page).
  Without it, papers still work, but the agent compiles and uploads the PDF.
- For B and C: an HTTPS tunnel such as [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  (`brew install cloudflared`). The Raft CLI fetches the agent manifest over HTTPS only.

```bash
git clone https://github.com/odysa/raft-review.git
cd raft-review
npm install          # dev tooling only: typescript + @types/node
npm test             # 40 tests, including real LaTeX compiles when Tectonic is installed
```

---

## A. Dev mode (no Raft)

```bash
npm run dev
```

Open http://localhost:8787. Dev mode adds a sign-in form, so you can enter
as a **human** or as an **agent** without Raft. It is only available when
`RAFT_REVIEW_DEV_LOGIN=1` and `PUBLIC_URL` is localhost. Data goes to `./data/raft-review.sqlite`.

### Try the whole loop

1. In a normal window, sign in **as agent** with the name `Scribe`, then sign out.
   (Signing in once is what makes an agent show up in the reviewer picker, the same
   as `raft integration login` does in production.)
2. Sign in **as human** and upload a `.md`, `.tex`, `.txt` or `.pdf`. Pick `@scribe` as the reviewer.
3. Select a passage, click **💬 Comment**, and write a comment.
4. Act as the agent. Open a private window, sign in **as agent** `Scribe`, open the
   document and reply. Or use the same HTTP calls `raft integration invoke` makes:

   ```bash
   B=http://localhost:8787
   # sign in as the agent (dev only) and keep the cookie, like the CLI does
   curl -s -c agent.jar -H 'content-type: application/json' \
     -d '{"type":"agent","name":"Scribe"}' $B/auth/dev-login >/dev/null

   # list_pending: threads waiting on this agent
   curl -s -b agent.jar $B/api/inbox | python3 -m json.tool

   # reply and suggest_edit (put the thread_id from the inbox in T)
   T=<thread_id>
   curl -s -b agent.jar -H 'content-type: application/json' \
     -d '{"body":"Agreed, here is a tighter version."}' $B/api/threads/$T/comments >/dev/null
   curl -s -b agent.jar -H 'content-type: application/json' \
     -d '{"replacement":"New wording here","rationale":"Shorter"}' $B/api/threads/$T/suggestions >/dev/null
   ```

5. The human window updates live. Hover the suggestion to preview it inline, then
   **Accept** or **Reject**.

### Try a research paper

```bash
(cd examples/sparse-routing && zip -r ../../sparse-routing.zip .)
```

1. Signed in as the human, drop `sparse-routing.zip` on the documents page, with `@scribe` as reviewer.
   The server compiles it in about a second.
2. Select a sentence in the PDF and click **💬 Comment**. The comment box shows
   where it lives in the LaTeX (for example `main.tex:14`). Tick **Suggest a LaTeX
   replacement** to propose an edit yourself.
3. As the agent, answer with the HTTP calls the actions make:

   ```bash
   T=$(curl -s -b agent.jar $B/api/inbox | python3 -c "import json,sys;print(json.load(sys.stdin)['pending'][0]['thread_id'])")
   curl -s -b agent.jar $B/api/threads/$T | python3 -m json.tool | head -40   # source.path / line / quote
   curl -s -b agent.jar -H 'content-type: application/json' \
     -d '{"replacement":"We tuned the learning rate on the validation split.","rationale":"State the search."}' \
     $B/api/threads/$T/suggestions >/dev/null
   ```

4. Click **Accept**. The banner shows *Compiling v2…*, then the PDF refreshes with
   the comment on the new sentence. **Changes** shows the patch; `get_patch`
   returns the same diff for the agent's repository.

The manifest that tells agents about these calls is at
http://localhost:8787/.well-known/raft-agent-manifest.json, and the agent guide is at
http://localhost:8787/docs/agents.

Dev mode never contacts Raft, so it doesn't wake agents. In dev mode the agent finds work with `list_pending`.

To reset, stop the server and delete `./data`.

---

## B. Local app + your Raft server on raft.build

### 1. Give the app a stable HTTPS URL

```bash
cloudflared tunnel --url http://localhost:8787
```

Copy the `https://<random>.trycloudflare.com` URL it prints. This is your
`PUBLIC_URL`. A quick tunnel gets a new URL every time it starts. If it changes,
update the registration (step 2) or use a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/)
for a fixed hostname.

### 2. Register the app in Raft

Ask an agent in your Raft server to run the following, with your URL in place of `https://YOUR-TUNNEL`.
A server owner or admin approves the card once.

```bash
raft integration app prepare register \
  --client-key raft-review-dev \
  --name "Raft Review (dev)" \
  --description "Review documents with agents" \
  --homepage-url https://YOUR-TUNNEL \
  --redirect-url https://YOUR-TUNNEL/auth/callback \
  --agent-manifest-url https://YOUR-TUNNEL/.well-known/raft-agent-manifest.json \
  --scope openid --scope profile --scope agent:event:write \
  --target "#your-channel"
```

Or register it yourself under **Settings → Applications → My Apps** with the same values.

The **client secret is shown once**, and only to the app's owner. Put it straight into
`.env` (next step). Don't paste it into chat. If it's lost, rotate it with
`raft integration app rotate-secret --client raft-review-dev --output <new-private-file>`.

The redirect URL must match **byte for byte**: same scheme and host, path
`/auth/callback`, no trailing slash. If they differ, login fails with "returnUrl does not match registered OAuth client".

To change the URLs after the tunnel restarts:

```bash
raft integration app update --client raft-review-dev \
  --homepage-url https://NEW-TUNNEL \
  --redirect-url https://NEW-TUNNEL/auth/callback \
  --agent-manifest-url https://NEW-TUNNEL/.well-known/raft-agent-manifest.json
```

### 3. Configure and start

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
PUBLIC_URL=https://YOUR-TUNNEL          # no trailing slash
RAFT_API_URL=https://api.raft.build
RAFT_CLIENT_ID=raft-review-dev
RAFT_CLIENT_SECRET=<from registration>
RAFT_SERVICE_KEY=raft-review-dev        # what agents pass to --service
# RAFT_SERVER_ID=                       # optional, see below
```

`RAFT_SERVER_ID` is optional. Agent logins that include `agent:event:write` need
the server ID, and the app learns it from the **first human who signs in**. So
sign in as a human (step 4) before your agent runs `raft integration login`. To set
it explicitly, sign in and open `https://YOUR-TUNNEL/api/me`; the value is `server_id`.

```bash
npm run start:env      # node --env-file=.env src/server.ts
```

**Optional: instant access removal.** Without this, the app notices that someone
was removed within 60 seconds. To make it immediate, open the app's settings in
Raft as an owner or admin and enable **App Notifications** with the `server` group.
Set the webhook URL to `https://YOUR-TUNNEL/webhooks/raft` and put the signing
secret in `.env`:

```dotenv
RAFT_WEBHOOK_SECRET=raft_webhook_secret_...
```

On startup, or after the first human signs in, the app subscribes itself to
`server.member_removed` and `server.member_role_changed`. The log should show
`App Notifications: subscribed: ...`.

### 4. Use it

- **Human:** open `https://YOUR-TUNNEL` and click **Sign in with Raft**. Sessions
  last as long as Raft's access token (1 hour). Identity and membership are
  re-checked with Raft at least every 60 seconds, so if you remove someone from the server
  or uninstall the app, they lose access right away.
- **Agent:** in Raft, ask your agent to run:

  ```bash
  raft integration login --service raft-review-dev --scope agent:event:write
  raft integration invoke --service raft-review-dev --list-actions
  ```

  `agent:event:write` lets the app wake the agent when you comment. Without it,
  the agent can still find work with `list_pending`, but it isn't woken.
- **Proof it works end to end:** have the agent run one real action, for example
  `raft integration invoke --service raft-review-dev --action list_documents`.
  Raft's docs say a "ready" login alone doesn't prove the session works.

---

## C. Everything local (Raft from source)

Run Raft itself from [`botiverse/raft-source`](https://github.com/botiverse/raft-source).
You need Node 24.21, pnpm 12 and Docker; see its README.

```bash
git clone https://github.com/botiverse/raft-source.git
cd raft-source
pnpm install
./raftdev start          # prints the seeded login and the local ports
```

Then follow B with these changes:

- Set `RAFT_API_URL` to the **API server URL that `raftdev` prints**.
- Registering loopback or private URLs requires `--unsafe-demo-url-override` on
  `raft integration app prepare register` / `update`.
- The manifest URL still has to be **HTTPS** for agents (`raft integration invoke`
  refuses plain http), so keep the tunnel from B for the app.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `returnUrl does not match registered OAuth client` | `PUBLIC_URL` + `/auth/callback` differs from the registered redirect URL. Compare them byte for byte. |
| `invalid_state` after Raft sends you back | The login started in another browser or tab, took longer than 10 minutes, or the callback was replayed. Start again from **Sign in with Raft**. |
| Agent login: `service callback handoff did not set a session cookie` | The CLI couldn't reach your callback. Check that the tunnel is up and that `PUBLIC_URL` is the tunnel URL. |
| Agent login: `Service response: server_id_unknown — …` | An agent logged in before any human did. Sign in as a human once, or set `RAFT_SERVER_ID`, then re-run `raft integration login`. |
| Agent login: `Service response: raft_exchange_failed — … resource …` | `RAFT_SERVER_ID` doesn't match the server the agent is in. |
| Agent isn't woken when you comment | Check `sqlite3 data/raft-review.sqlite "select status, detail from agent_events order by created_at desc limit 5"`. `no_grant` means the agent's login didn't include `--scope agent:event:write`; re-run login with it. |
| Signed out every hour | Expected. Raft access tokens last 1 hour and have no refresh token. The page sends you back through sign-in and returns you to the same document. |
| PDF shows "failed to render" | PDF.js loads from `cdnjs.cloudflare.com`; check that your network allows it. |
| Log says `App Notifications: installation lookup HTTP 404` | The app isn't installed on that server yet, or `RAFT_SERVER_ID` is wrong. |
| Log says `App Notifications: subscriptions HTTP 400` | The installation hasn't approved the `server` group. Enable it in the app's App Notifications settings. |
| `RAFT_CLIENT_ID and RAFT_CLIENT_SECRET are required` on start | Use `npm run start:env` so `.env` is loaded, or `npm run dev` for dev mode without Raft. |
