import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canWriteAcceptanceLifecycle, canWriteWorkLifecycle, type UnitLifecycleStatus } from "../lib/unit-lifecycle.ts";

test("work writes are allowed only after entry approval and while construction is active", () => {
  assert.equal(canWriteWorkLifecycle("場勘待改善"), false);
  assert.equal(canWriteWorkLifecycle("可進場"), true);
  assert.equal(canWriteWorkLifecycle("施工中"), true);
  for (const status of ["待確認", "待場勘", "待驗收", "改善中", "待複驗", "已驗收", "已計價"] as UnitLifecycleStatus[]) {
    assert.equal(canWriteWorkLifecycle(status), false, status);
  }
});

test("new acceptance and recheck writes require their exact lifecycle states", () => {
  assert.equal(canWriteAcceptanceLifecycle("場勘待改善", false), false);
  assert.equal(canWriteAcceptanceLifecycle("待驗收", false), true);
  assert.equal(canWriteAcceptanceLifecycle("待複驗", true), true);
  assert.equal(canWriteAcceptanceLifecycle("待驗收", true), false);
  assert.equal(canWriteAcceptanceLifecycle("待複驗", false), false);
  for (const status of ["待確認", "待場勘", "可進場", "施工中", "改善中", "已驗收", "已計價"] as UnitLifecycleStatus[]) {
    assert.equal(canWriteAcceptanceLifecycle(status, false), false, status);
    assert.equal(canWriteAcceptanceLifecycle(status, true), false, status);
  }
});

test("editing an existing formal acceptance preserves the established history workflow", () => {
  for (const status of ["場勘待改善", "施工中", "已驗收", "已計價"] as UnitLifecycleStatus[]) {
    assert.equal(canWriteAcceptanceLifecycle(status, false, true), true, status);
  }
});

test("React write handlers and buttons apply the lifecycle guards defensively", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const work = page.slice(page.indexOf("function WorkTab("), page.indexOf("function completionDefaults("));
  const acceptance = page.slice(page.indexOf("function AcceptTab("), page.indexOf("function DefectsTab("));

  assert.match(work, /const canWriteWork = canWriteWorkLifecycle\(u\.status\)/);
  assert.equal((work.match(/if \(!canWriteWork\) return setSaved/g) || []).length, 2);
  assert.equal((work.match(/disabled=\{!canWriteWork \|\| !w\.crew\}/g) || []).length, 3);
  assert.match(acceptance, /saveDraft = \(\) => \{[\s\S]*if \(!canWriteAcceptanceLifecycle\(u\.status, a\.recheck\)\) return setSaved/);
  assert.match(acceptance, /const savingHistory = historyModeRef\.current;\s*if \(!canWriteAcceptanceLifecycle\(u\.status, a\.recheck, savingHistory\)\)/);
  assert.match(acceptance, /disabled=\{historyMode \|\| !canWriteAcceptanceLifecycle\(u\.status, a\.recheck\)\}/);
  assert.match(acceptance, /disabled=\{!canWriteAcceptanceLifecycle\(u\.status, a\.recheck, historyMode\)/);
  assert.match(acceptance, /onOpen: \(\) => \{ if \(!historyModeRef\.current\)[\s\S]*historyModeRef\.current = true/);
});

test("formal acceptance history save updates only the same acceptance record", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const acceptance = page.slice(page.indexOf("function AcceptTab("), page.indexOf("function DefectsTab("));
  const saveFlow = acceptance.slice(acceptance.indexOf("const acceptanceUpdate"), acceptance.indexOf("localStorage.setItem"));
  const historyBranch = saveFlow.slice(saveFlow.indexOf("if (savingHistory)"), saveFlow.indexOf("} else {"));
  const normalBranch = saveFlow.slice(saveFlow.indexOf("} else {"));

  assert.match(saveFlow, /const acceptanceUpdate = \{ acceptances: \[completed, \.\.\.u\.acceptances\.filter\(\(item\) => item\.id !== completed\.id\)\] \}/);
  assert.match(historyBranch, /patch\(acceptanceUpdate\)/);
  assert.doesNotMatch(historyBranch, /\bstatus\b|newDef|defects:|events:|\badd\(/);
  assert.match(normalBranch, /status: Status = fail \? "驗收缺失" : "已驗收"/);
  assert.match(normalBranch, /newDef = fail/);
  assert.match(normalBranch, /defects: \[\.\.\.newDef, \.\.\.u\.defects\]/);
  assert.match(normalBranch, /events: \[/);
  assert.match(normalBranch, /add\(completed\.recheck \? "完成複驗" : "完成驗收"/);
  assert.match(acceptance, /queueRecordChange\(authUserId, "accept", u\.id, completed, "complete"\)/);
  assert.match(acceptance, /if \(!savingHistory\) await removeDurableDraft/);
  assert.match(acceptance, /if \(savingHistory\) \{\s*const resumeAcceptance = preHistoryAcceptanceRef\.current;[\s\S]*historyModeRef\.current = false;[\s\S]*if \(resumeAcceptance\) setA\(resumeAcceptance\)/);
});
