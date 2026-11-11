import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEdit, findQuote, mapSpanThroughEdit, pageOf, reanchor } from "../src/anchor.ts";

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

test("pageOf counts form feeds", () => {
  const text = "p1\fp2 text\fp3";
  assert.equal(pageOf(text, 0), 1);
  assert.equal(pageOf(text, 4), 2);
  assert.equal(pageOf(text, text.length - 1), 3);
});
