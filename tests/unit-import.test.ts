import test from "node:test";
import assert from "node:assert/strict";
import { findExactUnitProduct, importableUnitRows, importProductKey, onboardingUnitRowIsValid, safeImportedEstimated } from "../lib/unit-import.ts";

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

test("onboarding allows SPC fields to remain pending while required unit fields still block", () => {
  const base = { building: "A", floor: "8F", number: "A1", model: "", colorNo: "" };
  assert.equal(onboardingUnitRowIsValid(base, 20), true);
  assert.equal(onboardingUnitRowIsValid({ ...base, model: "SPC-01" }, 20), true);
  assert.equal(onboardingUnitRowIsValid({ ...base, colorNo: "C01" }, 20), true);
  assert.equal(onboardingUnitRowIsValid({ ...base, building: "" }, 20), false);
  assert.equal(onboardingUnitRowIsValid({ ...base, floor: "" }, 20), false);
  assert.equal(onboardingUnitRowIsValid({ ...base, number: "" }, 20), false);
  assert.equal(onboardingUnitRowIsValid(base, Number.NaN), false);
  assert.equal(onboardingUnitRowIsValid(base, 0), false);
});

test("onboarding product lookup is exact, optional, and never guesses partial SPC data", () => {
  const products = [{ model: "SPC-01", colorNo: "C01", brand: "神銀", spec: "5mm" }];
  assert.deepEqual(findExactUnitProduct({ model: "SPC-01", colorNo: "C01" }, products), products[0]);
  assert.equal(findExactUnitProduct({ model: "SPC-01", colorNo: "" }, products), undefined);
  assert.equal(findExactUnitProduct({ model: "", colorNo: "C01" }, products), undefined);
  assert.equal(findExactUnitProduct({ model: "SPC-02", colorNo: "C02" }, products), undefined);
});
