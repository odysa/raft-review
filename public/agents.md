# Raft Review — guide for agents

Raft Review is a connected Raft App for reviewing documents with humans the way
people review in Google Docs: a human highlights a passage and comments; you
reply in that thread and suggest edits; the human accepts or rejects each one.
Text, Markdown, LaTeX source and PDF are supported.

## Sign in once

```sh
raft integration login --service raft-review
```

After that you appear in the app's reviewer list. Always start with
`--list-actions`; action names come from the manifest.

```sh
raft integration invoke --service raft-review --list-actions
```

## When you are woken

Every human comment on a document you review arrives as an App event in your
inbox (`@raft-review`, `type=third_party_app`). The event summary ends with the
exact next command, usually:

```sh
raft integration invoke --service raft-review --action get_thread --param thread_id=<id>
```

If you were offline, catch up with `list_pending` — it lists every open thread
whose latest comment is not yours on a document you review or a thread you took
part in.

## Answering a thread

1. `get_thread` — read the highlighted quote, the surrounding text and the
   whole conversation.
2. `reply` — answer the comment. Use `--param body=@reply.md` for long text.
3. `suggest_edit` — propose the replacement. By default it replaces the whole
   highlighted passage; pass `--param quote=<exact substring>` to change only
   part of it. An empty replacement deletes. Add `--param rationale=...`.

```sh
raft integration invoke --service raft-review --action reply \
  --param thread_id=<id> --param body=@reply.md
raft integration invoke --service raft-review --action suggest_edit \
  --param thread_id=<id> --param replacement=@new.txt --param rationale="Plainer wording"
```

Only humans accept or reject. You are woken again with the decision
(`suggestion_accepted` / `suggestion_rejected`). Resolve a thread with
`resolve_thread` once it is fully addressed — or leave that to the human.

A suggestion goes **stale** when the text it changes was edited before the
human decided; read the thread again and suggest anew.

## Publishing your own draft for review

```sh
raft integration invoke --service raft-review --action upload_document \
  --param filename=report.md --param title="Q3 report" --param content=@report.md
```

You become the document's reviewer. Share the `document_url` from the response
(or `PUBLIC_URL/#/doc/<id>`) with your human in Raft.

Prefer `suggest_edit` for targeted changes so each one can be accepted or
rejected. Use `upload_version` only for a full rewrite: open threads re-anchor
by their quoted text, and threads whose text disappeared become orphaned.

## PDFs

PDF text is extracted per page; pages are separated by a form feed (`\f`) in
`get_document`'s `text`, and anchors carry a `page` number. A PDF cannot be
edited in place: accepting a suggestion records it, and the human gets a
checklist of accepted changes to apply to the source. If you also have the
LaTeX source, upload it as its own document so edits apply directly.

## Raw text and offsets

`create_thread` and `suggest_edit` take an exact `quote` (with `occurrence`
when it repeats) — you never need to count characters. Anchors in responses
include `start`/`end` offsets into `text` and a `line` (or `page`).
