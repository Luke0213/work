import test from "node:test";
import assert from "node:assert/strict";
import {
  canCompleteFloorAcceptance,
  createFloorReturnContext,
  floorAcceptanceSummary,
  floorIdentity,
  floorUnitAcceptanceState,
  floorUnitsFor,
  resolveFloorSignatures,
  updateFloorSignature,
  type FloorAcceptanceUnit,
  type FloorSignature,
} from "../lib/floor-acceptance.ts";

const signature = (name: string): FloorSignature => ({ name, data: `data:${name}`, at: "2026-08-28", valid: true });
const acceptance = (id: string, results: string[], extra = {}) => ({ id, date: "2026-08-28", result: results.every((x) => x === "合格") ? "合格" : "不合格", items: results.map((result) => ({ result })), ...extra });
const unit = (id: string, building = "A棟", floor = "14F", acceptances: any[] = []): FloorAcceptanceUnit => ({ id, building, floor, acceptances });

test("floor identity and grouping include building and support arbitrary unit counts", () => {
  assert.notEqual(floorIdentity("A棟", "14F"), floorIdentity("B棟", "14F"));
  const units = Array.from({ length: 11 }, (_, index) => unit(`u${index}`, index === 10 ? "B棟" : "A棟"));
  assert.equal(floorUnitsFor(units, "A棟", "14F").length, 10);
  assert.equal(floorUnitsFor(units, "B棟", "14F").length, 1);
});

test("one, eight, and arbitrary-size floors use the same all-qualified rule", () => {
  for (const count of [1, 8, 13]) {
    const units = Array.from({ length: count }, (_, index) => unit(`u${index}`, "A棟", "14F", [acceptance(`a${index}`, ["合格", "合格"])]));
    assert.deepEqual(floorAcceptanceSummary(units), { total: count, qualified: count, needsAction: 0, uninspected: 0, allQualified: true });
  }
});

test("missing and draft acceptances are uninspected; latest formal all-pass acceptance qualifies", () => {
  assert.equal(floorUnitAcceptanceState(unit("none")), "uninspected");
  assert.equal(floorUnitAcceptanceState(unit("draft", "A棟", "14F", [acceptance("draft", ["合格"], { draft: true })])), "uninspected");
  assert.equal(floorUnitAcceptanceState(unit("ok", "A棟", "14F", [acceptance("old", ["不合格"], { startedAt: "2026-08-27T00:00:00Z" }), acceptance("new", ["合格"], { startedAt: "2026-08-28T00:00:00Z" })])), "qualified");
  assert.equal(floorUnitAcceptanceState(unit("bad", "A棟", "14F", [acceptance("bad", ["合格", "不合格"])])), "needsAction");
  assert.equal(floorUnitAcceptanceState(unit("empty", "A棟", "14F", [acceptance("empty", [])])), "needsAction");
});

test("floor completion requires every unit and all four valid signatures", () => {
  const units = [unit("u1", "A棟", "14F", [acceptance("a1", ["合格"])])];
  const three = { installer: signature("i"), office: signature("o"), siteManager: signature("m") };
  assert.equal(canCompleteFloorAcceptance(units, { signatures: three, conflicts: [] }), false);
  assert.equal(canCompleteFloorAcceptance(units, { signatures: { ...three, supervisor: signature("s") }, conflicts: [] }), true);
  assert.equal(canCompleteFloorAcceptance([...units, unit("u2")], { signatures: { ...three, supervisor: signature("s") }, conflicts: [] }), false);
});

test("four unique legacy signatures can complete without creating a floor record", () => {
  const legacy = { installer: signature("i"), office: signature("o"), siteManager: signature("m"), supervisor: signature("s") };
  const units = [unit("u1", "A棟", "14F", [acceptance("a1", ["合格"], { signature: legacy.office, completion: { signatures: legacy } })])];
  const before = structuredClone(units);
  const resolved = resolveFloorSignatures(undefined, units);
  assert.equal(canCompleteFloorAcceptance(units, resolved), true);
  assert.deepEqual(units, before);
  assert.deepEqual(resolved.signatures, legacy);
});

test("two floor and two unique legacy signatures can complete", () => {
  const legacy = { installer: signature("legacy-i"), office: signature("legacy-o"), siteManager: signature("legacy-m"), supervisor: signature("legacy-s") };
  const units = [unit("u1", "A棟", "14F", [acceptance("a1", ["合格"], { completion: { signatures: legacy } })])];
  const record = { id: "f", building: "A棟", floor: "14F", signatures: { installer: signature("floor-i"), office: signature("floor-o") } };
  const resolved = resolveFloorSignatures(record, units);
  assert.equal(resolved.signatures.installer?.name, "floor-i");
  assert.equal(resolved.signatures.siteManager?.name, "legacy-m");
  assert.equal(canCompleteFloorAcceptance(units, resolved), true);
  assert.deepEqual(record.signatures, { installer: signature("floor-i"), office: signature("floor-o") });
});

test("legacy conflict blocks completion until that role has an explicit floor signature", () => {
  const common = { installer: signature("i"), siteManager: signature("m"), supervisor: signature("s") };
  const units = [
    unit("u1", "A棟", "14F", [acceptance("a1", ["合格"], { signature: signature("office-one"), completion: { signatures: common } })]),
    unit("u2", "A棟", "14F", [acceptance("a2", ["合格"], { signature: signature("office-two"), completion: { signatures: common } })]),
  ];
  const conflicted = resolveFloorSignatures(undefined, units);
  assert.deepEqual(conflicted.conflicts, ["office"]);
  assert.equal(conflicted.signatures.office, undefined);
  assert.equal(canCompleteFloorAcceptance(units, conflicted), false);
  const resolved = resolveFloorSignatures({ id: "f", building: "A棟", floor: "14F", signatures: { office: signature("floor-office") } }, units);
  assert.deepEqual(resolved.conflicts, []);
  assert.equal(canCompleteFloorAcceptance(units, resolved), true);
});

test("updating one floor signature preserves the other three", () => {
  const original = { installer: signature("i"), office: signature("o"), siteManager: signature("m"), supervisor: signature("s") };
  assert.deepEqual(updateFloorSignature(original, "installer", signature("i2")), { ...original, installer: signature("i2") });
  assert.deepEqual(updateFloorSignature(original, "office", signature("o2")), { ...original, office: signature("o2") });
  assert.equal(updateFloorSignature(original, "office").installer?.name, "i");
});

test("floor signatures take priority while unique legacy signatures remain read-only fallback", () => {
  const legacyOffice = signature("legacy office"), legacyInstaller = signature("legacy installer");
  const units = [unit("u1", "A棟", "14F", [acceptance("a1", ["合格"], { signature: legacyOffice, completion: { signatures: { installer: legacyInstaller } } })])];
  const fallback = resolveFloorSignatures(undefined, units);
  assert.equal(fallback.signatures.office, legacyOffice);
  assert.equal(fallback.signatures.installer, legacyInstaller);
  const floorOffice = signature("floor office");
  assert.equal(resolveFloorSignatures({ id: "f", building: "A棟", floor: "14F", signatures: { office: floorOffice } }, units).signatures.office, floorOffice);
  assert.equal(units[0].acceptances?.[0].signature, legacyOffice);
});

test("conflicting legacy signatures are reported instead of selected or written", () => {
  const units = [unit("u1", "A棟", "14F", [acceptance("a1", ["合格"], { signature: signature("one") })]), unit("u2", "A棟", "14F", [acceptance("a2", ["合格"], { signature: signature("two") })])];
  const resolved = resolveFloorSignatures(undefined, units);
  assert.equal(resolved.signatures.office, undefined);
  assert.deepEqual(resolved.conflicts, ["office"]);
});

test("floor return context preserves group, filter, expansion, scroll, and target tab", () => {
  assert.deepEqual(createFloorReturnContext("A棟", "14F", "incomplete", false, 820, "sheet"), { building: "A棟", floor: "14F", filter: "incomplete", expanded: false, scrollY: 820, tab: "sheet" });
});
