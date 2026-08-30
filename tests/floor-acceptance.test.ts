import test from "node:test";
import assert from "node:assert/strict";
import {
  canCompleteFloorAcceptance,
  batchCompletionCopyDescriptors,
  buildUnitScopedRecord,
  createFloorReturnContext,
  floorAcceptanceSummary,
  floorBatchExportable,
  floorBatchSelectableIds,
  floorIdentity,
  floorUnitNeedsAction,
  floorUnitSignatureCount,
  floorUnitSignatures,
  floorUnitAcceptanceState,
  floorUnitsFor,
  floorWorkbenchSummary,
  nextPendingFloorUnitId,
  resolveFloorSignatures,
  resolveUnitSignatures,
  updateLatestFormalAcceptanceSignature,
  updateUnitScopedRecord,
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
  assert.deepEqual(floorUnitsFor([...units, { ...unit("deleted"), _deleted: true }], "A棟", "14F").map((item) => item.id), units.filter((item) => item.building === "A棟").map((item) => item.id));
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

test("floor batch export selects only formal acceptances and keeps incomplete signatures selectable", () => {
  const formal = unit("formal", "A棟", "14F", [acceptance("a1", ["合格"], { completion: { signatures: { office: signature("office") } } })]);
  const conflicted = unit("conflicted", "A棟", "14F", [acceptance("a2", ["合格"], { completion: { signatures: { office: signature("other") } } })]);
  const draftOnly = unit("draft", "A棟", "14F", [acceptance("draft-a", ["合格"], { draft: true })]);
  const otherFloor = unit("other-floor", "A棟", "15F", [acceptance("a3", ["合格"])]);
  const scoped = floorUnitsFor([formal, conflicted, draftOnly, otherFloor], "A棟", "14F");
  assert.equal(floorBatchExportable(formal), true);
  assert.equal(floorBatchExportable(draftOnly), false);
  assert.deepEqual(floorBatchSelectableIds(scoped), ["formal", "conflicted"]);
});

test("per-unit document signatures never inherit floor or sibling signatures", () => {
  const ownInstaller = signature("a1-installer"), ownOffice = signature("a1-office"), ownManager = signature("a1-manager");
  const a1 = unit("a1", "A棟", "14F", [acceptance("a1-final", ["合格"], { completion: { signatures: { installer: ownInstaller, office: ownOffice, siteManager: ownManager } } })]);
  const a2 = unit("a2", "A棟", "14F", [acceptance("a2-final", ["合格"], { completion: { signatures: {} } })]);
  const a3Installer = signature("a3-installer");
  const a3 = unit("a3", "A棟", "14F", [acceptance("a3-final", ["合格"], { completion: { signatures: { installer: a3Installer } } })]);
  const source = structuredClone([a1, a2, a3]);

  assert.deepEqual(floorUnitSignatures(a1), { installer: ownInstaller, office: ownOffice, siteManager: ownManager });
  assert.equal(floorUnitSignatureCount(a1), 3);
  assert.equal(floorUnitSignatures(a1).supervisor, undefined);
  assert.deepEqual(floorUnitSignatures(a2), {});
  assert.equal(floorUnitSignatureCount(a2), 0);
  assert.equal(floorUnitSignatures(a1).installer?.name, "a1-installer");
  assert.equal(floorUnitSignatures(a3).installer?.name, "a3-installer");
  assert.deepEqual([a1, a2, a3], source);
});

test("floor batch drafts update independently without mutating source values", () => {
  const units = [{ id: "u1", name: "one" }, { id: "u2", name: "two" }];
  const source = structuredClone(units);
  const drafts = buildUnitScopedRecord(units, (item) => ({ projectName: item.name, floorAbnormal: false }));
  const next = updateUnitScopedRecord(drafts, "u2", (draft) => ({ ...draft, projectName: "edited", floorAbnormal: true }));
  assert.deepEqual(drafts.u1, { projectName: "one", floorAbnormal: false });
  assert.deepEqual(next.u1, drafts.u1);
  assert.deepEqual(next.u2, { projectName: "edited", floorAbnormal: true });
  assert.deepEqual(units, source);
});

test("two selected units produce exactly six three-copy descriptors", () => {
  const copies = batchCompletionCopyDescriptors(["u1", "u2"], ["客戶", "公司", "廠商"]);
  assert.equal(copies.length, 6);
  assert.deepEqual(copies.map((item) => item.unitId), ["u1", "u1", "u1", "u2", "u2", "u2"]);
});

test("floor workbench pending covers formal result, items, and four independent signatures", () => {
  const four = { installer: signature("i"), office: signature("o"), siteManager: signature("m"), supervisor: signature("s") };
  assert.equal(floorUnitNeedsAction(unit("none")), true);
  assert.equal(floorUnitNeedsAction(unit("draft", "A棟", "14F", [acceptance("draft", ["合格"], { draft: true, completion: { signatures: four } })])), true);
  assert.equal(floorUnitNeedsAction(unit("result", "A棟", "14F", [acceptance("result", ["合格"], { result: "部分合格", completion: { signatures: four } })])), true);
  assert.equal(floorUnitNeedsAction(unit("empty", "A棟", "14F", [acceptance("empty", [], { result: "合格", completion: { signatures: four } })])), true);
  assert.equal(floorUnitNeedsAction(unit("item", "A棟", "14F", [acceptance("item", ["合格", "不合格"], { result: "合格", completion: { signatures: four } })])), true);
  const three = { installer: four.installer, office: four.office, siteManager: four.siteManager };
  assert.equal(floorUnitSignatureCount(unit("three", "A棟", "14F", [acceptance("three", ["合格"], { completion: { signatures: three } })])), 3);
  assert.equal(floorUnitNeedsAction(unit("three", "A棟", "14F", [acceptance("three", ["合格"], { completion: { signatures: three } })])), true);
  assert.equal(floorUnitNeedsAction(unit("complete", "A棟", "14F", [acceptance("complete", ["合格"], { completion: { signatures: four } })])), false);
});

test("next pending skips complete units, stays in the supplied floor list, and wraps", () => {
  const four = { installer: signature("i"), office: signature("o"), siteManager: signature("m"), supervisor: signature("s") };
  const complete = (id: string, building = "A棟") => unit(id, building, "14F", [acceptance(`a-${id}`, ["合格"], { completion: { signatures: four } })]);
  const floor = [complete("u1"), complete("u2"), unit("u3"), complete("u4")];
  assert.equal(nextPendingFloorUnitId(floor, "u1"), "u3");
  assert.equal(nextPendingFloorUnitId(floor, "u3"), null);
  assert.equal(nextPendingFloorUnitId([complete("u1"), complete("u2")], "u1"), null);
  assert.equal(nextPendingFloorUnitId(floorUnitsFor([...floor, unit("other", "B棟")], "A棟", "14F"), "u4"), "u3");
});

test("targeted acceptance signature update preserves unit, role siblings, acceptance content, and history", () => {
  const original = { installer: signature("i"), office: signature("o"), siteManager: signature("m") };
  const old = acceptance("old", ["不合格"], { startedAt: "2026-08-27", draft: false, note: "old" });
  const draft = acceptance("draft", ["合格"], { startedAt: "2026-08-29", draft: true, note: "draft" });
  const latest = acceptance("latest", ["合格"], { startedAt: "2026-08-28", note: "keep", photos: [{ id: "p" }], completion: { signatures: original, extra: "keep" } });
  const source: any = { ...unit("u1", "A棟", "14F", [old, latest, draft]), model: "M1", colorNo: "C1", estimated: 20 };
  const next = updateLatestFormalAcceptanceSignature(source, "supervisor", signature("s"));
  assert.notEqual(next, source);
  assert.equal(next.model, "M1");
  assert.equal(next.acceptances[0], old);
  assert.equal(next.acceptances[2], draft);
  assert.deepEqual(next.acceptances[1].items, latest.items);
  assert.deepEqual(next.acceptances[1].photos, latest.photos);
  assert.equal(next.acceptances[1].note, "keep");
  assert.equal(next.acceptances[1].completion.extra, "keep");
  assert.equal(next.acceptances[1].completion.signatures.installer, original.installer);
  assert.equal(next.acceptances[1].completion.signatures.office, original.office);
  assert.equal(next.acceptances[1].completion.signatures.siteManager, original.siteManager);
  assert.equal(next.acceptances[1].completion.signatures.supervisor?.name, "s");
  const withoutFormal = unit("none", "A棟", "14F", [draft]);
  assert.equal(updateLatestFormalAcceptanceSignature(withoutFormal, "office", signature("new")), withoutFormal);
});

test("explicit unit-id update changes only the selected unit and leaves floor records untouched", () => {
  const units: any[] = [
    unit("u1", "A棟", "14F", [acceptance("a1", ["合格"], { completion: { signatures: {} } })]),
    unit("u2", "A棟", "14F", [acceptance("a2", ["合格"], { completion: { signatures: {} } })]),
    unit("u3", "A棟", "14F", [acceptance("a3", ["合格"], { completion: { signatures: {} } })]),
  ];
  const floorAcceptances = [{ id: "floor-legacy", building: "A棟", floor: "14F", signatures: { office: signature("legacy") } }];
  const beforeFloor = structuredClone(floorAcceptances);
  const next = units.map((current) => current.id === "u2" ? updateLatestFormalAcceptanceSignature(current, "office", signature("target")) : current);
  assert.equal(next[0], units[0]);
  assert.notEqual(next[1], units[1]);
  assert.equal(next[2], units[2]);
  assert.equal(next[1].acceptances[0].completion.signatures.office.name, "target");
  assert.equal(next[0].acceptances[0].completion.signatures.office, undefined);
  assert.deepEqual(floorAcceptances, beforeFloor);
});

test("workbench summary reads each unit independently", () => {
  const four = { installer: signature("i"), office: signature("o"), siteManager: signature("m"), supervisor: signature("s") };
  const units = [
    { ...unit("u1", "A棟", "14F", [acceptance("a1", ["合格"], { completion: { signatures: four } })]), model: "SPC-A" },
    { ...unit("u2", "A棟", "14F", [acceptance("a2", ["合格"], { completion: { signatures: { installer: signature("i2") } } })]), model: "SPC-B" },
  ];
  assert.deepEqual(floorWorkbenchSummary(units), { total: 2, acceptanceComplete: 2, signaturesComplete: 1, pending: 1 });
  assert.equal((units[0] as any).model, "SPC-A");
  assert.equal((units[1] as any).model, "SPC-B");
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

test("sheet signatures prefer the unit and use floor legacy fallback only for missing roles", () => {
  const ownOffice = signature("unit-office"), ownInstaller = signature("unit-installer"), floorOffice = signature("floor-office"), floorSupervisor = signature("floor-supervisor");
  const target = unit("u1", "A棟", "14F", [acceptance("a1", ["合格"], { completion: { signatures: { office: ownOffice, installer: ownInstaller } } })]);
  const sibling = unit("u2", "A棟", "14F", [acceptance("a2", ["合格"], { completion: { signatures: { siteManager: signature("legacy-manager") } } })]);
  const record = { id: "f", building: "A棟", floor: "14F", signatures: { office: floorOffice, supervisor: floorSupervisor } };
  const resolved = resolveUnitSignatures(target, record, [target, sibling]);
  assert.equal(resolved.signatures.office, ownOffice);
  assert.equal(resolved.signatures.installer, ownInstaller);
  assert.equal(resolved.signatures.supervisor, floorSupervisor);
  assert.deepEqual(record.signatures, { office: floorOffice, supervisor: floorSupervisor });
});

test("unit signature removes only its own role from legacy conflicts", () => {
  const target = unit("u1", "A棟", "14F", [acceptance("a1", ["合格"], { completion: { signatures: { office: signature("own") } } })]);
  const sibling = unit("u2", "A棟", "14F", [acceptance("a2", ["合格"], { completion: { signatures: { installer: signature("i2"), office: signature("other") } } })]);
  const other = unit("u3", "A棟", "14F", [acceptance("a3", ["合格"], { completion: { signatures: { installer: signature("i3") } } })]);
  const resolved = resolveUnitSignatures(target, undefined, [target, sibling, other]);
  assert.equal(resolved.signatures.office?.name, "own");
  assert.doesNotMatch(resolved.conflicts.join(","), /office/);
  assert.match(resolved.conflicts.join(","), /installer/);
});

test("floor return context preserves group, filter, expansion, scroll, and target tab", () => {
  assert.deepEqual(createFloorReturnContext("A棟", "14F", "incomplete", false, 820, "sheet"), { building: "A棟", floor: "14F", filter: "incomplete", expanded: false, scrollY: 820, tab: "sheet" });
});
