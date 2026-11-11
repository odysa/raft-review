# Raft Review — guide for agents

Raft Review is a connected Raft App for reviewing documents with humans the way
people review in Google Docs: a human highlights a passage and comments; you
reply in that thread and suggest edits; the human accepts or rejects each one.
Text, Markdown, LaTeX projects (review the PDF, edit the source) and PDF are
supported.

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
by their quoted text, then by approximate match, then by the unchanged text around
them (marked *text edited*). Threads whose text disappeared become orphaned, and
pending suggestions on changed text go stale.

## Research papers (LaTeX + PDF)

The human reviews the **compiled PDF**; you edit the **LaTeX**. Each comment on
the PDF is mapped to the exact LaTeX that produced it, so `get_thread` returns
`thread.source` (`path`, `line`, `quote`) and `source_context` (the LaTeX around
it). `suggest_edit` on a paper edits that source span; write the replacement as
LaTeX. When the human accepts, the server recompiles the PDF (or asks you to).

Publish a paper from its repository:

```sh
zip -r /tmp/paper.zip . -x '.git/*' 'build/*'
base64 < /tmp/paper.zip > /tmp/paper.zip.b64
raft integration invoke --service raft-review --action upload_paper \
  --param title="Sparse Routing" --param filename=paper.zip --param zip_base64=@/tmp/paper.zip.b64
```

Answer a comment:

```sh
raft integration invoke --service raft-review --action get_thread --param thread_id=<id>
# → thread.source = { path: "sections/method.tex", line: 9, quote: "Hyperparameters were chosen by intuition." }
raft integration invoke --service raft-review --action suggest_edit --param thread_id=<id> \
  --param replacement=@new.tex --param rationale="State the search space."
```

Use `--param quote=<exact LaTeX>` to replace only part of the mapped span, and
`--param path=<file>` to edit a different file than the one the comment maps to.
You can also start your own thread by quoting LaTeX with `create_thread`
(`quote` is searched in the sources first, then in the PDF).

**Sync accepted changes back to the repo.** After the human accepts edits:

```sh
raft integration invoke --service raft-review --action get_patch \
  --param document_id=<id> --param from=<last version you synced> --output review.patch
git apply review.patch && git commit -am "Apply review changes (Raft Review v<n>)"
```

`get_document` shows `current_version`; remember it as your next `from`. If you
change the paper outside the review, push the new state with `upload_sources`
(comments re-anchor; the PDF recompiles).

**Compiling.** If the server compiles (the usual setup), nothing to do; when a
compile fails you're woken with `get_compile_log`. If you're woken with
"accepted edits … compile, then upload_pdf", the server has no compiler: apply
the patch, build (`latexmk -pdf -synctex=1 main.tex`, or
`tectonic -X compile main.tex --synctex`), then:

```sh
base64 < main.pdf > main.pdf.b64; base64 < main.synctex.gz > main.synctex.b64
raft integration invoke --service raft-review --action upload_pdf --param document_id=<id> \
  --param pdf_base64=@main.pdf.b64 --param synctex_base64=@main.synctex.b64
```

Sending SyncTeX makes PDF→LaTeX mapping exact even for repeated phrases.

## Plain PDFs

A PDF uploaded on its own (no LaTeX) can be commented on but not edited:
accepting a suggestion records it, and the human gets a checklist to apply in
the source. Upload the LaTeX project instead whenever you have it.

## Raw text and offsets

`create_thread` and `suggest_edit` take an exact `quote` (with `occurrence`
when it repeats) — you never need to count characters. Anchors in responses
include `start`/`end` offsets into `text` and a `line` (or `page`).
