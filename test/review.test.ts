import assert from "node:assert/strict";
import { test } from "node:test";

import { openDb, type User } from "../src/db.ts";
import {
  addComment,
  addVersion,
  agentInbox,
  createDocument,
  createSuggestion,
  createThread,
  decideSuggestion,
  documentView,
  ReviewError,
  upsertUser,
} from "../src/review.ts";

function setup() {
  const db = openDb(":memory:");
  const human = upsertUser(db, { id: "h1", type: "human", name: "Ada", username: "ada", avatar_url: null, server_id: "s1", server_slug: "s" });
  const agent = upsertUser(db, { id: "a1", type: "agent", name: "Bot", username: "bot", avatar_url: null, server_id: "s1", server_slug: "s" });
  const outsider = upsertUser(db, { id: "h2", type: "human", name: "Eve", username: "eve", avatar_url: null, server_id: "s2", server_slug: "t" });
  return { db, human, agent, outsider };
}

const TEXT = "# Plan\n\nWe will utilize synergies to leverage growth.\nThe end.\n";

test("full review loop: comment, agent reply, suggestion, accept", () => {
  const { db, human, agent } = setup();
  const doc = createDocument(db, agent, { title: "Plan", filename: "plan.md", text: TEXT });
  assert.equal(doc.kind, "markdown");
  assert.equal(doc.reviewer_agent_id, agent.id, "uploading agent becomes reviewer");

  const quote = "utilize synergies to leverage growth";
  const start = TEXT.indexOf(quote);
  const thread = createThread(db, human, doc.id, { start, end: start + quote.length, quote, body: "Too much jargon." });
  const later = createThread(db, human, doc.id, { quote: "The end.", body: "Stronger ending?" });

  assert.equal(agentInbox(db, agent).length, 2, "both threads wait on the reviewer");
  addComment(db, agent, thread.id, "Agreed, here is a plainer version.");
  assert.equal(agentInbox(db, agent).length, 1, "answered thread leaves the inbox");
  createSuggestion(db, agent, later.id, { replacement: "Fin." });
  assert.equal(agentInbox(db, agent).length, 0, "a suggestion also answers a thread");

  const s = createSuggestion(db, agent, thread.id, { replacement: "work together to grow", rationale: "plain words" });
  assert.equal(s.original, quote);
  assert.throws(() => decideSuggestion(db, agent, s.id, "accept"), (e: ReviewError) => e.code === "human_decision");

  const { document } = decideSuggestion(db, human, s.id, "accept");
  assert.equal(document.current_version, 2);
  const view = documentView(db, human, doc.id);
  assert.equal(view.text, "# Plan\n\nWe will work together to grow.\nThe end.\n");
  const laterView = view.threads.find((t) => t.id === later.id)!;
  assert.equal(view.text!.slice(laterView.anchor.start, laterView.anchor.end), "The end.", "other anchors shift");
  const edited = view.threads.find((t) => t.id === thread.id)!;
  assert.equal(edited.anchor.quote, "work together to grow");
  assert.equal(edited.suggestions[0].status, "accepted");
});

test("overlapping pending suggestion goes stale; reject leaves text alone", () => {
  const { db, human, agent } = setup();
  const doc = createDocument(db, human, { title: "t", filename: "a.txt", text: "alpha beta gamma", reviewerAgentId: agent.id });
  const t = createThread(db, human, doc.id, { quote: "beta gamma", body: "fix" });
  const s1 = createSuggestion(db, agent, t.id, { replacement: "BETA", quote: "beta" });
  const s2 = createSuggestion(db, agent, t.id, { replacement: "B G" });
  const s3 = createSuggestion(db, agent, t.id, { replacement: "GAMMA", quote: "gamma" });
  decideSuggestion(db, human, s3.id, "reject");
  decideSuggestion(db, human, s1.id, "accept");
  const view = documentView(db, human, doc.id);
  assert.equal(view.text, "alpha BETA gamma");
  const statuses = Object.fromEntries(view.threads[0].suggestions.map((s) => [s.id, s.status]));
  assert.equal(statuses[s2.id], "stale");
  assert.equal(statuses[s3.id], "rejected");
  assert.throws(() => decideSuggestion(db, human, s2.id, "accept"), (e: ReviewError) => e.code === "already_decided");
});

test("non-overlapping pending suggestion still applies after another accept", () => {
  const { db, human, agent } = setup();
  const doc = createDocument(db, human, { title: "t", filename: "a.tex", text: "\\section{Intro} Foo bar. Baz qux.", reviewerAgentId: agent.id });
  assert.equal(doc.kind, "latex");
  const t1 = createThread(db, human, doc.id, { quote: "Foo bar.", body: "x" });
  const t2 = createThread(db, human, doc.id, { quote: "Baz qux.", body: "y" });
  const s1 = createSuggestion(db, agent, t1.id, { replacement: "Foo is a longer bar." });
  const s2 = createSuggestion(db, agent, t2.id, { replacement: "Baz." });
  decideSuggestion(db, human, s1.id, "accept");
  decideSuggestion(db, human, s2.id, "accept");
  assert.equal(documentView(db, human, doc.id).text, "\\section{Intro} Foo is a longer bar. Baz.");
});

test("new full version re-anchors threads and orphans vanished ones", () => {
  const { db, human, agent } = setup();
  const doc = createDocument(db, human, { title: "t", filename: "a.md", text: "one two three", reviewerAgentId: agent.id });
  const keep = createThread(db, human, doc.id, { quote: "three", body: "k" });
  const gone = createThread(db, human, doc.id, { quote: "two", body: "g" });
  const s = createSuggestion(db, agent, gone.id, { replacement: "2" });
  addVersion(db, agent, doc.id, { text: "zero one three", note: "rewrite" });
  const view = documentView(db, human, doc.id);
  const k = view.threads.find((t) => t.id === keep.id)!;
  assert.equal(view.text!.slice(k.anchor.start, k.anchor.end), "three");
  const g = view.threads.find((t) => t.id === gone.id)!;
  assert.equal(g.status, "orphaned");
  assert.equal(g.suggestions.find((x) => x.id === s.id)!.status, "stale");
});

test("documents are invisible across servers", () => {
  const { db, human, outsider } = setup();
  const doc = createDocument(db, human, { title: "t", filename: "a.md", text: "secret" });
  assert.throws(() => documentView(db, outsider, doc.id), (e: ReviewError) => e.status === 404);
  assert.throws(() => createThread(db, outsider, doc.id, { quote: "secret", body: "x" }), (e: ReviewError) => e.status === 404);
});

test("stale anchors are refused", () => {
  const { db, human } = setup();
  const doc = createDocument(db, human, { title: "t", filename: "a.md", text: "hello world" });
  assert.throws(
    () => createThread(db, human, doc.id, { start: 0, end: 5, quote: "world", body: "x" }),
    (e: ReviewError) => e.code === "anchor_moved",
  );
  assert.throws(() => createThread(db, human, doc.id, { quote: "nope", body: "x" }), (e: ReviewError) => e.code === "quote_not_found");
});

test("PDF accept records the decision without editing text", () => {
  const { db, human, agent } = setup();
  const doc = createDocument(db, human, {
    title: "paper", filename: "paper.pdf", text: "Abstract text\fPage two claim", file: new Uint8Array([37, 80, 68, 70]), reviewerAgentId: agent.id,
  });
  const t = createThread(db, human, doc.id, { quote: "claim", body: "cite?" });
  const view0 = documentView(db, human, doc.id);
  assert.equal((view0.threads[0].anchor as { page?: number }).page, 2);
  const s = createSuggestion(db, agent, t.id, { replacement: "claim [12]" });
  decideSuggestion(db, human, s.id, "accept");
  const view = documentView(db, human, doc.id);
  assert.equal(view.text, "Abstract text\fPage two claim");
  assert.equal(view.threads[0].suggestions[0].status, "accepted");
  assert.equal(view.current_version, 1);
});
