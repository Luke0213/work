import test from "node:test";
import assert from "node:assert/strict";
import {
  areaInputToPing,
  areaValueFromPing,
  convertAreaInput,
  importedAreaToPing,
} from "../lib/area.ts";

test("坪輸入與舊有 canonical estimated 保持為坪", () => {
  assert.equal(areaInputToPing(20.21, "坪"), 20.21);
  assert.equal(areaValueFromPing(20.21, "坪"), 20.21);
});

test("m² 輸入換算為坪並控制小數精度", () => {
  assert.equal(areaInputToPing(66.8, "m²"), 20.21);
});

test("坪切換 m² 再切回坪不會重複換算", () => {
  const squareMeters = convertAreaInput("20.21", "坪", "m²");
  assert.equal(squareMeters, "66.81");
  assert.equal(convertAreaInput(squareMeters, "m²", "坪"), "20.21");
});

test("Excel 坪欄位不換算，明確 m² 欄位才換算", () => {
  assert.equal(importedAreaToPing({ 坪數: "20.21" }), 20.21);
  assert.equal(importedAreaToPing({ "m²": "66.80" }), 20.21);
  assert.equal(importedAreaToPing({ 預估施工坪數: "20.21 坪" }), 20.21);
});
