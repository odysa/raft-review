import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEdit, approxSearch, contextFor, findQuote, mapSpanThroughEdit, pageOf, reanchor, reanchorDetailed } from "../src/anchor.ts";

test("span before an edit is unchanged, span after shifts", () => {
  const edit = { start: 10, end: 15, insertLength: 2 }; // delta -3
  assert.deepEqual(mapSpanThroughEdit({ start: 0, end: 10 }, edit), { start: 0, end: 10 });
  assert.deepEqual(mapSpanThroughEdit({ start: 15, end: 20 }, edit), { start: 12, end: 17 });
});

test("overlapping span grows to cover the replacement", () => {
  const edit = { start: 10, end: 15, insertLength: 8 }; // delta +3
  assert.deepEqual(mapSpanThroughEdit({ start: 12, end: 20 }, edit), { start: 10, end: 23 });
  assert.deepEqual(mapSpanThroughEdit({ start: 5, end: 12 }, edit), { start: 5, end: 18 });
  assert.deepEqual(mapSpanThroughEdit({ start: 11, end: 13 }, edit), { start: 10, end: 18 });
  assert.deepEqual(mapSpanThroughEdit({ start: 5, end: 25 }, edit), { start: 5, end: 28 });
});

test("insertion right before a span shifts it", () => {
  assert.deepEqual(mapSpanThroughEdit({ start: 4, end: 8 }, { start: 4, end: 4, insertLength: 3 }), { start: 7, end: 11 });
});

test("mapped spans keep pointing at the same words", () => {
  const text = "The quick brown fox jumps over the lazy dog.";
  const fox = findQuote(text, "fox")!;
  const lazy = findQuote(text, "lazy")!;
  const editSpan = findQuote(text, "quick brown")!;
  const next = applyEdit(text, editSpan, "slow");
  const edit = { ...editSpan, insertLength: 4 };
  const m1 = mapSpanThroughEdit(fox, edit);
  const m2 = mapSpanThroughEdit(lazy, edit);
  assert.equal(next.slice(m1.start, m1.end), "fox");
  assert.equal(next.slice(m2.start, m2.end), "lazy");
});

test("findQuote picks occurrence or nearest", () => {
  const text = "a b a b a";
  assert.deepEqual(findQuote(text, "a", { occurrence: 2 }), { start: 4, end: 5 });
  assert.deepEqual(findQuote(text, "a", { near: 7 }), { start: 8, end: 9 });
  assert.equal(findQuote(text, "z"), null);
  assert.equal(findQuote(text, "a", { occurrence: 4 }), null);
});

test("reanchor finds moved quote or reports orphan", () => {
  const anchor = { start: 4, end: 9, quote: "hello" };
  assert.deepEqual(reanchor("xx hello", anchor), { start: 3, end: 8 });
  assert.deepEqual(reanchor("abcdhello", anchor), { start: 4, end: 9 });
  assert.equal(reanchor("goodbye", anchor), null);
});

test("reanchor uses prefix/suffix context to pick the right repeated quote", () => {
  const before = "Intro. The model is fast. Results: the model is fast. End.";
  const start = before.lastIndexOf("model is fast");
  const anchor = { start, end: start + 13, quote: "model is fast", prefix: "Results: the ", suffix: ". End." };
  // A long insertion at the top moves both occurrences; the nearer-by-offset
  // one is now the first, but the context still identifies the second.
  const after = "A much longer new introduction paragraph. The model is fast. Results: the model is fast. End.";
  const span = reanchor(after, anchor)!;
  assert.equal(after.slice(span.start - 13, span.start), "Results: the ");
});

test("pageOf counts form feeds", () => {
  const text = "p1\fp2 text\fp3";
  assert.equal(pageOf(text, 0), 1);
  assert.equal(pageOf(text, 4), 2);
  assert.equal(pageOf(text, text.length - 1), 3);
});

function anchorFor(text: string, quote: string) {
  const start = text.indexOf(quote);
  const span = { start, end: start + quote.length };
  return { ...span, quote, ...contextFor(text, span) };
}

test("approxSearch finds a match within the error budget", () => {
  const hits = approxSearch("the quick brwn fox", "quick brown", 1);
  assert.ok(hits.some((h) => h.errors === 1 && "the quick brwn fox".slice(h.start, h.end) === "quick brwn"));
  assert.equal(approxSearch("nothing alike here", "quick brown", 2).length, 0);
});

test("lightly edited quote re-anchors fuzzily (Hypothesis-style)", () => {
  const v1 = "Intro paragraph.\n\nOur method outperforms all prior work on every benchmark.\n\nConclusion.";
  const anchor = anchorFor(v1, "outperforms all prior work on every benchmark");
  const v2 = "A new opening line was added here.\n\nIntro paragraph.\n\nOur method outperforms most prior work on every benchmark.\n\nConclusion.";
  const found = reanchorDetailed(v2, anchor)!;
  assert.equal(found.match, "fuzzy");
  assert.equal(v2.slice(found.span.start, found.span.end), "outperforms most prior work on every benchmark");
});

test("rewritten quote with unchanged surroundings anchors between the context", () => {
  const v1 = "Section two begins here. The results were extremely good overall. Section three starts now.";
  const anchor = anchorFor(v1, "The results were extremely good overall.");
  const v2 = "Section two begins here. We observe a 4% gain on two of three tasks. Section three starts now.";
  const found = reanchorDetailed(v2, anchor)!;
  assert.equal(found.match, "context");
  assert.equal(v2.slice(found.span.start, found.span.end), "We observe a 4% gain on two of three tasks.");
});

test("long quotes match by head and tail", () => {
  const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8).trim();
  const v1 = `Start.\n${para}\nEnd.`;
  const anchor = anchorFor(v1, para);
  const edited = para.replace("consectetur", "consecteture").replace(/elit\.$/, "elit!");
  const v2 = `Start, revised.\n${edited}\nEnd.`;
  const found = reanchorDetailed(v2, anchor)!;
  assert.equal(found.match, "fuzzy");
  assert.equal(v2.slice(found.span.start, found.span.end), edited);
});

test("a rewritten last sentence follows the edit using the document end as context", () => {
  const v1 = "Atlas is available today at no additional cost. In conclusion, Atlas is a game-changer.\n";
  const anchor = anchorFor(v1, "In conclusion, Atlas is a game-changer.");
  const v2 = "Atlas is available today at no additional cost. In short, it changes how teams review documents.\n";
  const found = reanchorDetailed(v2, anchor)!;
  assert.equal(found.match, "context");
  assert.equal(v2.slice(found.span.start, found.span.end), "In short, it changes how teams review documents.");
});

test("unrelated text still orphans", () => {
  const anchor = anchorFor("alpha beta gamma delta epsilon", "beta gamma delta");
  assert.equal(reanchor("completely different words in here", anchor), null);
});
