import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyAcceptanceEntries } from "../lib/daily-acceptances.ts";
import { buildAcceptanceExportRecord, createShipmentWorkbook } from "../lib/acceptance-exports.ts";

const today = "2026-08-27";
const yesterday = "2026-08-26";
const unit = {
  id: "u1", building: "A", floor: "3F", number: "1", model: "M1", colorNo: "C1", estimated: 20,
  acceptances: [
    { id: "today-a", date: today, person: "甲", area: 20, result: "合格", note: "", draft: false },
    { id: "today-b", date: today, person: "乙", area: 21, result: "合格", note: "", recheck: true, draft: false },
    { id: "yesterday-a", date: yesterday, person: "甲", area: 19, result: "不合格", note: "", draft: false },
    { id: "draft", date: today, person: "草稿", area: 99, result: "合格", note: "", draft: true },
    { id: "today-a", date: today, person: "重複編輯", area: 20, result: "合格", note: "", draft: false },
  ],
};

test("daily acceptance keeps every final history record by its own date", () => {
  const entries = buildDailyAcceptanceEntries([unit]);
  assert.equal(entries.filter((entry) => entry.date === today).length, 2);
  assert.equal(entries.filter((entry) => entry.date === yesterday).length, 1);
  assert.equal(entries.some((entry) => entry.acceptance.id === "draft"), false);
  assert.equal(entries.filter((entry) => entry.acceptance.id === "today-a").length, 1);
});

test("single-day shipment export contains only that day and restarts serial at one", () => {
  const project = { name: "測試案場", units: [unit] };
  const entries = buildDailyAcceptanceEntries([unit]).filter((entry) => entry.date === yesterday);
  const records = entries.map((entry) => buildAcceptanceExportRecord(project, entry.unit, entry.acceptance, true));
  assert.deepEqual(records.map((record) => record.acceptanceDate), [yesterday]);
  assert.deepEqual(records.map((record) => record.exportDate), [yesterday]);
  const workbook = createShipmentWorkbook(project, records, "2026-08") as { Sheets: Record<string, Record<string, { v?: unknown }>> };
  assert.equal(workbook.Sheets["已出貨明細總表"]["B4"].v, 1);
});
