import test from "node:test";
import assert from "node:assert/strict";
import { importableUnitRows, importProductKey, safeImportedEstimated } from "../lib/unit-import.ts";

const row = (change: Partial<{ hasData: boolean; duplicate: boolean; model: string; colorNo: string }> = {}) => ({
  hasData: true,
  duplicate: false,
  model: "SPC-01",
  colorNo: "C01",
  ...change,
});

test("complete and incomplete unit rows remain importable while blank and duplicate rows do not", () => {
  const complete = row();
  const incomplete = row({ model: "", colorNo: "" });
  const blank = row({ hasData: false, model: "", colorNo: "" });
  const duplicate = row({ duplicate: true });
  assert.deepEqual(importableUnitRows([complete, incomplete, blank, duplicate]), [complete, incomplete]);
});

test("31 meaningful partial rows create 31 importable units", () => {
  const rows = Array.from({ length: 31 }, (_, index) => row({
    model: index % 3 === 0 ? "" : `SPC-${index}`,
    colorNo: index % 4 === 0 ? "" : `C-${index}`,
  }));
  assert.equal(importableUnitRows(rows).length, 31);
});

test("missing or invalid imported area uses zero and never NaN", () => {
  assert.equal(safeImportedEstimated(Number.NaN), 0);
  assert.equal(safeImportedEstimated(Number.POSITIVE_INFINITY), 0);
  assert.equal(safeImportedEstimated(-1), 0);
  assert.equal(safeImportedEstimated(20.5), 20.5);
  assert.equal(Number.isNaN(safeImportedEstimated(Number.NaN)), false);
});

test("a shared product requires both model and color number", () => {
  assert.equal(importProductKey(row()), "SPC-01|C01");
  assert.equal(importProductKey(row({ model: "" })), null);
  assert.equal(importProductKey(row({ colorNo: "" })), null);
});
