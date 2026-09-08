import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyBillingChanges, applyCommittedReceivableSave, applyReceivableSharedFields, buildReceivableAcceptanceUpdates, canApplySharedReload, containsChanges, financeSnapshot, receivableSaveIsCommitted, rebaseProjectEdit, updateReportSource } from "../lib/finance-persistence.ts";
import { buildAcceptanceExportRecord, buildAcceptanceExportRecords, loadReceivableReportDraft, receivableReportMetadata, createShipmentWorkbook, shipmentDisplayValues } from "../lib/acceptance-exports.ts";
import { buildDailyAcceptanceEntries } from "../lib/daily-acceptances.ts";
import { threeWayMerge } from "../lib/three-way-merge.ts";

const project = { id: "p1", name: "Test", contact: "contact", address: "address", units: [{
  id: "u1", rate: 100, status: "已驗收", pricedAt: "", estimated: 10, events: [{ id: "old", title: "old" }],
  works: [{ date: "2026-09-01", area: 10 }],
  acceptances: [{ id: "a1", date: "2026-09-01", draft: false, report: { noteText: "old" }, photos: [{ id: "photo", data: "unchanged" }] }],
}] };
const changes = [{ unitId: "u1", rate: 2750, priced: true, event: { id: "e1", title: "月結已計價" } }];
const edit = () => applyBillingChanges(project, changes, "2026-09-07");
const reportDraft = { unitId: "u1", acceptanceId: "a1", noteText: "edited", amountText: "27500", outgoingVoOriginalDate: "2026-09-07", signedOriginal: true };
const reportEdit = () => ({ ...project, units: [updateReportSource(project.units[0], reportDraft)] });
const reload = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("Billing rate, priced status, date and event survive workspace serialization", () => {
  const saved = reload(edit());
  assert.equal(saved.units[0].rate, 2750);
  assert.equal(saved.units[0].status, "已計價");
  assert.equal(saved.units[0].pricedAt, "2026-09-07");
  assert.deepEqual(saved.units[0].events.map((e) => e.id), ["e1", "old"]);
  assert.equal(project.units[0].rate, 100);
  const unpriced = applyBillingChanges(saved, [{ ...changes[0], priced: false }], "2026-09-08");
  assert.equal(unpriced.units[0].status, "已驗收");
  assert.equal(unpriced.units[0].pricedAt, "");
});

test("Billing rate change updates the exact formal Acceptance.report price", () => {
  const protectedProject: any = {
    ...reload(project),
    units: [{
      ...reload(project.units[0]),
      rate: 2750,
      status: "已計價",
      pricedAt: "2026-09-01",
      acceptances: [
        {
          id: "a1", date: "2026-09-01", draft: false,
          report: { unitPriceText: "3000", noteText: "keep note", customText: "keep custom" },
          photos: [{ id: "photo", data: "spc-storage://same" }],
          items: [{ id: "item", result: "ok" }],
          completion: { id: "completion" },
          signatures: { customer: "signed" },
        },
        { id: "a2", date: "2026-08-01", draft: false, report: { unitPriceText: "2600" } },
      ],
    }, { ...reload(project.units[0]), id: "u2" }],
  };
  const record = buildAcceptanceExportRecords(protectedProject).find((item) => item.unitId === "u1")!;
  const saved = applyBillingChanges(protectedProject, [{ unitId: "u1", acceptanceId: record.acceptanceId, rate: 2800, priced: true, event: { id: "unused" } }], "2026-09-07");
  const acceptance = saved.units[0].acceptances[0];
  assert.equal(saved.units[0].rate, 2800);
  assert.equal(acceptance.report.unitPriceText, "2800");
  assert.equal(acceptance.report.noteText, "keep note");
  assert.equal(acceptance.report.customText, "keep custom");
  for (const field of ["photos", "items", "completion", "signatures", "date"] as const) {
    assert.deepEqual(acceptance[field], protectedProject.units[0].acceptances[0][field], field);
  }
  assert.deepEqual(saved.units[0].acceptances[1], protectedProject.units[0].acceptances[1]);
  assert.deepEqual(saved.units[0].events, protectedProject.units[0].events);
  assert.deepEqual(saved.units[1], protectedProject.units[1]);

  const rebuilt = buildAcceptanceExportRecord(saved, saved.units[0], acceptance, true);
  assert.equal(shipmentDisplayValues(rebuilt, 0).unitPriceText, "2800");
  assert.equal(loadReceivableReportDraft(saved, [rebuilt], "2026-09").details[0].unitPrice, "2800");
});

test("Billing status-only changes preserve the report price text", () => {
  const source: any = reload(project);
  source.units[0].rate = 2750;
  source.units[0].acceptances[0].report.unitPriceText = "3000";
  const saved = applyBillingChanges(source, [{ unitId: "u1", acceptanceId: "a1", rate: 2750, priced: true, event: { id: "status" } }], "2026-09-07");
  assert.equal(saved.units[0].acceptances[0].report.unitPriceText, "3000");
});

test("Billing permits work-only units without an acceptance and rejects a stale acceptance id", () => {
  const source: any = { ...reload(project), units: [{ ...reload(project.units[0]), acceptances: [] }] };
  const saved = applyBillingChanges(source, [{ unitId: "u1", acceptanceId: "", rate: 2800, priced: true, event: { id: "priced" } }], "2026-09-07");
  assert.equal(saved.units[0].rate, 2800);
  assert.deepEqual(saved.units[0].acceptances, []);
  assert.throws(() => applyBillingChanges(source, [{ unitId: "u1", acceptanceId: "missing", rate: 2800, priced: true, event: { id: "priced" } }], "2026-09-07"));
});

test("report is persisted only in Acceptance.report and preserves photos and other acceptances", () => {
  const unit = { ...project.units[0], acceptances: [...project.units[0].acceptances, { ...project.units[0].acceptances[0], id: "a2" }] };
  const edited = updateReportSource(unit, reportDraft);
  assert.equal(edited.acceptances[0].photos, unit.acceptances[0].photos);
  assert.equal(edited.acceptances[1], unit.acceptances[1]);
  assert.equal(reload(edited).acceptances[0].report.noteText, "edited");
  assert.equal("unitId" in edited.acceptances[0].report, false);
});

test("monthly and daily shipments rebuild and export the same persisted report", () => {
  const saved = reload(reportEdit());
  const monthly = buildAcceptanceExportRecords(saved);
  const daily = buildDailyAcceptanceEntries(saved.units).map(({ unit, acceptance }) => buildAcceptanceExportRecord(saved, unit, acceptance, true));
  for (const records of [monthly, daily]) {
    assert.equal(records[0].noteText, "edited");
    assert.equal(records[0].amountText, "27500");
    assert.equal(records[0].outgoingVoOriginalDate, "2026-09-07");
    const workbook = createShipmentWorkbook(saved, records, "2026-09");
    assert.ok(Object.values(workbook.Sheets[workbook.SheetNames[0]]).some((cell) => cell?.v === "edited"));
  }
});

test("receivable-only metadata survives close/reopen without owning shared detail fields", () => {
  const records = buildAcceptanceExportRecords(project);
  const draft = loadReceivableReportDraft(project, records, "2026-09");
  for (const key of Object.keys(draft).filter((k) => k !== "details")) (draft as any)[key] = `custom-${key}`;
  draft.details[0].sizeCm = "18x122";
  draft.details[0].quantity = "stale-shared-value";
  const saved = reload({ ...project, receivableReports: { "2026-09": receivableReportMetadata(draft, records) } });
  const reopened = loadReceivableReportDraft(saved, records, "2026-09");
  for (const key of Object.keys(draft).filter((key) => key !== "details")) {
    assert.equal((reopened as any)[key], (draft as any)[key], key);
  }
  assert.equal(reopened.details[0].sizeCm, "18x122");
  assert.equal(reopened.details[0].quantity, "10");
  assert.equal(loadReceivableReportDraft(saved, records, "2026-10").deliveryContact, "contact");
  const otherProject = { ...project, id: "p2" };
  assert.equal(loadReceivableReportDraft(otherProject, records, "2026-09").deliveryContact, "contact");
  assert.deepEqual(saved.units, project.units);
});

test("old projects use shipment defaults and receivable-only size follows unit identity", () => {
  const records = buildAcceptanceExportRecords(project);
  assert.equal(loadReceivableReportDraft(project, records, "2026-09").details[0].unitPrice, "100");
  const draft = loadReceivableReportDraft(project, records, "2026-09");
  draft.details[0].sizeCm = "u1 size";
  const saved = { ...project, receivableReports: { "2026-09": receivableReportMetadata(draft, records) } };
  const reopened = loadReceivableReportDraft(saved, [{ ...records[0], unitId: "u2" }, ...records], "2026-09");
  assert.equal(reopened.details[0].note, "old");
  assert.equal(reopened.details[0].sizeCm, "");
  assert.equal(reopened.details[1].sizeCm, "u1 size");
});

test("newer shipment fields win over legacy receivable shared details", () => {
  const shipped: any = reportEdit();
  shipped.units[0].acceptances[0].report.pingText = "25";
  shipped.receivableReports = { "2026-09": {
    ...receivableReportMetadata(loadReceivableReportDraft(shipped, buildAcceptanceExportRecords(shipped), "2026-09"), buildAcceptanceExportRecords(shipped)),
    detailsByUnit: { u1: { quantity: "18", unitPrice: "900", note: "legacy", sizeCm: "18x122" } },
  } };
  const records = buildAcceptanceExportRecords(shipped);
  const reopened = loadReceivableReportDraft(shipped, records, "2026-09");
  assert.equal(reopened.details[0].quantity, "25");
  assert.equal(reopened.details[0].unitPrice, "100");
  assert.equal(reopened.details[0].note, "edited");
  assert.equal(reopened.details[0].sizeCm, "18x122");
});

test("receivable shared edits update the exact formal Acceptance.report", () => {
  const source: any = reportEdit();
  source.units[0].acceptances[0].report.unitPriceText = "1000";
  const records = buildAcceptanceExportRecords(source);
  const original = loadReceivableReportDraft(source, records, "2026-09");
  const edited = reload(original);
  edited.details[0] = { ...edited.details[0], date: "115.09.07", model: "M2", unitDisplay: "B 2 3",
    quantity: "20", unitPrice: "1200", note: "應收同步備註", sizeCm: "18x122" };
  const saved = applyReceivableSharedFields(source, records, original.details, edited.details);
  const rebuilt = buildAcceptanceExportRecords(saved)[0];
  const display = shipmentDisplayValues(rebuilt, 0);
  assert.equal(display.shipmentDateText, "115.09.07");
  assert.equal(display.productText, "M2");
  assert.equal(display.unitDisplayText, "B 2 3");
  assert.equal(display.pingText, "20");
  assert.equal(display.unitPriceText, "1200");
  assert.equal(display.noteText, "應收同步備註");
  assert.equal(rebuilt.amountText, "27500");
});

test("receivable shared save fails closed and preserves unrelated acceptance data", () => {
  const protectedProject: any = reload({ ...project, units: [
    { ...project.units[0], acceptances: [{ ...project.units[0].acceptances[0],
      items: [{ id: "item", result: "ok" }], completion: { id: "completion" }, photos: [{ id: "photo", data: "spc-storage://same" }],
    }] },
    { ...project.units[0], id: "u2" },
  ] });
  const records = buildAcceptanceExportRecords(protectedProject).filter((record) => record.unitId === "u1");
  const original = loadReceivableReportDraft(protectedProject, records, "2026-09");
  const edited = reload(original);
  edited.details[0].note = "new note";
  const saved = applyReceivableSharedFields(protectedProject, records, original.details, edited.details);
  assert.deepEqual(saved.units[0].acceptances[0].photos, protectedProject.units[0].acceptances[0].photos);
  assert.deepEqual(saved.units[0].acceptances[0].items, protectedProject.units[0].acceptances[0].items);
  assert.deepEqual(saved.units[0].acceptances[0].completion, protectedProject.units[0].acceptances[0].completion);
  assert.deepEqual(saved.units[1], protectedProject.units[1]);
  assert.deepEqual(saved.units[0].events, protectedProject.units[0].events);
  assert.throws(() => applyReceivableSharedFields(protectedProject, [{ ...records[0], acceptanceId: "missing" }], original.details, edited.details));
  assert.throws(() => applyReceivableSharedFields(protectedProject, [{ ...records[0], unitId: "missing" }], original.details, edited.details));
  assert.throws(() => applyReceivableSharedFields(protectedProject, records, [], edited.details));
});

test("targeted receivable payload and committed DTO cover only changed report fields", () => {
  const source: any = reload({ ...project, units: [
    { ...project.units[0], acceptances: [{ ...project.units[0].acceptances[0], report: { noteText: "old", vendorText: "keep" } }] },
    { ...project.units[0], id: "u2", acceptances: [{ ...project.units[0].acceptances[0], id: "a2" }] },
  ] });
  const records = buildAcceptanceExportRecords(source).filter((record) => record.unitId === "u1");
  const original = loadReceivableReportDraft(source, records, "2026-09");
  const edited = reload(original);
  edited.details[0].note = "new note";
  edited.details[0].unitPrice = "1200";
  edited.details[0].sizeCm = "18x122";
  const acceptances = buildReceivableAcceptanceUpdates(records, original.details, edited.details);
  assert.deepEqual(acceptances, [{ unitId: "u1", acceptanceId: "a1", fields: { unitPriceText: "1200", noteText: "new note" } }]);
  const report = receivableReportMetadata(edited, records);
  const committed = { version: 8, projectId: "p1", yearMonth: "2026-09", report, acceptances };
  assert.equal(receivableSaveIsCommitted({ projectId: "p1", yearMonth: "2026-09", report, acceptances }, committed), true);
  assert.equal(receivableSaveIsCommitted({ projectId: "p1", yearMonth: "2026-09", report, acceptances }, { ...committed, acceptances: [] }), false);
  const saved: any = applyCommittedReceivableSave(source, committed);
  assert.equal(saved.receivableReports["2026-09"].detailsByUnit.u1.sizeCm, "18x122");
  assert.equal(saved.units[0].acceptances[0].report.unitPriceText, "1200");
  assert.equal(saved.units[0].acceptances[0].report.noteText, "new note");
  assert.equal(saved.units[0].acceptances[0].report.vendorText, "keep");
  assert.deepEqual(saved.units[0].acceptances[0].photos, source.units[0].acceptances[0].photos);
  assert.deepEqual(saved.units[1], source.units[1]);
});

test("receivable-only metadata remains scoped by month", () => {
  const records = buildAcceptanceExportRecords(project);
  const september = loadReceivableReportDraft(project, records, "2026-09");
  const october = loadReceivableReportDraft(project, records, "2026-10");
  september.receivedAmount = "9000";
  september.receivedDate = "2026-09-30";
  september.preparedBy = "Amy";
  october.receivedAmount = "10000";
  const saved = { ...project, receivableReports: {
    "2026-09": receivableReportMetadata(september, records),
    "2026-10": receivableReportMetadata(october, records),
  } };
  assert.equal(loadReceivableReportDraft(saved, records, "2026-09").receivedAmount, "9000");
  assert.equal(loadReceivableReportDraft(saved, records, "2026-09").preparedBy, "Amy");
  assert.equal(loadReceivableReportDraft(saved, records, "2026-10").receivedAmount, "10000");
  assert.equal(loadReceivableReportDraft(saved, records, "2026-10").preparedBy, "");
});

test("a stale project edit preserves concurrent report, other units and history", () => {
  const remote = { ...reportEdit(), units: [...reportEdit().units, { ...project.units[0], id: "u2" }] };
  const result = rebaseProjectEdit(project, edit(), remote);
  assert.equal(result.units[0].rate, 2750);
  assert.equal(result.units[0].acceptances[0].report.noteText, "edited");
  assert.equal(result.units[1].id, "u2");
  assert.throws(() => rebaseProjectEdit(project, edit(), { ...project, units: [{ ...project.units[0], rate: 999 }] }));
});

test("in-flight refresh rechecks state after a Billing or report edit", async () => {
  for (const edited of [edit(), reportEdit()]) {
    let current = project;
    assert.equal(canApplySharedReload(false, current, project), true);
    const remote = Promise.resolve(project);
    current = edited;
    const response = await remote;
    if (canApplySharedReload(false, current, project)) current = response;
    assert.deepEqual(current, edited);
  }
  assert.equal(canApplySharedReload(true, project, project), false);
  assert.equal(canApplySharedReload(false, project, project, true), false);
});

test("version success alone cannot verify missing rate, pricing, event or report data", () => {
  const intended = { ...edit(), units: [updateReportSource(edit().units[0], reportDraft)] };
  const base = financeSnapshot([project]), next = financeSnapshot([intended]);
  assert.equal(containsChanges(base, next, financeSnapshot([reload(intended)])), true);
  for (const key of ["rate", "status", "pricedAt", "events", "acceptances"] as const) {
    const missing = reload(intended);
    (missing.units[0] as any)[key] = project.units[0][key];
    const rpcResult = { version: 394, projects: [missing] };
    assert.equal(containsChanges(base, next, financeSnapshot(rpcResult.projects)), false, key);
  }
});

test("verification covers Acceptance.report and receivableReports in one intended save", () => {
  const records = buildAcceptanceExportRecords(project);
  const original = loadReceivableReportDraft(project, records, "2026-09");
  const edited = reload(original);
  edited.details[0].unitPrice = "1200";
  edited.receivedAmount = "12000";
  const withShared = applyReceivableSharedFields(project, records, original.details, edited.details);
  const intended = { ...withShared, receivableReports: { "2026-09": receivableReportMetadata(edited, records) } };
  const base = financeSnapshot([project]);
  const next = financeSnapshot([intended]);
  assert.equal(containsChanges(base, next, financeSnapshot([reload(intended)])), true);
  assert.equal(containsChanges(base, next, financeSnapshot([{ ...intended, units: project.units }])), false);
  assert.equal(containsChanges(base, next, financeSnapshot([{ ...intended, receivableReports: {} }])), false);
});

test("verification allows unrelated remote edits but rejects tombstoned targets", () => {
  const saved = { ...edit(), name: "remote name" };
  assert.equal(containsChanges(financeSnapshot([project]), financeSnapshot([edit()]), financeSnapshot([saved])), true);
  const deleted = { ...saved, _deleted: true };
  assert.equal(containsChanges(financeSnapshot([project]), financeSnapshot([edit()]), financeSnapshot([deleted])), false);
  assert.throws(() => rebaseProjectEdit(project, edit(), deleted));
});

test("conflict retry merges edits made while save was awaiting a response", () => {
  const remote = { ...project, contact: "device B" };
  const current = { ...edit(), units: [updateReportSource(edit().units[0], reportDraft)] };
  const result = threeWayMerge(project, current, remote);
  assert.equal(result.value.contact, "device B");
  assert.equal(result.value.units[0].rate, 2750);
  assert.equal(result.value.units[0].acceptances[0].report.noteText, "edited");
});

test("save wiring verifies reload before baseline/outbox acknowledgement and awaits explicit saves", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const save = source.slice(source.indexOf("const saveState ="), source.indexOf("const refreshSharedData ="));
  assert.ok(save.indexOf('loadWorkspace({ action: "workspace-save", phase: phase || "verification" })') < save.indexOf("containsChanges("));
  assert.ok(save.indexOf("containsChanges(") < save.indexOf("baselineRef.current = structuredClone(shared)"));
  assert.ok(save.indexOf("containsChanges(") < save.indexOf("completeSyncedOutbox"));
  assert.doesNotMatch(save, /catch \{ \/\* the save succeeded/);
  assert.match(save, /threeWayMerge\(result\.attempt\.source, latestRef.current, shared\)/);
  const billing = source.slice(source.indexOf("function Billing("), source.indexOf("type CompletionExportDraft"));
  assert.match(billing, /await persistFinance\(billingBaseRef.current/);
  assert.match(billing, /await persistFinance\(reportBaseRef.current/);
  const receivableSave = billing.slice(billing.indexOf("saveReceivableSource = async"), billing.indexOf("openReceivablePreview = async"));
  assert.match(receivableSave, /buildReceivableAcceptanceUpdates\(/);
  assert.match(receivableSave, /await saveOfflineDraft\(/);
  assert.match(receivableSave, /await saveReceivable\(p.id, ym, metadata, acceptanceUpdates\)/);
  assert.ok(receivableSave.indexOf("await saveReceivable(") < receivableSave.indexOf("await removeOfflineDraft(recoveryKey)"));
  assert.doesNotMatch(receivableSave, /persistFinance|applyReceivableSharedFields|saveWorkspace|loadWorkspace|spc_merge_workspace/);
  assert.doesNotMatch(billing, /patch\(\{ units: p.units/);
  assert.doesNotMatch(billing, /\?{4}/);
});
