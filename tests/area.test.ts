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

test("面積單位切換使用同一換算規則並合理四捨五入", () => {
  assert.equal(convertAreaInput("50.67", "m²", "坪"), "15.33");
  assert.equal(convertAreaInput("15.33", "坪", "m²"), "50.68");
  assert.equal(convertAreaInput("20", "坪", "m²"), "66.12");
  assert.equal(convertAreaInput("66.12", "m²", "坪"), "20");
});

test("空值、無效數字與相同單位切換保持安全", () => {
  assert.equal(convertAreaInput("", "m²", "坪"), "");
  assert.equal(convertAreaInput("不是數字", "m²", "坪"), "不是數字");
  assert.equal(convertAreaInput("50.67", "m²", "m²"), "50.67");
});

test("坪與平方公尺往返不產生明顯漂移", () => {
  const squareMeters = convertAreaInput("20", "坪", "m²");
  assert.equal(convertAreaInput(squareMeters, "m²", "坪"), "20");
});

test("Excel 坪欄位不換算，明確 m² 欄位才換算", () => {
  assert.equal(importedAreaToPing({ 坪數: "30" }), 30);
  assert.equal(importedAreaToPing({ 預估施工坪數: "20.5 坪" }), 20.5);
  assert.equal(importedAreaToPing({ "m²": "100" }), 30.25);
  assert.equal(importedAreaToPing({ 平方公尺: "50" }), 15.13);
  const canonicalPing = importedAreaToPing({ "m²": "100" });
  assert.equal(areaInputToPing(canonicalPing, "坪"), 30.25);
});
