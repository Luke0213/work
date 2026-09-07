import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyBillingChanges, canApplySharedReload, containsChanges, financeSnapshot, rebaseProjectEdit, updateReportSource } from "../lib/finance-persistence.ts";
import { buildAcceptanceExportRecord, buildAcceptanceExportRecords, loadReceivableReportDraft, receivableReportMetadata, createShipmentWorkbook } from "../lib/acceptance-exports.ts";
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

test("all receivable custom values survive close/reopen from project + month metadata", () => {
  const records = buildAcceptanceExportRecords(project);
  const draft = loadReceivableReportDraft(project, records, "2026-09");
  for (const key of Object.keys(draft).filter((k) => k !== "details")) (draft as any)[key] = `custom-${key}`;
  for (const key of Object.keys(draft.details[0])) (draft.details[0] as any)[key] = `detail-${key}`;
  const saved = reload({ ...project, receivableReports: { "2026-09": receivableReportMetadata(draft, records) } });
  assert.deepEqual(loadReceivableReportDraft(saved, records, "2026-09"), draft);
  assert.equal(loadReceivableReportDraft(saved, records, "2026-10").deliveryContact, "contact");
  const otherProject = { ...project, id: "p2" };
  assert.equal(loadReceivableReportDraft(otherProject, records, "2026-09").deliveryContact, "contact");
  assert.deepEqual(saved.units, project.units);
});

test("old projects get current defaults and rows follow unit identity instead of row index", () => {
  const records = buildAcceptanceExportRecords(project);
  assert.equal(loadReceivableReportDraft(project, records, "2026-09").details[0].unitPrice, "100");
  const draft = loadReceivableReportDraft(project, records, "2026-09");
  draft.details[0].note = "u1 only";
  const saved = { ...project, receivableReports: { "2026-09": receivableReportMetadata(draft, records) } };
  const reopened = loadReceivableReportDraft(saved, [{ ...records[0], unitId: "u2" }, ...records], "2026-09");
  assert.equal(reopened.details[0].note, "old");
  assert.equal(reopened.details[1].note, "u1 only");
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
  assert.ok(save.indexOf("await loadWorkspace()") < save.indexOf("containsChanges("));
  assert.ok(save.indexOf("containsChanges(") < save.indexOf("baselineRef.current = structuredClone(shared)"));
  assert.ok(save.indexOf("containsChanges(") < save.indexOf("completeSyncedOutbox"));
  assert.doesNotMatch(save, /catch \{ \/\* the save succeeded/);
  assert.match(save, /threeWayMerge\(saveBase, latestRef.current, remote\)/);
  const billing = source.slice(source.indexOf("function Billing("), source.indexOf("type CompletionExportDraft"));
  assert.match(billing, /await persistFinance\(billingBaseRef.current/);
  assert.match(billing, /await persistFinance\(reportBaseRef.current/);
  assert.match(billing, /await persistFinance\(receivableBaseRef.current/);
  assert.doesNotMatch(billing, /patch\(\{ units: p.units/);
  assert.doesNotMatch(billing, /\?{4}/);
});
