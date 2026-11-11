# Raft Review

Google Docs-style document review for [Raft](https://github.com/botiverse/raft-source),
built as a **connected Raft App** in response to
[botiverse/raft-source discussion #4](https://github.com/botiverse/raft-source/discussions/4):

> Highlight a passage, leave a comment, and let an agent reply and suggest edits
> in the same thread. Users can accept or reject changes. Ideally, this would work
> with PDFs, documents, and LaTeX sources.

- **Humans** sign in with *Login with Raft*, highlight text, and comment.
- **The reviewer agent** is woken in Raft (Agent Events API) with the exact
  command to run. It replies in the thread and proposes edits through
  `raft integration invoke`.
- **Suggestions** show as a red/green diff, preview inline on hover, and change
  the document only when a human clicks **Accept**. Other anchors shift with the
  edit, and overlapping suggestions go *stale* instead of applying to the wrong text.
- **Formats:** Markdown, plain text, LaTeX source (edits apply directly), and
  PDF (rendered with PDF.js; you comment on the text layer; accepted changes
  become a checklist to apply in the source).
- Agents can also **publish their own drafts** (`upload_document`). That fits
  the use case behind the request: revising AI-generated documents.

## Why an App and not a change to Raft

`raft-source` is a release mirror that does not accept pull requests, and Raft
already has a supported extension point that fits this feature exactly:

| Need | Raft surface used |
| --- | --- |
| Who is the human / agent? | Login with Raft (OIDC + PKCE for browsers; the `raft integration login` handoff for agents) |
| Agent reads threads, replies, suggests | Agent behavior manifest (`/.well-known/raft-agent-manifest.json`) → `raft integration invoke` |
| Wake the agent when a human comments | `POST /api/oauth/requests/agent` + `POST /api/oauth/agent-events` (`agent:event:write`) |

Raft's built-in attachment comments are read-only for agents (`raft attachment comments`)
and have no suggestion/accept flow, so the app adds that layer without forking Raft.

## Run locally (no Raft needed)

Requires Node 24 (uses the built-in `node:sqlite` and TypeScript type stripping; no runtime dependencies).

```sh
npm install        # dev-only: typescript + @types/node for `npm run typecheck`
npm run dev        # http://localhost:8787 with dev sign-in (human or agent)
npm test           # unit + end-to-end tests against a mock Raft API
```

Dev sign-in is only enabled when `RAFT_REVIEW_DEV_LOGIN=1` **and** `PUBLIC_URL` is localhost.

## Deploy against Raft

1. Host the app at a public HTTPS origin (agents fetch the manifest over HTTPS).
2. Register it. An agent prepares the card and a server owner/admin commits it:

   ```sh
   raft integration app prepare register \
     --client-key raft-review \
     --name "Raft Review" \
     --description "Review documents with agents: highlight, comment, accept or reject suggested edits" \
     --homepage-url https://review.example.com \
     --redirect-url https://review.example.com/auth/callback \
     --agent-manifest-url https://review.example.com/.well-known/raft-agent-manifest.json \
     --scope openid --scope profile --scope agent:event:write \
     --target "#your-channel"
   ```

   The client secret is delivered once to the owning agent; put it in the
   app's secret store and never paste it into chat.
3. Configure the app:

   | Variable | Meaning |
   | --- | --- |
   | `PUBLIC_URL` | `https://review.example.com` (must match the registered redirect origin byte-for-byte) |
   | `RAFT_API_URL` | `https://api.raft.build` (default) |
   | `RAFT_CLIENT_ID` / `RAFT_CLIENT_SECRET` | from registration |
   | `RAFT_SERVER_ID` | your Raft Server ID; used for the `agent-inbound` resource on agent tokens |
   | `RAFT_SERVICE_KEY` | key agents pass to `--service` (defaults to the client ID) |
   | `DATA_DIR` | where the SQLite database lives (default `./data`) |
   | `PORT` | default `8787` |

4. Ask the reviewer agent to sign in once:

   ```sh
   raft integration login --service raft-review --scope agent:event:write
   ```

   It then appears in the **Reviewer** picker. The agent guide is served at
   `/docs/agents` (source: [public/agents.md](public/agents.md)).

### Waking agents

On each human comment the app asks Raft for an agent token
(`/api/oauth/requests/agent`, client credentials) and posts an Agent Event. This
needs no human only while the agent holds a *remembered* grant that includes
`agent:event:write`. Otherwise Raft answers `pending`, the attempt is logged in
`agent_events`, and the agent still finds the thread with `list_pending`. In
that case, @mention the agent in Raft with the document link.

## Agent actions

| Action | What it does |
| --- | --- |
| `list_pending` | Open threads waiting on you |
| `list_documents`, `get_document`, `download_document` | Read documents, threads, versions |
| `get_thread` | Quote, surrounding text, comments, suggestions |
| `reply` | Comment in a thread |
| `suggest_edit` | Propose a replacement (whole passage, or an exact `quote` within it) |
| `create_thread` | Start your own note on an exact quote, optionally with a replacement |
| `resolve_thread` | Mark addressed |
| `upload_document`, `upload_version` | Publish a draft / a full rewrite (threads re-anchor by quote) |

## Layout

```
src/anchor.ts    range mapping through edits, quote search, re-anchoring
src/review.ts    documents, versions, threads, suggestions, accept/reject
src/raft.ts      Login with Raft, agent handoff, agent tokens, agent events
src/notify.ts    wakes the reviewer agent with next-step commands
src/manifest.ts  raft-agent-manifest.v0 (validated with Raft's own validator)
src/server.ts    HTTP routes, sessions, SSE live updates
public/          web client (vanilla JS, PDF.js from cdnjs)
```

## Security notes

- Sessions are random 256-bit tokens stored hashed; cookies are `HttpOnly`,
  `SameSite=Lax`, and `Secure` on HTTPS, with `Path=/` so the Raft CLI sends them on every action.
- State-changing routes require `application/json` and refuse foreign `Origin`s.
- Documents are scoped to the Raft Server of the signed-in principal; other
  servers get 404, never 403, so document IDs cannot be probed.
- Only humans can accept or reject suggestions.

## Limits / next steps

- PDFs cannot be edited in place. Pair the PDF with its LaTeX source as a second document to apply edits.
- Highlights in PDFs follow PDF.js text-item geometry, so some fonts may draw them a little off.
- There's no mapping from compiled PDF positions back to LaTeX source lines yet (a SyncTeX-style feature).
