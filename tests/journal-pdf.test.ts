import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJournalPdf, journalPdfPhotoFrames, wrapJournalText } from "../lib/journal-pdf.ts";
import { journalPhotoPlacement } from "../lib/journal-photo-layout.ts";

test("PDF photo frames retain 1+3+2 and keep following-page images within A4", () => {
  assert.deepEqual(journalPdfPhotoFrames(6, true).map((frame) => frame.y), [100, 400, 400, 400, 670, 670]);
  for (const first of [true, false]) for (let count = 0; count <= 6; count++) {
    const frames = journalPdfPhotoFrames(count, first);
    assert.deepEqual(frames.map((frame) => frame.index), Array.from({ length: count }, (_, i) => i));
    assert.ok(frames.every((frame) => frame.x >= 0 && frame.x + frame.width <= 720 && frame.y + frame.height < 720 * 297 / 210));
  }
});

test("Chinese wrapping preserves text and explicit blank lines", () => {
  assert.deepEqual(wrapJournalText("工程工作日誌\n\n備註", 3, (value) => [...value].length), ["工程工", "作日誌", "", "備註"]);
});

test("real jsPDF produces PDF blob with photo pages, overflow text, and export-only offsets", async (t) => {
  const names = ["document", "fetch", "createImageBitmap"];
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  t.after(() => { for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name); } });
  const texts: string[] = [], draws: any[][] = [];
  let closed = 0;
  const png = "data:image/png;base64," + readFileSync(new URL("../public/shen-yin-logo.png", import.meta.url)).toString("base64");
  const context = { scale() {}, fillRect() {}, fillText(text: string) { texts.push(text); },
    measureText: (text: string) => ({ width: [...text].length * 15 }), drawImage(...args: any[]) { draws.push(args); },
    save() {}, beginPath() {}, rect() {}, clip() {}, restore() {} };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { fonts: { ready: Promise.resolve() },
    createElement: () => ({ nodeName: "CANVAS", nodeType: 1, width: 0, height: 0, getContext: () => context, toDataURL: () => png }) } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => ({ ok: true, blob: async () => new Blob() }) });
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: async () => ({ width: 100, height: 100, close() { closed++; } }) });
  const photos = Array.from({ length: 7 }, (_, index) => Object.freeze({ id: String(index), data: "original-photo" }));
  const setting = { mode: "portrait" as const, scale: 0.5, offsetX: 0.25, offsetY: -0.2 };
  const blob = await createJournalPdf(["中文備註".repeat(200)], photos, { "0": setting });
  assert.equal(blob.type, "application/pdf");
  const pdf = await blob.text();
  assert.ok(pdf.startsWith("%PDF-"));
  assert.equal((pdf.match(/\/Type \/Page\b/g) || []).length, 3);
  assert.ok(texts.includes("SPC 工程工作日誌"));
  assert.ok(texts.includes("日誌文字（續）"));
  const placement = journalPhotoPlacement(100, 100, 310, 280, setting);
  assert.deepEqual(draws[1].slice(1), [362 + placement.x, 100 + placement.y, placement.width, placement.height]);
  assert.equal(closed, 8);
  assert.ok(photos.every((photo) => photo.data === "original-photo"));
});
