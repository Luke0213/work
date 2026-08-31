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
  const workSaveDraft = work.slice(work.indexOf("const saveDraft = () => {"), work.indexOf("const save = (done: boolean) => {"));
  const workSave = work.slice(work.indexOf("const save = (done: boolean) => {"), work.indexOf("return ("));
  const workHistoryReturn = workSave.indexOf("return;");
  const workNormalSave = workSave.slice(workHistoryReturn + "return;".length);

  assert.match(work, /const canWriteWork = canWriteWorkLifecycle\(u\.status\)/);
  assert.match(workSaveDraft, /if \(workHistoryModeRef\.current\) return setSaved/);
  assert.match(workSaveDraft, /if \(!canWriteWork\) return setSaved/);
  assert.ok(workSaveDraft.indexOf("if (!canWriteWork)") < workSaveDraft.indexOf("patch({"));
  assert.ok(workSaveDraft.indexOf("if (!canWriteWork)") < workSaveDraft.indexOf("writeLocalDraft("));
  assert.ok(workSaveDraft.indexOf("if (!canWriteWork)") < workSaveDraft.indexOf("queueRecordChange("));
  assert.match(workSave, /if \(workHistoryModeRef\.current\) \{[\s\S]*patch\(workUpdate\)[\s\S]*queueRecordChange\(authUserId, "work", u\.id, completedWork, "complete"\)[\s\S]*return;/);
  assert.match(workNormalSave, /if \(!canWriteWork\) return setSaved/);
  for (const sideEffect of ["const status:", "events:", "add(", "removeDurableDraft("]) {
    assert.ok(workNormalSave.indexOf("if (!canWriteWork)") < workNormalSave.indexOf(sideEffect), sideEffect);
  }
  assert.match(work, /<button className="ghost" disabled=\{!canWriteWork \|\| !w\.crew\} onClick=\{saveDraft\}>暫存未完成施工<\/button>/);
  assert.match(work, /<button className="ghost" disabled=\{!canWriteWork \|\| !w\.crew\} onClick=\{\(\) => save\(false\)\}>儲存並維持施工中<\/button>/);
  assert.match(work, /<button className="primary" disabled=\{!canWriteWork \|\| !w\.crew\} onClick=\{\(\) => save\(true\)\}>施工完成 → 待驗收<\/button>/);
  assert.match(acceptance, /saveDraft = \(\) => \{[\s\S]*if \(!canWriteAcceptanceLifecycle\(u\.status, a\.recheck\)\) return setSaved/);
  assert.match(acceptance, /const savingHistory = historyModeRef\.current;\s*if \(!canWriteAcceptanceLifecycle\(u\.status, a\.recheck, savingHistory\)\)/);
  assert.match(acceptance, /disabled=\{historyMode \|\| !canWriteAcceptanceLifecycle\(u\.status, a\.recheck\)\}/);
  assert.match(acceptance, /disabled=\{!canWriteAcceptanceLifecycle\(u\.status, a\.recheck, historyMode\)/);
  assert.match(acceptance, /onOpen: \(\) => openAcceptanceRecord\(x\)/);
});

test("formal survey, work, and acceptance records open in protected history mode", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const survey = page.slice(page.indexOf("function SurveyTab("), page.indexOf("function WorkTab("));
  const work = page.slice(page.indexOf("function WorkTab("), page.indexOf("function completionDefaults("));
  const acceptance = page.slice(page.indexOf("function AcceptTab("), page.indexOf("function DefectsTab("));

  assert.match(survey, /const latestFormalSurvey = u\.surveys\.find\(\(record\) => record\.draft !== true\)/);
  assert.match(survey, /return latestFormalSurvey \|\| initial/);
  assert.match(survey, /if \(surveyHistoryModeRef\.current \|\| !surveyDraftActiveRef\.current\) return;\s*writeLocalDraft/);
  assert.match(survey, /if \(surveyHistoryModeRef\.current\) preHistorySurveyRef\.current = restored/);
  assert.match(survey, /const resumeSurvey = preHistorySurveyRef\.current \|\| \{ \.\.\.fallback, id: id\(\), date: day\(\), startedAt: stamp\(\) \}/);

  assert.match(work, /const latestFormalWork = u\.works\.find\(\(record\) => record\.draft !== true\)/);
  assert.match(work, /return latestFormalWork \|\| initial/);
  assert.match(work, /if \(workHistoryModeRef\.current \|\| !workDraftActiveRef\.current\) return;\s*writeLocalDraft/);
  assert.match(work, /if \(workHistoryModeRef\.current\) preHistoryWorkRef\.current = restored/);
  assert.match(work, /const resumeWork = preHistoryWorkRef\.current \|\| \{ \.\.\.fallback, id: id\(\), date: day\(\), startedAt: stamp\(\) \}/);

  assert.match(acceptance, /const latestFormalAcceptance = u\.acceptances\.find\(\(item\) => item\.draft !== true\)/);
  assert.match(acceptance, /return latestFormalAcceptance \|\| initialAcceptance/);
  assert.match(acceptance, /if \(historyModeRef\.current\) preHistoryAcceptanceRef\.current = restored/);
  assert.match(acceptance, /if \(historyModeRef\.current\) return;\s*if \(!acceptanceDraftActiveRef\.current\) return;/);
  assert.match(acceptance, /const resumeAcceptance = preHistoryAcceptanceRef\.current \|\| \{ \.\.\.fallback, id: id\(\), date: day\(\), startedAt: stamp\(\) \}/);
});

test("UnitDetail provides bounded project and floor navigation without resetting the active tab", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const unitDetail = page.slice(page.indexOf("function UnitDetail("), page.indexOf("function Next("));
  const floorView = page.slice(page.indexOf("function FloorAcceptanceView("), page.indexOf("function UnitDetail("));

  assert.match(unitDetail, /const navigationUnits = floorContext \? floorUnits : liveEntities\(project\.units\)/);
  assert.match(unitDetail, /const currentNavigationIndex = navigationUnits\.findIndex\(\(item\) => item\.id === unit\.id\)/);
  assert.doesNotMatch(unitDetail, /\{floorContext && <div className="floor-unit-navigation">/);
  assert.match(unitDetail, /disabled=\{currentNavigationIndex <= 0\}/);
  assert.match(unitDetail, /disabled=\{currentNavigationIndex < 0 \|\| currentNavigationIndex >= navigationUnits\.length - 1\}/);
  assert.match(unitDetail, /openUnit\(navigationUnits\[currentNavigationIndex - 1\]\.id\)/);
  assert.match(unitDetail, /openUnit\(navigationUnits\[currentNavigationIndex \+ 1\]\.id\)/);
  assert.doesNotMatch(unitDetail, /openUnit\([\s\S]{0,120}setTab\(/);
  assert.match(unitDetail, /<SurveyTab key=\{unit\.id\}/);
  assert.match(unitDetail, /<WorkTab key=\{unit\.id\}/);
  assert.match(unitDetail, /<AcceptTab key=\{unit\.id\}/);
  assert.match(floorView, /const units = floorUnitsFor\(project\.units, context\.building, context\.floor\)/);
  assert.match(floorView, /createFloorReturnContext\(context\.building, context\.floor, filter, expanded, window\.scrollY, tab, currentUnit\?\.id, workMode\)/);
});

test("formal survey history save updates only the same survey record", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const survey = page.slice(page.indexOf("function SurveyTab("), page.indexOf("function WorkTab("));
  const saveFlow = survey.slice(survey.indexOf("const surveyUpdate"), survey.indexOf("return ("));
  const historyBranch = saveFlow.slice(saveFlow.indexOf("if (surveyHistoryModeRef.current)"), saveFlow.indexOf("return;") + "return;".length);
  const normalBranch = saveFlow.slice(saveFlow.indexOf("return;") + "return;".length);

  assert.match(saveFlow, /u\.surveys\.map\(\(record\) => record\.id === survey\.id \? survey : record\)/);
  assert.match(historyBranch, /patch\(surveyUpdate\)/);
  assert.match(historyBranch, /queueRecordChange\(authUserId, "survey", u\.id, survey, "complete"\)/);
  assert.doesNotMatch(historyBranch, /\bstatus\b|defects:|events:|\badd\(|removeDurableDraft/);
  assert.match(normalBranch, /const status: Status = s\.decision === "可進場" \? "可進場" : "場勘待改善"/);
  assert.match(normalBranch, /events: \[/);
  assert.match(normalBranch, /defects:/);
  assert.match(normalBranch, /add\("完成場勘", s\.decision, allPhotos\)/);
  assert.match(normalBranch, /removeDurableDraft\(draftKey\(authUserId, "survey", u\.id\)\)/);
});

test("formal work history save cannot run construction lifecycle actions", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const work = page.slice(page.indexOf("function WorkTab("), page.indexOf("function completionDefaults("));
  const saveFlow = work.slice(work.indexOf("const save = (done: boolean)"), work.indexOf("return ("));
  const historyBranch = saveFlow.slice(saveFlow.indexOf("if (workHistoryModeRef.current)"), saveFlow.indexOf("return;") + "return;".length);
  const normalBranch = saveFlow.slice(saveFlow.indexOf("return;") + "return;".length);

  assert.match(saveFlow, /const completedWork: Work = \{ \.\.\.w, draft: false \}/);
  assert.match(saveFlow, /works: \[completedWork, \.\.\.u\.works\.filter\(\(record\) => record\.id !== completedWork\.id\)\]/);
  assert.match(historyBranch, /patch\(workUpdate\)/);
  assert.match(historyBranch, /queueRecordChange\(authUserId, "work", u\.id, completedWork, "complete"\)/);
  assert.doesNotMatch(historyBranch, /\bstatus\b|events:|\badd\(|removeDurableDraft/);
  assert.match(historyBranch, /return;\s*$/);
  assert.match(normalBranch, /if \(!canWriteWork\) return setSaved/);
  assert.match(normalBranch, /const status: Status = done \? "待驗收" : "施工中"/);
  assert.match(normalBranch, /events: \[/);
  assert.match(normalBranch, /add\(title, w\.content, w\.photos\)/);
  assert.match(normalBranch, /removeDurableDraft\(draftKey\(authUserId, "work", u\.id\)\)/);
  assert.match(work, /\{historyMode \?/);
  assert.match(work, /儲存歷史施工修改/);
  assert.match(work, /disabled=\{!w\.crew\}/);
  assert.match(work, /onClick=\{\(\) => save\(false\)\}/);
  assert.match(work, /<button className="ghost" disabled=\{!canWriteWork \|\| !w\.crew\} onClick=\{\(\) => save\(false\)\}>儲存並維持施工中<\/button>/);
  assert.match(work, /<button className="primary" disabled=\{!canWriteWork \|\| !w\.crew\} onClick=\{\(\) => save\(true\)\}>施工完成 → 待驗收<\/button>/);
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
