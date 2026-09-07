import assert from "node:assert/strict";
import test from "node:test";
import { journalPhotoOrientation, planJournalPhotoRows, planJournalPhotoPages, journalPhotoDisplaySize, journalPhotoPlacement, positionJournalPhoto, type JournalPhotoLayoutItem } from "../lib/journal-photo-layout.ts";

test("photo offsets default to center and move within a fixed clipping frame", () => {
  assert.deepEqual(journalPhotoPlacement(100, 100, 300, 200), { width: 200, height: 200, x: 50, y: 0 });
  const setting = { mode: "original" as const, scale: 0.5, offsetX: 0.25, offsetY: -0.5 };
  assert.deepEqual(journalPhotoPlacement(100, 100, 300, 200, setting), { width: 100, height: 100, x: 175, y: -50 });
  assert.deepEqual(journalPhotoPlacement(100, 100, 600, 400, setting), { width: 200, height: 200, x: 350, y: -100 });
});

test("moving and centering preserve mode and scale without mutating settings", () => {
  const original = Object.freeze({ mode: "portrait" as const, scale: 0.65, offsetX: 0.2, offsetY: -0.1 });
  const moved = positionJournalPhoto(original, 0.3, -0.4);
  assert.deepEqual(moved, { ...original, offsetX: 0.3, offsetY: -0.4 });
  assert.deepEqual(positionJournalPhoto(moved), { ...original, offsetX: 0, offsetY: 0 });
  assert.deepEqual(positionJournalPhoto(original, 10, -10), { ...original, offsetX: 0.5, offsetY: -0.5 });
  assert.equal(original.offsetX, 0.2);
  assert.equal(original.offsetY, -0.1);
});

const items = (orientations: Array<"portrait" | "landscape">): JournalPhotoLayoutItem<number>[] =>
  orientations.map((orientation, value) => ({ value, width: orientation === "portrait" ? 900 : 1600, height: orientation === "portrait" ? 1600 : 900 }));

test("journal pages preserve every photo and first-page 1+3+2 for zero through nineteen photos", () => {
  for (let count = 0; count <= 19; count++) {
    const source = items(Array.from({ length: count }, (_, index) => index % 2 ? "portrait" : "landscape"));
    const snapshot = structuredClone(source);
    const pages = planJournalPhotoPages(source);
    assert.deepEqual(pages.flat(), source);
    assert.ok(pages.every((page) => page.length <= 6));
    if (count >= 6) assert.deepEqual([1, ...planJournalPhotoRows(pages[0].slice(1)).map((row) => row.length)], [1, 3, 2]);
    for (const page of pages.slice(1)) assert.deepEqual(planJournalPhotoRows(page).flat(), page);
    assert.deepEqual(source, snapshot);
  }
});

test("export sizing preserves original proportions and independently applies mode and scale", () => {
  const original = journalPhotoDisplaySize(1600, 900, 300, 250);
  assert.deepEqual(original, { width: 300, height: 169 });
  const setting = Object.freeze({ mode: "portrait" as const, scale: 0.5 });
  const portrait = journalPhotoDisplaySize(1600, 900, 300, 250, setting);
  assert.deepEqual(portrait, { width: 94, height: 53 });
  const landscape = journalPhotoDisplaySize(900, 1600, 300, 250, { mode: "landscape", scale: 1 });
  assert.deepEqual(landscape, { width: 127, height: 225 });
  assert.deepEqual(journalPhotoDisplaySize(1600, 900, 300, 250), original);
  assert.deepEqual(journalPhotoDisplaySize(1600, 900, 300, 250, { mode: "original", scale: 2 }), original);
});

test("journal photo orientation treats square photos as landscape-neutral", () => {
  assert.equal(journalPhotoOrientation(900, 1600), "portrait");
  assert.equal(journalPhotoOrientation(1600, 900), "landscape");
  assert.equal(journalPhotoOrientation(1000, 1000), "landscape");
});

test("six portrait photos keep first plus three and two rows", () => {
  const remaining = items(["portrait", "portrait", "portrait", "portrait", "portrait"]);
  assert.deepEqual(planJournalPhotoRows(remaining).map((row) => row.length), [3, 2]);
});

test("six landscape photos keep first plus three and two rows", () => {
  const remaining = items(["landscape", "landscape", "landscape", "landscape", "landscape"]);
  assert.deepEqual(planJournalPhotoRows(remaining).map((row) => row.length), [3, 2]);
});

test("mixed rows keep fixed columns and preserve source", () => {
  const source = items(["portrait", "portrait", "landscape", "portrait", "portrait"]);
  const snapshot = source.map((item) => ({ ...item }));
  const rows = planJournalPhotoRows(source);
  assert.deepEqual(rows.flat().map((item) => item.value), source.map((item) => item.value));
  assert.deepEqual(rows.map((row) => row.length), [3, 2]);
  assert.deepEqual(source, snapshot);
});

test("a following page keeps at most six photos without inventing cells", () => {
  const page = items(["landscape", "portrait", "portrait", "landscape", "portrait", "landscape"]);
  const rows = planJournalPhotoRows(page);
  assert.equal(rows.flat().length, 6);
  assert.ok(rows.every((row) => row.length >= 1 && row.length <= 3));
});
