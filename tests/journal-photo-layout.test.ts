import assert from "node:assert/strict";
import test from "node:test";
import { journalPhotoOrientation, planJournalPhotoRows, type JournalPhotoLayoutItem } from "../lib/journal-photo-layout.ts";

const items = (orientations: Array<"portrait" | "landscape">): JournalPhotoLayoutItem<number>[] =>
  orientations.map((orientation, value) => ({ value, width: orientation === "portrait" ? 900 : 1600, height: orientation === "portrait" ? 1600 : 900 }));

test("journal photo orientation treats square photos as landscape-neutral", () => {
  assert.equal(journalPhotoOrientation(900, 1600), "portrait");
  assert.equal(journalPhotoOrientation(1600, 900), "landscape");
  assert.equal(journalPhotoOrientation(1000, 1000), "landscape");
});

test("six portrait photos keep first plus three and two rows", () => {
  const remaining = items(["portrait", "portrait", "portrait", "portrait", "portrait"]);
  assert.deepEqual(planJournalPhotoRows(remaining).map((row) => row.length), [3, 2]);
});

test("six landscape photos keep first plus two, two, and one rows", () => {
  const remaining = items(["landscape", "landscape", "landscape", "landscape", "landscape"]);
  assert.deepEqual(planJournalPhotoRows(remaining).map((row) => row.length), [2, 2, 1]);
});

test("mixed rows never place a landscape photo in a three-column row and preserve source", () => {
  const source = items(["portrait", "portrait", "landscape", "portrait", "portrait"]);
  const snapshot = source.map((item) => ({ ...item }));
  const rows = planJournalPhotoRows(source);
  assert.deepEqual(rows.flat().map((item) => item.value), source.map((item) => item.value));
  assert.ok(rows.every((row) => row.length < 3 || row.every((item) => journalPhotoOrientation(item.width, item.height) === "portrait")));
  assert.deepEqual(source, snapshot);
});

test("a following page keeps at most six photos without inventing cells", () => {
  const page = items(["landscape", "portrait", "portrait", "landscape", "portrait", "landscape"]);
  const rows = planJournalPhotoRows(page);
  assert.equal(rows.flat().length, 6);
  assert.ok(rows.every((row) => row.length >= 1 && row.length <= 3));
});
