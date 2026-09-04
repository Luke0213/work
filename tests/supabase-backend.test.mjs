import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("normalized migration contains every SPC domain table", async () => {
  const sql = await read("supabase/migrations/202608230002_normalized_backend.sql");
  for (const table of ["spc_projects","spc_products","spc_units","spc_surveys","spc_works","spc_defects","spc_acceptances","spc_events","spc_journals","spc_audit_logs","spc_backups"]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  }
  assert.match(sql, /SPC_VERSION_CONFLICT/);
  assert.match(sql, /storage\.buckets/);
});

test("frontend uses v2 RPC and Storage instead of writing legacy app state", async () => {
  const page = await read("app/page.tsx");
  const backend = await read("lib/spc-backend.ts");
  assert.doesNotMatch(page, /\.from\("spc_app_state"\)\.upsert/);
  assert.match(backend, /spc_load_workspace/);
  assert.match(backend, /spc_save_workspace/);
  assert.match(backend, /storage\.from\("spc-photos"\)/);
  assert.match(backend, /cleanupRemovedPhotos/);
  assert.match(backend, /spc-photo-cleanup-queue/);
});

test("normal workspace sync never invokes physical photo cleanup", async () => {
  const page = await read("app/page.tsx");
  const backend = await read("lib/spc-backend.ts");
  assert.doesNotMatch(page, /\bcleanupRemovedPhotos\b/);
  assert.match(backend, /export async function cleanupRemovedPhotos/);
  assert.match(backend, /storage\.from\("spc-photos"\)\.remove/);
});

test("completed acceptance cannot restore or rewrite a stale durable draft", async () => {
  const page = await read("app/page.tsx");
  const acceptance = page.slice(page.indexOf("function AcceptTab"), page.indexOf("function CompletionCopy"));
  assert.match(acceptance, /const draft = \{ \.\.\.a, draft: true \}/);
  assert.match(acceptance, /writeLocalDraft\(draftKey\(authUserId, "accept", u\.id\), draft, authUserId\)/);
  assert.match(acceptance, /const completed: Acceptance = \{ \.\.\.a, draft: false \}/);
  assert.match(acceptance, /acceptances: \[completed,[\s\S]*setA\(completed\)[\s\S]*queueRecordChange\(authUserId, "accept", u\.id, completed, "complete"\)/);
  assert.match(acceptance, /acceptanceDraftActiveRef\.current = false[\s\S]*skipNextDraftWrite\.current = true/);
  assert.match(acceptance, /const setRestorableAcceptance = useRef\(\(restored: Acceptance\) => \{\s*if \(restored\.draft === false\) return;\s*if \(historyModeRef\.current\) preHistoryAcceptanceRef\.current = restored;\s*else setA\(restored\);/);
  assert.match(acceptance, /useOfflineDraftRestore\(draftKey\(authUserId, "accept", u\.id\), setRestorableAcceptance\)/);
  assert.doesNotMatch(acceptance, /useOfflineDraftRestore\(draftKey\(authUserId, "accept", u\.id\), setRestorableAcceptance, acceptanceDraftActiveRef\)/);
  assert.match(acceptance, /await pendingDraftWriteRef\.current;[\s\S]*await removeDurableDraft/);
  assert.match(acceptance, /add\(completed\.recheck[\s\S]*completed\.result/);
  assert.match(page, /signatures: a\.completion\?\.signatures \|\| \(a\.signature \? \{ office: a\.signature \} : \{\}\)/);
  assert.doesNotMatch(page, /\bcleanupRemovedPhotos\b/);
});

test("monitoring, scheduled backups, and full Excel export are wired", async () => {
  const page = await read("app/page.tsx");
  const monitoring = await read("lib/monitoring.ts");
  const sql = await read("supabase/migrations/202608240004_monitoring_and_schedule.sql");
  assert.match(page, /exportFullExcel/);
  for (const sheet of ["專案","產品","戶別","場勘","施工","驗收","缺失","事件"]) assert.match(page, new RegExp(`add\\("${sheet}"`));
  assert.match(monitoring, /spc_system_health/);
  assert.match(monitoring, /spc_report_error/);
  assert.match(sql, /cron\.schedule/);
  assert.match(sql, /spc-daily-snapshot/);
});

test("five roles are enforced in both UI and database RPCs", async () => {
  const page = await read("app/page.tsx");
  const api = await read("app/api/admin/users/route.ts");
  const sql = await read("supabase/migrations/202608260002_five_role_access.sql");
  for (const role of ["admin", "shenyin", "client", "crew", "sales"]) {
    assert.match(page, new RegExp(`\\b${role}\\b`));
    assert.match(sql, new RegExp(`'${role}'`));
  }
  assert.doesNotMatch(api, /accountManagerEmail|user\.email.*wongkinlun9527/);
  assert.match(api, /role\?\.role === "admin"/);
  assert.match(page, /const canManageAccounts = appRole === "admin"/);
  assert.match(sql, /spc_merge_restricted_projects/);
  assert.match(sql, /spc_filter_units/);
  for (const field of ["owner", "phone", "email", "lineId", "customerNeed", "marketingConsent"]) {
    assert.match(sql, new RegExp(`'${field}'`));
  }
  assert.match(sql, /spc_current_role\(\) in \('admin',\s*'shenyin',\s*'crew'\)/);
});

test("collaborative saves merge shared data and retain per-user activity", async () => {
  const sql = await read("supabase/migrations/202608260003_collaborative_workspace.sql");
  const backend = await read("lib/spc-backend.ts");
  assert.match(sql, /spc_json_merge_three_way/);
  assert.match(sql, /for update/);
  assert.match(sql, /spc_entity_activity/);
  assert.match(sql, /user_email/);
  assert.match(sql, /spc_load_entity_activity/);
  assert.match(backend, /spc_merge_workspace/);
  assert.match(backend, /p_base_projects/);
});

test("backups are daily with bounded retention instead of running on every save", async () => {
  const roles = await read("supabase/migrations/202608260002_five_role_access.sql");
  const fix = await read("supabase/migrations/202608260004_backup_io_fix.sql");
  const saveBody = roles.slice(roles.indexOf("create or replace function public.spc_save_workspace_unchecked"), roles.indexOf("create or replace function public.spc_filter_units"));
  assert.doesNotMatch(saveBody, /insert into spc_backups/);
  assert.match(fix, /spc-daily-snapshot/);
  assert.match(fix, /offset 7/);
  assert.match(fix, /cron\.unschedule/);
});

test("unit estimated remains the canonical ping area and survey no longer duplicates its header display", async () => {
  const page = await read("app/page.tsx");
  const areaDraftInput = page.slice(page.indexOf("function AreaDraftInput"), page.indexOf("function Tabs"));
  const survey = page.slice(page.indexOf("function SurveyTab"), page.indexOf("function WorkTab"));
  assert.match(page, /estimated: areaInputToPing/);
  assert.match(areaDraftInput, /setArea\(convertAreaInput\(value, unit, nextUnit\), nextUnit\)/);
  assert.match(areaDraftInput, /setArea\(event\.target\.value, unit\)/);
  assert.doesNotMatch(areaDraftInput, /setValue|setUnit/);
  assert.match(page, /const importedEstimated = importedAreaEntry\(source\)\?\.value \?\? Number\.NaN/);
  assert.match(page, /const estimated = safeImportedEstimated\(importedEstimated\)/);
  assert.match(page, /const estimated = importedAreaToCanonicalPing\(row\.estimated, interpretedAreaUnit\)/);
  assert.doesNotMatch(survey, /survey-estimated-area/);
  assert.doesNotMatch(survey, /沿用戶別主資料，此處僅供查看/);
  assert.doesNotMatch(page, /pendingSurvey/);
  assert.doesNotMatch(page, /setS\(\{ \.\.\.s, areaStatus: "known"/);
  assert.match(page, /record\.id === survey\.id/);
});

test("offline drafts are account-scoped and recoverable for every authorized role", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /spc-current-user-id/);
  assert.match(page, /scopedKey\(workspaceDraftKey, authUserId\)/);
  assert.doesNotMatch(page, /const durableDraft = canManageProjects \?/);
  assert.match(page, /setProjectsDurably/);
  assert.match(page, /暫存未完成驗收/);
});

test("account creation is applicant-owned while admin reset preserves metadata and forces password change", async () => {
  const page = await read("app/page.tsx");
  const api = await read("app/api/admin/users/route.ts");
  const applicationApi = await read("app/api/account-applications/route.ts");
  const audit = await read("supabase/migrations/202608260005_phone_identity_audit.sql");
  assert.match(page, /電子郵件或手機號碼/);
  assert.match(page, /must_change_password/);
  assert.doesNotMatch(api, /action: "create"|auth\.admin\.createUser|建立新帳號/);
  assert.match(applicationApi, /auth\.admin\.createUser/);
  assert.match(api, /1234qwer/);
  assert.match(api, /user_metadata: \{ \.\.\.existing\.user\.user_metadata, must_change_password: true \}/);
  assert.match(applicationApi, /@phone\.spc\.internal/);
  assert.match(applicationApi, /local_phone/);
  assert.match(audit, /auth\.jwt\(\)->>'phone'/);
});

test("users can apply with their own password while admin approval remains mandatory", async () => {
  const page = await read("app/page.tsx");
  const applicationApi = await read("app/api/account-applications/route.ts");
  const adminApi = await read("app/api/admin/users/route.ts");
  const sql = await read("supabase/migrations/202608270006_account_applications.sql");
  for (const value of ["申請帳號", "申請使用帳號", "設定密碼", "等待管理員核准", "applicationRoleOptions"]) {
    assert.match(page, new RegExp(value));
  }
  assert.doesNotMatch(page.slice(page.indexOf("const applicationRoleOptions"), page.indexOf("const canUseSystem")), /value === "admin"/);
  assert.match(applicationApi, /applicationRoles = new Set\(\["shenyin", "client", "crew", "sales"\]\)/);
  assert.match(applicationApi, /password\.length < 8/);
  assert.match(applicationApi, /active: false/);
  assert.match(applicationApi, /application_status: "pending"/);
  assert.match(adminApi, /application_status: "approved"/);
  assert.match(sql, /application_status/);
  assert.match(sql, /'pending', 'approved', 'rejected'/);
});

test("new-project onboarding supports product shortcuts and Excel import", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const onboarding = page.slice(page.indexOf("function ProjectOnboarding"), page.indexOf("function Empty"));
  const unitManager = page.slice(page.indexOf("function Units("), page.indexOf("type ImportUnitRow"));
  for (const value of ["點一下已有色號即可自動帶入", "setProduct({ ...p })", "大量資料可在這裡直接使用 Excel／CSV 匯入", "project-onboarding-import", "<ImportUnits"])
    assert.match(onboarding, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(unitManager, /<ImportUnits/);
  assert.match(css, /\.onboarding-products\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /\.onboarding-products button\{[^}]*min-height:78px/);
});

test("client and server protect history collections from stale omission deletion", async () => {
  const merge = await read("lib/three-way-merge.ts");
  const page = await read("app/page.tsx");
  const sql = await read("supabase/migrations/202608280001_protected_history_merge.sql");
  for (const collection of ["surveys", "works", "defects", "acceptances", "journals", "events"]) {
    assert.match(merge, new RegExp(`\\"${collection}\\"`));
    assert.match(sql, new RegExp(collection));
  }
  assert.match(merge, /const tombstone = \[bv, lv, rv\]/);
  assert.match(merge, /if \(tombstone\) \{ result\.push\(tombstone\); continue; \}/);
  assert.match(merge, /export const liveEntities/);
  assert.match(sql, /spc_json_merge_three_way_at/);
  assert.match(sql, /result := result \|\| jsonb_build_array\(deleted_marker\)/);
  assert.match(sql, /revoke all on function public\.spc_json_merge_three_way_at\(jsonb, jsonb, jsonb, text\) from public/);
  assert.match(sql, /revoke all on function public\.spc_json_merge_three_way_at\(jsonb, jsonb, jsonb, text\) from anon/);
  assert.match(page, /tombstoneEntity\(x, authUserId, stamp\(\)\)/);
  assert.match(page, /queueRecordChange\(authUserId, "journal", p\.id, deleted, "delete"\)/);
  assert.doesNotMatch(page, /patch\(\{ journals: p\.journals\.filter\(\(n\) => n\.id !== x\.id\) \}\)/);
  assert.doesNotMatch(page, /\bcleanupRemovedPhotos\b/);
});

test("floor acceptances use the same non-destructive protected merge semantics", async () => {
  const page = await read("app/page.tsx");
  const client = await read("lib/three-way-merge.ts");
  const sql = await read("supabase/migrations/202608280002_floor_acceptances_merge.sql");
  assert.match(page, /floorAcceptances\?: FloorAcceptanceRecord\[\]/);
  assert.match(client, /"floorAcceptances"/);
  assert.match(sql, /create or replace function public\.spc_json_merge_three_way_at/i);
  assert.match(sql, /floorAcceptances/);
  assert.match(sql, /revoke all on function public\.spc_json_merge_three_way_at[\s\S]*from anon/i);
  assert.doesNotMatch(sql, /\b(update|delete\s+from|truncate|insert\s+into|drop\s+table|alter\s+table)\b/i);
  assert.doesNotMatch(page, /\bcleanupRemovedPhotos\b/);
});

test("project onboarding keeps SPC optional and resolves product metadata safely", async () => {
  const page = await read("app/page.tsx");
  const onboarding = page.slice(page.indexOf("function ProjectOnboarding"), page.indexOf("function Empty"));
  assert.match(onboarding, /onboardingUnitRowIsValid\(r, areaInputToPing\(r\.estimated, r\.areaUnit \|\| "坪"\)\)/);
  assert.doesNotMatch(onboarding.slice(onboarding.indexOf("const finish"), onboarding.indexOf("return (", onboarding.indexOf("const finish"))), /!r\.model|!r\.colorNo|products\.find\([^)]*\)!/);
  assert.match(onboarding, /findExactUnitProduct\(\{ model, colorNo \}, products\)/);
  assert.match(onboarding, /brand: product\?\.brand \|\| "", model, colorNo, spec: product\?\.spec \|\| ""/);
  assert.match(onboarding, /請確認棟別、樓層、戶別與坪數/);
});

test("project and unit deletion uses durable tombstones in client views and the additive server merge", async () => {
  const merge = await read("lib/three-way-merge.ts");
  const page = await read("app/page.tsx");
  const migration = await read("supabase/migrations/202608290001_project_unit_tombstone_merge.sql");
  const deletion = page.slice(page.indexOf("const removeUnit ="), page.indexOf("const addEvent ="));
  for (const collection of ["projects", "units"]) {
    assert.match(merge, new RegExp(`\\"${collection}\\"`));
    assert.match(migration, new RegExp(collection));
  }
  assert.match(deletion, /const unit = p\.units\.find\([\s\S]*!isDeletedEntity\(candidate\)/);
  assert.match(deletion, /tombstoneEntity\(unit, authUserId, stamp\(\)\)/);
  assert.match(deletion, /tombstoneEntity\(p, authUserId, stamp\(\)\)/);
  assert.doesNotMatch(deletion, /units\.filter|ps\.filter|projects\.filter/);
  assert.match(page, /const liveProjectViews = \(projects: Project\[\]\): Project\[\] => liveEntities\(projects\)\.map/);
  assert.match(page, /units: liveEntities\(project\.units\)/);
  assert.match(page, /const liveProjects = liveProjectViews\(projects\)/);
  assert.match(page, /retainEntityTombstones\(p\.units, x\.units\)/);
  assert.match(migration, /create or replace function public\.spc_json_merge_three_way_at/i);
  assert.match(migration, /\(projects\|units\|surveys\|works\|defects\|acceptances\|journals\|events\|floorAcceptances\)/);
  assert.match(migration, /order by coalesce\(marker->>'deletedAt', ''\) desc/);
  assert.match(migration, /revoke all on function public\.spc_json_merge_three_way_at[\s\S]*from public/i);
  assert.match(migration, /revoke all on function public\.spc_json_merge_three_way_at[\s\S]*from anon/i);
  assert.doesNotMatch(migration, /\b(delete\s+from|truncate|drop\s+table|alter\s+table|update\s+public\.|insert\s+into)\b/i);
  assert.doesNotMatch(page, /\bcleanupRemovedPhotos\b/);
  assert.doesNotMatch(deletion, /storage|spc-photos|\.remove\(/);
});

test("floor continuous acceptance workbench updates only the explicit unit acceptance signature", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const appState = page.slice(page.indexOf("const patchUnit ="), page.indexOf("const removeUnit ="));
  const floorView = page.slice(page.indexOf("function FloorAcceptanceView"), page.indexOf("function UnitDetail"));

  assert.match(appState, /const patchUnitById = \(unitId: string, updater: \(current: Unit\) => Unit\)/);
  assert.match(appState, /setProjectsDurably\(\(ps\) =>[\s\S]*p\.id !== pid \|\| isDeletedEntity\(p\)[\s\S]*current\.id === unitId && !isDeletedEntity\(current\) \? updater\(current\) : current/);
  assert.match(page, /patchUnitById=\{patchUnitById\}/);
  for (const value of ["樓層連續驗收工作台", "開始／繼續作業", "下一待處理", "上一戶", "下一戶", "簽名／補簽", "查看完整驗收資料", "四簽完成"])
    assert.match(floorView, new RegExp(value));
  assert.match(floorView, /patchUnitById\(targetUnitId, \(latestUnit\) => updateLatestFormalAcceptanceSignature\(latestUnit, targetRole, signature\)\)/);
  assert.match(floorView, /尚未完成驗收[\s\S]*不會建立假 Acceptance/);
  assert.match(floorView, /areaValueFromPing\(currentUnit\.estimated, "坪"\)/);
  assert.doesNotMatch(floorView, /acceptance\?\.area \|\| currentUnit\.estimated/);
  assert.doesNotMatch(floorView, /floorAcceptances\s*:|updateFloorSignature|saveRecord/);
  assert.match(css, /#24A floor continuous acceptance workbench/);
  assert.match(css, /\.floor-acceptance-page \.floor-workbench\{display:grid;grid-template-columns:270px minmax\(0,1fr\)/);
  assert.match(css, /@media\(max-width:1000px\) and \(min-width:701px\)[\s\S]*overflow-x:auto/);
  assert.match(css, /@media\(max-width:700px\)[\s\S]*\.floor-acceptance-page \.floor-workbench-selector\{display:none\}[\s\S]*position:fixed/);
});

test("Excel unit import accepts partial rows without importing blanks or duplicates", async () => {
  const page = await read("app/page.tsx");
  const importer = page.slice(page.indexOf("type ImportUnitRow"), page.indexOf("function ProjectForm"));
  assert.match(importer, /const hasData = Boolean\(building \|\| floor \|\| number \|\| model \|\| colorNo \|\| areaText \|\| statusText \|\| note \|\| specialText\)/);
  assert.match(importer, /const hasUnitKey = Boolean\(building && floor && number\)/);
  assert.match(importer, /const duplicate = hasUnitKey && \(existing\.has\(key\) \|\| inFile\.has\(key\)\)/);
  assert.match(importer, /const estimated = safeImportedEstimated\(importedEstimated\)/);
  assert.match(importer, /const importable = importableUnitRows\(rows\)/);
  assert.match(importer, /const units = importable\.map/);
  assert.match(importer, /row\.newProduct && row\.model && row\.colorNo/);
  for (const result of ["待補資料：", "戶別重複，不匯入", "完全空白，不匯入", "可匯入"]) assert.match(importer, new RegExp(result));
  assert.doesNotMatch(importer, /const valid = rows\.filter/);
});

test("survey door inspection records threshold choice, gap, evidence, photos, and compatible Excel fields", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["doorInspection", "thresholdCm", "meetsThreshold", "hasGap", "rationale", "有 1.5 cm 以上", "沒有 1.5 cm 以上", "判斷依據（選填）", "如何改善", "門檢查照片", "門檢查結果"]) {
    assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(page, /thresholdCm\?: number/);
  assert.match(page, /meetsThreshold: boolean \| null/);
  assert.match(page, /門檻實測公分: doorInspection\?\.thresholdCm \?\? ""/);
  assert.match(page, /doorInspection\?\.meetsThreshold === true \? "是" : doorInspection\?\.meetsThreshold === false \? "否" : ""/);
  assert.doesNotMatch(page, /Number\(door\.thresholdCm\) >= 1\.5|Number\(door\.thresholdCm\) < 1\.5/);
});

test("survey uses responsive launchers and one combined door workflow", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const survey = page.slice(page.indexOf("function SurveyTab"), page.indexOf("function WorkTab"));
  const surveyDefaults = page.slice(page.indexOf("const surveyLabels ="), page.indexOf("const acceptLabels ="));
  const launcherFlow = survey.slice(survey.indexOf("<Checklist"), survey.indexOf("<div className=\"grid3\">", survey.indexOf("<Checklist")));
  for (const value of ["doorSurveyLabels", "門與門檻", "door-combined-checks", "updateDoorItem", "doorCombinedResult"])
    assert.match(page, new RegExp(value));
  assert.match(page, /const doorSurveyLabels = \["門框是否完成", "門扇是否已安裝", "廁所門框狀態"\]/);
  assert.doesNotMatch(surveyDefaults, /垃圾是否清除/);
  assert.match(survey, /surveyChecklistItems = \[[\s\S]*item\.label !== "垃圾是否清除"[\s\S]*item\.label !== "其他異常"[\s\S]*item\.label === "其他異常"/);
  assert.match(survey, /set=\{\(items\) => setS\(\{ \.\.\.s, items: s\.items\.map\(\(existing\) => items\.find\(\(item\) => item\.label === existing\.label\) \|\| existing\) \}\)\}/);
  assert.match(page, /items=\{surveyChecklistItems\}/);
  assert.match(page, /panel form survey-tab/);
  assert.match(css, /\.survey-tab \.survey-section-grid\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(min-width:701px\) and \(max-width:1099px\)/);
  assert.match(css, /\.survey-tab \.survey-section-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(launcherFlow, /beforeLastItem=\{<>[\s\S]*門與門檻[\s\S]*矽利康施工[\s\S]*分隔條[\s\S]*放料區域[\s\S]*<\/>\}/);
  assert.match(launcherFlow, /extraItems=\{<>[\s\S]*>停車<[\s\S]*場勘簽名[\s\S]*<\/>\}/);
  assert.match(launcherFlow, /inspection-tile signature-tile/);
  assert.doesNotMatch(css, /\.survey-tab \.survey-section-grid \.signature-tile\{grid-column:span 2\}/);
  assert.match(css, /\.inspection-tile\.signature-tile\{[^}]*border:2px solid[^}]*background:/);
});

test("project navigation omits survey overview while unit survey remains available", async () => {
  const page = await read("app/page.tsx");
  const sideViews = page.slice(page.indexOf("const sideViews"), page.indexOf("const surveyLabels"));
  const projectArea = page.slice(page.indexOf("function ProjectArea"), page.indexOf("function Dashboard"));
  const unitDetail = page.slice(page.indexOf("function UnitDetail"), page.indexOf("function Master"));
  assert.doesNotMatch(sideViews, /\["survey"/);
  assert.doesNotMatch(projectArea, /\["survey", "場勘"\]|view === "survey"|SurveyOverview/);
  assert.doesNotMatch(page, /function SurveyOverview|function UnitTable/);
  assert.match(page, /if \(view === "survey"\)[\s\S]*setView\("units"\)/);
  assert.match(unitDetail, /\["survey", "場勘"\]/);
  assert.match(unitDetail, /tab === "survey"[\s\S]*<SurveyTab/);
});

test("project basic data saves one confirmed local draft and unit master cannot bypass it", async () => {
  const page = await read("app/page.tsx");
  const projectForm = page.slice(page.indexOf("function ProjectForm("), page.indexOf("function GlobalProducts("));
  const requestSave = projectForm.slice(projectForm.indexOf("const requestSave"), projectForm.indexOf("const confirmSave"));
  const confirmSave = projectForm.slice(projectForm.indexOf("const confirmSave"), projectForm.indexOf("return ("));
  const unitDetail = page.slice(page.indexOf("function UnitDetail("), page.indexOf("function Master("));
  const master = page.slice(page.indexOf("function Master("), page.indexOf("function SurveyTab("));

  for (const field of ["name", "address", "builder", "contact", "phone", "expectedDate", "note"])
    assert.match(projectForm, new RegExp(`\\["${field}",`));
  assert.match(projectForm, /const \[draft, setDraft\] = useState<ProjectFormDraft>/);
  assert.match(projectForm, /value=\{draft\[key\]\}[\s\S]*updateDraft\(key, value\)/);
  assert.doesNotMatch(projectForm, /writeLocalDraft|readDraft|loadOfflineDraft|saveOfflineDraft/);
  assert.match(projectForm, /const valid = !!draft\.name\.trim\(\) && !!draft\.address\.trim\(\)/);
  assert.match(projectForm, /disabled=\{!changes\.length\}[\s\S]*onClick=\{requestSave\}>儲存修改/);
  assert.doesNotMatch(requestSave, /\bpatch\(/);
  assert.equal((confirmSave.match(/\bpatch\(/g) || []).length, 1);
  assert.match(confirmSave, /const updates: Partial<ProjectFormDraft> = \{\}[\s\S]*changes\.forEach[\s\S]*patch\(updates\)/);
  assert.match(projectForm, /以下資料將更新為全案共用的專案基本資料/);
  assert.match(projectForm, />返回修改<\/button>[\s\S]*>確認儲存<\/button>/);
  assert.doesNotMatch(projectForm, /units\s*:|acceptances\s*:|surveys\s*:|works\s*:|journals\s*:|events\s*:/);
  assert.match(projectForm, /editedKeysRef\.current\.forEach\(\(key\) => \{[\s\S]*merged\[key\] = current\[key\][\s\S]*return merged/);

  assert.doesNotMatch(unitDetail, /<Master[\s\S]*patchProject=/);
  assert.match(master, /label="建案名稱（全案共用）"[\s\S]*value=\{p\.name\}[\s\S]*disabled[\s\S]*set=\{\(\) => undefined\}/);
  assert.match(master, /請至「專案資料」修改全案共用資料/);
  assert.doesNotMatch(master, /patchProject\(\{ name \}\)/);
  assert.match(unitDetail, /<p className="eyebrow">\{project\.name\}<\/p>/);
});

test("dashboard shows read-only project data instead of pending unit actions", async () => {
  const page = await read("app/page.tsx");
  const dashboard = page.slice(page.indexOf("function Dashboard"), page.indexOf("function DashAction"));
  const projectDataStart = dashboard.indexOf('<section className="dash-card task-card dashboard-project-data">');
  const projectData = dashboard.slice(projectDataStart, dashboard.indexOf("</section>", projectDataStart));

  assert.ok(projectDataStart >= 0);
  assert.doesNotMatch(dashboard, /待處理戶別|等待安排現場場勘|目前沒有待處理戶別/);
  assert.match(projectData, /<h2>專案資料<\/h2>/);
  for (const [label, field] of [
    ["建案名稱", "name"],
    ["案場地址", "address"],
    ["建設公司", "builder"],
    ["工地窗口", "contact"],
    ["聯絡資訊", "phone"],
    ["預計工程日期", "expectedDate"],
    ["備註", "note"],
  ]) {
    assert.match(projectData, new RegExp(`\\["${label}", p\\.${field} \\|\\| "—"\\]`));
  }
  assert.doesNotMatch(projectData, /<Field|<input|<textarea|patch\(|onClick=/);
});

test("global product catalog edits the visible product row without changing units", async () => {
  const page = await read("app/page.tsx");
  const globalProducts = page.slice(page.indexOf("function GlobalProducts("), page.indexOf("function Products("));
  const reset = globalProducts.slice(globalProducts.indexOf("const resetForm ="), globalProducts.indexOf("const beginEdit ="));
  const beginEdit = globalProducts.slice(globalProducts.indexOf("const beginEdit ="), globalProducts.indexOf("const add ="));
  const save = globalProducts.slice(globalProducts.indexOf("const add ="), globalProducts.indexOf("return ("));
  const editBranch = save.slice(save.indexOf("if (editingProductId)"), save.indexOf("} else {"));

  assert.match(globalProducts, /\[editingProductId, setEditingProductId\] = useState\(""\)/);
  assert.match(beginEdit, /setEditingProductId\(product\.id\)[\s\S]*setForm\(\{ \.\.\.product \}\)/);
  assert.doesNotMatch(beginEdit, /setProducts\(/);
  assert.match(save, /if \(!form\.model\.trim\(\) \|\| !form\.colorNo\.trim\(\)\) return/);
  assert.match(save, /x\.id !== editingProductId &&[\s\S]*x\.model\.trim\(\) === form\.model\.trim\(\)[\s\S]*x\.colorNo\.trim\(\) === form\.colorNo\.trim\(\)/);
  assert.match(editBranch, /setProducts\(products\.map\(\(product\) => product\.id === editingProductId \? \{/);
  for (const field of ["brand", "spec", "note"])
    assert.match(editBranch, new RegExp(`${field}: form\\.${field}`));
  assert.match(editBranch, /model: form\.model\.trim\(\)/);
  assert.match(editBranch, /colorNo: form\.colorNo\.trim\(\)/);
  assert.doesNotMatch(editBranch, /\bunits\s*:|\.filter\(|id\(\)|\.\.\.form/);
  assert.match(save, /setProducts\(\[[\s\S]*\{ \.\.\.form, model: form\.model\.trim\(\), colorNo: form\.colorNo\.trim\(\) \}[\s\S]*\.\.\.products/);
  assert.match(save, /resetForm\(\)[\s\S]*removeDurableDraft\(formDraftKey\)[\s\S]*removeOfflineDraft\(formDraftKey\)/);
  assert.match(reset, /setEditingProductId\(""\)[\s\S]*setForm\(blank\(\)\)/);
  assert.doesNotMatch(reset, /setProducts\(/);
  assert.match(globalProducts, /editingProductId && <button type="button" className="ghost" onClick=\{resetForm\}>取消修改<\/button>/);
  assert.match(globalProducts, /\{editingProductId \? "儲存修改" : "＋ 新增至共用產品庫"\}/);
  assert.match(globalProducts, /className="ghost" onClick=\{\(\) => beginEdit\(x\)\}>修改<\/button>[\s\S]*className="danger"/);
  assert.match(globalProducts, /confirm\("刪除此產品色號？既有戶別資料不會被改動。"\)[\s\S]*setProducts\(products\.filter\(\(p\) => p\.id !== x\.id\)\)/);
  assert.doesNotMatch(globalProducts, /\bunits\s*:|p\.units|patch\(/);
});

test("project product catalog edits one existing product without changing units", async () => {
  const page = await read("app/page.tsx");
  const products = page.slice(page.indexOf("function Products("), page.indexOf("function FloorAcceptanceView("));
  const assign = products.slice(products.indexOf("const assign ="), products.indexOf("const resetProductForm ="));
  const reset = products.slice(products.indexOf("const resetProductForm ="), products.indexOf("const beginProductEdit ="));
  const beginEdit = products.slice(products.indexOf("const beginProductEdit ="), products.indexOf("const addProduct ="));
  const save = products.slice(products.indexOf("const addProduct ="), products.indexOf("return ("));
  const editBranch = save.slice(save.indexOf("if (editingProductId)"), save.indexOf("} else {"));

  assert.match(products, /\[editingProductId, setEditingProductId\] = useState\(""\)/);
  assert.match(beginEdit, /setEditingProductId\(product\.id\)[\s\S]*setForm\(\{ \.\.\.product \}\)/);
  assert.doesNotMatch(beginEdit, /\bpatch\(|assign\(/);
  assert.match(save, /if \(!form\.model \|\| !form\.colorNo\) return/);
  assert.match(save, /x\.id !== editingProductId && x\.model === form\.model && x\.colorNo === form\.colorNo/);
  assert.match(editBranch, /products: p\.products\.map\(\(product\) => product\.id === editingProductId \? \{/);
  for (const field of ["brand", "model", "colorNo", "spec", "note"])
    assert.match(editBranch, new RegExp(`${field}: form\\.${field}`));
  assert.doesNotMatch(editBranch, /\bunits\s*:|\.filter\(|id\(\)|assign\(/);
  assert.match(save, /patch\(\{ products: \[form, \.\.\.p\.products\] \}\)/);
  assert.match(save, /resetProductForm\(\)[\s\S]*removeDurableDraft\(productDraftKey\)[\s\S]*removeOfflineDraft\(productDraftKey\)/);
  assert.match(reset, /setEditingProductId\(""\)[\s\S]*id: id\(\)[\s\S]*brand: ""[\s\S]*model: ""[\s\S]*colorNo: ""[\s\S]*spec: ""[\s\S]*note: ""/);
  assert.doesNotMatch(reset, /\bpatch\(/);
  assert.match(products, /editingProductId && <button type="button" className="ghost" onClick=\{resetProductForm\}>取消修改<\/button>/);
  assert.match(products, /\{editingProductId \? "儲存修改" : "＋ 新增產品色號"\}/);
  assert.match(products, /className="ghost" onClick=\{\(\) => beginProductEdit\(x\)\}>修改<\/button>[\s\S]*className="danger"/);
  assert.match(products, /confirm\("刪除此產品色號？既有戶別資料不會被改動。"\)[\s\S]*products: p\.products\.filter\(\(q\) => q\.id !== x\.id\)/);
  assert.match(assign, /products\.find\(\(x\) => x\.id === selected\)[\s\S]*units: p\.units\.map[\s\S]*brand: product\.brand[\s\S]*model: product\.model[\s\S]*colorNo: product\.colorNo[\s\S]*spec: product\.spec/);
});

test("floor progress summaries count one normalized current status per unit", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["unitProgressStatuses", "getUnitCurrentStatus", 'case "待確認"', 'case "場勘待改善"', 'case "驗收缺失"', 'case "待複驗"', 'case "已計價"']) {
    assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(page, /floorUnits\.filter\(\(u\) => getUnitCurrentStatus\(u\) === s\)\.length/);
  assert.match(page, /\.filter\(\(x\) => x\[1\] > 0\)/);
  assert.match(page, /tasks = \{[\s\S]*getUnitCurrentStatus\(u\) === "待場勘"[\s\S]*getUnitCurrentStatus\(u\) === "改善中"[\s\S]*getUnitCurrentStatus\(u\) === "待驗收"/);
});

test("account lifecycle is profile-gated, unit-safe, and server-authorized", async () => {
  const page = await read("app/page.tsx");
  const auth = await read("lib/auth-session.ts");
  const applicationApi = await read("app/api/account-applications/route.ts");
  const adminApi = await read("app/api/admin/users/route.ts");
  const migration = await read("supabase/migrations/202609030001_role_permissions.sql");
  assert.match(page, /spc_current_account_profile/);
  assert.doesNotMatch(page, /spc_current_role/);
  assert.doesNotMatch(page, /\? data as AppRole : "client"/);
  assert.match(auth, /role: Role \| null/);
  assert.match(auth, /applicationStatus: AccountApplicationStatus/);
  assert.match(page, /applicationStatus === "pending"[\s\S]*AccountStatusScreen/);
  assert.match(page, /applicationStatus === "rejected"[\s\S]*RejectedAccountScreen/);
  const gate = page.slice(page.indexOf('if (authSnapshot.applicationStatus === "pending")'), page.indexOf("function AuthLoading"));
  assert.match(gate, /!authSnapshot\.active \|\| authSnapshot\.applicationStatus !== "approved"/);
  assert.match(gate, /AuthOwnerContext\.Provider[\s\S]*AdminApp/);
  assert.doesNotMatch(gate.slice(0, gate.indexOf("return <AuthOwnerContext.Provider")), /AuthOwnerContext|AdminApp|loadWorkspace/);
  assert.match(adminApi, /select\("user_id, email, display_name, role, active, application_status"\)/);
  assert.match(page, /const title = user\.displayName \|\| identity/);
  assert.match(page, /client: "廠商"/);
  assert.doesNotMatch(page, /客戶端/);
  assert.match(page, /if \(pending\) \{ setApprovalRoles/);
  assert.doesNotMatch(page.match(/if \(pending\) \{[^}]+\}/)?.[0] || "", /\bact\(/);
  assert.match(adminApi, /action: "approve"/);
  assert.match(adminApi, /action: "reject"/);
  assert.match(adminApi, /roles\.has\(body\.role\)/);
  assert.match(adminApi, /LAST_ACTIVE_ADMIN/);
  assert.match(adminApi, /body\.userId === access\.user\.id/);
  assert.match(adminApi, /application_status !== "approved"/);
  assert.match(adminApi, /user_metadata: \{ \.\.\.target\.data\.user\.user_metadata, display_name: displayName \}/);
  const rejectPath = adminApi.slice(adminApi.indexOf('if (body.action === "reject")'), adminApi.indexOf("if (body.userId === access.user.id"));
  assert.doesNotMatch(rejectPath, /deleteUser|password|876000h/);
  assert.match(rejectPath, /ban_duration: "none"/);
  assert.match(applicationApi, /export async function PATCH/);
  assert.match(applicationApi, /authorization/);
  assert.match(applicationApi, /auth\.getUser\(token\)/);
  assert.doesNotMatch(applicationApi.slice(applicationApi.indexOf("export async function PATCH")), /body\.userId/);
  assert.match(applicationApi, /application_status !== "rejected"/);
  assert.match(applicationApi, /applicationRoles/);
  assert.doesNotMatch(applicationApi, /applicationRoles[^\n]+admin/);
  assert.match(page, /const canManageAccounts = appRole === "admin"/);
  assert.match(migration, /spc_current_account_profile\(\)/);
  assert.match(migration, /where user_role\.user_id = auth\.uid\(\)/);
  assert.match(migration, /revoke all on function public\.spc_current_account_profile\(\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.spc_current_account_profile\(\) to authenticated/);
  assert.doesNotMatch(migration, /delete\s+from|truncate|storage\.|spc_workspace/);
});

test("role permission matrix loads and saves only the three configurable roles", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const api = await read("app/api/admin/users/route.ts");
  const auth = await read("lib/auth-session.ts");
  const matrix = page.slice(page.indexOf("const permissionLabels"), page.indexOf("function SystemEntry"));
  for (const label of ["修改戶別資料", "場勘", "施工", "驗收", "驗收日誌", "缺失改善", "應收帳款", "細總表", "全部"]) assert.match(matrix, new RegExp(label));
  assert.match(matrix, /CONFIGURABLE_ROLES\.map/);
  assert.match(matrix, /crew: "工班人員", client: "廠商", sales: "代銷"/);
  assert.doesNotMatch(matrix.match(/configurableRoleLabels[^;]+/)?.[0] || "", /admin|shenyin/);
  assert.match(matrix, /setAllRolePermissions\(current\[role\], checked\)/);
  assert.match(matrix, /hasAllRolePermissions\(value\)/);
  assert.match(matrix, /setPermissionsDraft[\s\S]*有尚未儲存的變更[\s\S]*儲存權限設定/);
  const checkboxUpdate = matrix.slice(matrix.indexOf("const updatePermission"), matrix.indexOf("const savePermissions"));
  assert.doesNotMatch(checkboxUpdate, /adminRequest|fetch\(/);
  assert.match(api, /rolePermissions: rolePermissionMatrixFromDatabaseRows\(permissionRows\)/);
  assert.match(api, /action: "permissions"/);
  assert.match(api, /parseRolePermissionMatrix\(body\.permissions\)/);
  assert.match(api, /Authorization: `Bearer \$\{access\.token\}`/);
  assert.match(api, /caller\.rpc\("spc_admin_save_role_permissions", \{ p_permissions: permissions \}\)/);
  assert.doesNotMatch(matrix, /from\("spc_role_permissions"\)|spc_admin_save_role_permissions/);
  assert.match(page, /supabase\.rpc\("spc_current_permissions"\)/);
  assert.match(auth, /permissions: RolePermissions/);
  assert.match(auth, /AUTH_PERMISSIONS_TIMEOUT/);
  assert.doesNotMatch(matrix, /localStorage|saveWorkspace|loadWorkspace/);
  assert.match(css, /\.role-permission-scroll\{[^}]*overflow-x:auto/);
  assert.match(css, /\.role-permission-matrix th:first-child\{[^}]*position:sticky/);
  assert.match(css, /\.role-permission-matrix label\{[^}]*min-width:44px;min-height:44px/);
  const accessLogic = page.slice(page.indexOf("const canUseSystem"), page.indexOf("const sideViews"));
  assert.match(accessLogic, /canUseView = canUsePermissionView/);
  assert.match(accessLogic, /canUseUnitTab = canUsePermissionUnitTab/);
});

test("phase 5A-1 adds fail-closed internal workspace authorization helpers only", async () => {
  const sql = await read("supabase/migrations/202609040001_workspace_permission_enforcement.sql");
  const primitives = sql.slice(0, sql.indexOf("create or replace function public.spc_merge_permissioned_projects"));

  assert.match(sql, /create or replace function public\.spc_current_approved_role\(\)/i);
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public/i);
  assert.match(sql, /user_role\.user_id = auth\.uid\(\)/i);
  assert.match(sql, /user_role\.active = true/i);
  assert.match(sql, /user_role\.application_status = 'approved'/i);
  assert.match(sql, /user_role\.role in \('admin', 'shenyin', 'crew', 'client', 'sales'\)/i);

  assert.match(sql, /create or replace function public\.spc_current_effective_permissions\(\)/i);
  for (const column of [
    "edit_unit_master", "use_survey", "use_work", "use_acceptance",
    "use_acceptance_journal", "use_defects", "export_receivables", "export_shipment_details",
  ]) assert.match(sql, new RegExp(`${column} boolean`, "i"));
  assert.match(sql, /approved_role in \('admin', 'shenyin'\)[\s\S]*select true, true, true, true, true, true, true, true/i);
  assert.match(sql, /from public\.spc_role_permissions as permission[\s\S]*permission\.role = approved_role/i);
  assert.match(sql, /approved_role = 'crew'[\s\S]*select true, true, true, true, true, true, false, false/i);
  assert.match(sql, /select true, false, false, false, false, false, false, false/i);
  assert.match(sql, /else[\s\S]*select false, false, false, false, false, false, false, false/i);

  for (const helper of ["spc_current_approved_role", "spc_current_effective_permissions"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${helper}\\(\\) from public, anon, authenticated`, "i"));
    assert.doesNotMatch(sql, new RegExp(`grant execute on function public\\.${helper}\\(\\) to authenticated`, "i"));
  }
  assert.doesNotMatch(primitives, /create or replace function public\.(?:spc_load_workspace|spc_merge_workspace|spc_merge_restricted_projects)\b/i);
  assert.doesNotMatch(sql, /create or replace function public\.spc_json_merge_three_way(?:_at)?\s*\(/i);
  assert.doesNotMatch(sql, /\bstorage\.|delete\s+from|update\s+public\.|truncate\b/i);
});

test("phase 5A-2 permissioned project merge is current-driven and field-allowlisted", async () => {
  const sql = await read("supabase/migrations/202609040001_workspace_permission_enforcement.sql");
  const start = sql.indexOf("create or replace function public.spc_merge_permissioned_projects");
  const end = sql.indexOf("create or replace function public.spc_filter_permissioned_workspace", start);
  const merge = sql.slice(start, end);

  assert.ok(start >= 0);
  assert.match(merge, /spc_merge_permissioned_projects\(\s*p_current jsonb,\s*p_incoming jsonb\s*\)/i);
  assert.doesNotMatch(merge, /\bp_role\b|\bp_permissions\b/);
  assert.match(merge, /public\.spc_current_approved_role\(\)/i);
  assert.match(merge, /public\.spc_current_effective_permissions\(\)/i);
  assert.match(merge, /security definer[\s\S]*set search_path = pg_catalog, public/i);
  assert.match(merge, /approved_role in \('admin', 'shenyin'\)[\s\S]*return p_incoming/i);
  assert.match(merge, /approved_role is null or approved_role not in \('crew', 'client', 'sales'\)[\s\S]*return p_current/i);

  assert.match(merge, /for current_project in[\s\S]*jsonb_array_elements\(coalesce\(p_current/i);
  assert.match(merge, /for current_unit in[\s\S]*jsonb_array_elements\(coalesce\(current_project->'units'/i);
  assert.match(merge, /merged_project := current_project/);
  assert.match(merge, /if permissions\.use_acceptance_journal[\s\S]*incoming_project \? 'journals'[\s\S]*jsonb_build_object\(\s*'journals', coalesce\(incoming_project->'journals', current_project->'journals'\)/i);
  assert.doesNotMatch(merge, /current_project\s*\|\|\s*incoming_project|merged_project\s*:=\s*current_project\s*\|\|\s*incoming_project/i);
  assert.doesNotMatch(merge, /merged_projects\s*:=\s*merged_projects\s*\|\|\s*p_incoming/i);
  assert.doesNotMatch(merge, /merged_units\s*:=\s*merged_units\s*\|\|\s*coalesce\(incoming_project->'units'/i);

  const masterBlock = merge.slice(merge.indexOf("if permissions.edit_unit_master"), merge.indexOf("if permissions.use_survey"));
  for (const field of [
    "building", "floor", "number", "owner", "phone", "email", "lineId", "customerRole",
    "contactPreference", "customerNeed", "marketingConsent", "consentAt", "customerSource", "order",
    "brand", "model", "colorNo", "spec", "estimated", "custom", "customNote", "note",
  ]) assert.match(masterBlock, new RegExp(`'${field}'`));
  assert.doesNotMatch(masterBlock, /'status'/);

  for (const [permission, collection] of [
    ["use_survey", "surveys"], ["use_work", "works"], ["use_acceptance", "acceptances"],
    ["use_acceptance_journal", "journals"], ["use_defects", "defects"],
  ]) assert.match(merge, new RegExp(`if permissions\\.${permission}[\\s\\S]*jsonb_build_object\\('${collection}'`, "i"));
  assert.doesNotMatch(merge, /permissions\.export_(?:receivables|shipment_details)[\s\S]*jsonb_build_object/i);

  assert.match(merge, /events_writable := permissions\.use_survey[\s\S]*or permissions\.use_work[\s\S]*or permissions\.use_acceptance[\s\S]*or permissions\.use_defects/i);
  assert.doesNotMatch(merge.slice(merge.indexOf("events_writable :="), merge.indexOf("for current_project")), /edit_unit_master|use_acceptance_journal|export_/i);
  assert.match(merge, /if events_writable[\s\S]*jsonb_build_object\('events'/i);

  assert.match(merge, /current_status in \('待場勘', '場勘待改善'\)[\s\S]*incoming_status in \('待場勘', '場勘待改善', '可進場'\)/);
  assert.match(merge, /current_status in \('可進場', '施工中'\)[\s\S]*incoming_status in \('施工中', '待驗收'\)/);
  assert.match(merge, /current_status in \('待驗收', '待複驗'\)[\s\S]*incoming_status in \('驗收缺失', '已驗收'\)/);
  assert.match(merge, /current_status in \('場勘待改善', '驗收缺失', '改善中'\)[\s\S]*incoming_status in \('驗收缺失', '改善中', '待複驗', '可進場'\)/);
  assert.doesNotMatch(merge, /current_status in \([^)]*'待確認'/);
  for (const [evidence, collection] of [
    ["survey_changed", "surveys"], ["work_changed", "works"],
    ["acceptance_changed", "acceptances"], ["defects_changed", "defects"],
  ]) {
    assert.match(merge, new RegExp(`${evidence} := incoming_unit \\? '${collection}'[\\s\\S]*incoming_unit->'${collection}' is distinct from current_unit->'${collection}'`, "i"));
    assert.match(merge, new RegExp(`permissions\\.[a-z_]+ and ${evidence}[\\s\\S]*current_status in`, "i"));
  }
  const statusGuard = merge.slice(merge.indexOf("if incoming_status is not null"), merge.indexOf("merged_units :=", merge.indexOf("if incoming_status is not null")));
  assert.doesNotMatch(statusGuard, /events_writable|'events'/i);
  assert.match(merge, /if permissions\.use_survey then[\s\S]*jsonb_build_object\('surveys'/i);

  assert.match(sql, /revoke all on function public\.spc_merge_permissioned_projects\(jsonb, jsonb\) from public, anon, authenticated/i);
  assert.doesNotMatch(sql, /grant execute on function public\.spc_merge_permissioned_projects\(jsonb, jsonb\) to authenticated/i);
  assert.doesNotMatch(sql, /create or replace function public\.spc_json_merge_three_way(?:_at)?\b/i);
  assert.doesNotMatch(sql, /\bstorage\.|create\s+policy/i);
});

test("phase 5A-3 filters workspace reads and keeps crew customer fields read/write private", async () => {
  const sql = await read("supabase/migrations/202609040001_workspace_permission_enforcement.sql");
  const loadStart = sql.indexOf("create or replace function public.spc_filter_permissioned_workspace");
  const loadEnd = sql.indexOf("create or replace function public.spc_load_workspace()", loadStart);
  const load = sql.slice(loadStart, loadEnd);
  const writeStart = sql.indexOf("create or replace function public.spc_merge_permissioned_projects");
  const writeEnd = sql.indexOf("create or replace function public.spc_filter_permissioned_workspace", writeStart);
  const write = sql.slice(writeStart, writeEnd);

  assert.ok(loadStart >= 0);
  assert.match(load, /spc_filter_permissioned_workspace\(\s*p_snapshot jsonb\s*\)/i);
  assert.doesNotMatch(load, /\bp_role\b|\bp_permissions\b|spc_current_role\(\)/i);
  assert.match(load, /public\.spc_current_approved_role\(\)/i);
  assert.match(load, /public\.spc_current_effective_permissions\(\)/i);
  assert.match(load, /security definer[\s\S]*set search_path = pg_catalog, public/i);
  assert.match(load, /approved_role in \('admin', 'shenyin'\)[\s\S]*return p_snapshot/i);
  assert.match(load, /approved_role is null or approved_role not in \('crew', 'client', 'sales'\)[\s\S]*raise exception 'SPC_ACCESS_REQUIRED'[\s\S]*42501/i);

  for (const [permission, collection] of [
    ["use_survey", "surveys"], ["use_work", "works"], ["use_acceptance", "acceptances"],
    ["use_acceptance_journal", "journals"], ["use_defects", "defects"],
  ]) assert.match(load, new RegExp(`'${collection}', case when permissions\\.${permission}[\\s\\S]*else '\\[\\]'::jsonb`, "i"));
  assert.match(load, /filtered_project := source_project \|\| jsonb_build_object\(\s*'journals', case[\s\S]*permissions\.use_acceptance_journal[\s\S]*else '\[\]'::jsonb/i);
  assert.match(load, /'events', '\[\]'::jsonb/i);
  assert.doesNotMatch(load, /permissions\.[a-z_]+[\s\S]*'events', case/i);

  assert.match(load, /approved_role = 'crew'[\s\S]*jsonb_build_object\('contact', '', 'phone', ''\)/i);
  const sensitive = ["owner", "phone", "email", "lineId", "customerRole", "contactPreference", "customerNeed", "marketingConsent", "consentAt", "customerSource"];
  for (const field of sensitive) assert.match(load, new RegExp(`'${field}'`));
  assert.match(load, /if approved_role = 'crew'[\s\S]*filtered_unit := filtered_unit - array/i);
  assert.doesNotMatch(load, /approved_role in \('client', 'sales'\)[\s\S]*filtered_unit := filtered_unit - array/i);
  assert.doesNotMatch(load, /export_receivables|export_shipment_details/i);

  const masterStart = write.indexOf("if permissions.edit_unit_master");
  const workflowStart = write.indexOf("if permissions.use_survey", masterStart);
  const master = write.slice(masterStart, workflowStart);
  assert.match(master, /approved_role in \('client', 'sales'\)[\s\S]*'owner'[\s\S]*'customerSource'/i);
  for (const field of ["building", "floor", "number", "order", "brand", "model", "colorNo", "spec", "estimated", "custom", "customNote", "note"])
    assert.match(master.slice(0, master.indexOf("if approved_role in")), new RegExp(`'${field}'`));
  assert.doesNotMatch(master.slice(0, master.indexOf("if approved_role in")), /'owner'|'customerNeed'|'customerSource'/i);
  assert.match(write, /approved_role in \('admin', 'shenyin'\)[\s\S]*return p_incoming/i);

  assert.match(sql, /revoke all on function public\.spc_filter_permissioned_workspace\(jsonb\) from public, anon, authenticated/i);
  assert.doesNotMatch(sql, /grant execute on function public\.spc_filter_permissioned_workspace\(jsonb\) to authenticated/i);
  assert.doesNotMatch(sql, /create or replace function public\.spc_merge_restricted_projects\b/i);
  assert.doesNotMatch(sql, /create or replace function public\.spc_json_merge_three_way(?:_at)?\b/i);
  assert.doesNotMatch(sql, /\bstorage\.|create\s+policy|delete\s+from|update\s+public\.|truncate\b/i);
});

test("phase 5A-4 integrates approved permission helpers into workspace load and collaborative merge", async () => {
  const sql = await read("supabase/migrations/202609040001_workspace_permission_enforcement.sql");
  const loadStart = sql.indexOf("create or replace function public.spc_load_workspace()");
  const mergeStart = sql.indexOf("create or replace function public.spc_merge_workspace(", loadStart);
  const grantsStart = sql.indexOf("-- Internal helpers", mergeStart);
  const load = sql.slice(loadStart, mergeStart);
  const merge = sql.slice(mergeStart, grantsStart);

  assert.ok(loadStart >= 0 && mergeStart > loadStart);
  assert.match(load, /public\.spc_current_approved_role\(\)/i);
  assert.doesNotMatch(load, /spc_current_role\(\)/i);
  assert.match(load, /approved_role is null or approved_role not in \('admin', 'shenyin', 'crew', 'client', 'sales'\)[\s\S]*raise exception 'SPC_ACCESS_REQUIRED'[\s\S]*42501/i);
  assert.match(load, /snapshot := public\.spc_load_workspace_unchecked\(\)/i);
  assert.match(load, /return public\.spc_filter_permissioned_workspace\(snapshot\)/i);
  assert.match(sql, /revoke all on function public\.spc_load_workspace\(\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.spc_load_workspace\(\) to authenticated/i);

  assert.match(merge, /spc_merge_workspace\(\s*p_base_version bigint,\s*p_base_projects jsonb,\s*p_projects jsonb,\s*p_base_catalog jsonb,\s*p_catalog jsonb\s*\)[\s\S]*returns jsonb/i);
  assert.match(merge, /approved_role text := public\.spc_current_approved_role\(\)/i);
  assert.doesNotMatch(merge, /spc_current_role\(\)/i);
  assert.match(merge, /auth\.uid\(\) is null[\s\S]*approved_role is null[\s\S]*approved_role not in \('admin', 'shenyin', 'crew', 'client', 'sales'\)[\s\S]*42501/i);
  assert.match(merge, /perform 1\s*from public\.spc_workspaces\s*where id = 'main'\s*for update/i);
  assert.match(merge, /current_snapshot := public\.spc_load_workspace_unchecked\(\)/i);
  assert.match(merge, /if approved_role not in \('admin', 'shenyin'\) then/i);
  assert.match(merge, /p_projects := public\.spc_merge_permissioned_projects\(\s*current_snapshot->'projects',\s*p_projects\s*\)/i);
  assert.match(merge, /p_base_projects := public\.spc_merge_permissioned_projects\(\s*current_snapshot->'projects',\s*p_base_projects\s*\)/i);
  assert.equal((merge.match(/public\.spc_merge_permissioned_projects\(/g) || []).length, 2);
  assert.match(merge, /p_catalog := current_snapshot->'catalog';\s*p_base_catalog := current_snapshot->'catalog'/i);
  assert.doesNotMatch(merge.slice(0, merge.indexOf("if approved_role not in")), /spc_merge_permissioned_projects/i);

  assert.equal((merge.match(/public\.spc_json_merge_three_way\(/g) || []).length, 2);
  assert.match(merge, /coalesce\(p_base_projects, '\[\]'::jsonb\)[\s\S]*coalesce\(p_projects, '\[\]'::jsonb\)[\s\S]*current_snapshot->'projects'/i);
  assert.match(merge, /public\.spc_save_workspace_unchecked\(/i);
  assert.match(merge, /perform public\.spc_log_workspace_changes\(/i);
  assert.match(merge, /return jsonb_build_object\(\s*'version', new_version,\s*'merged', p_base_version <> \(current_snapshot->>'version'\)::bigint/i);
  assert.match(sql, /revoke all on function public\.spc_merge_workspace\(bigint, jsonb, jsonb, jsonb, jsonb\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.spc_merge_workspace\(bigint, jsonb, jsonb, jsonb, jsonb\) to authenticated/i);

  assert.doesNotMatch(sql, /create or replace function public\.(?:spc_save_workspace|spc_merge_restricted_projects|spc_json_merge_three_way|spc_json_merge_three_way_at)\b/i);
  assert.doesNotMatch(sql, /\bstorage\.|create\s+policy|delete\s+from|truncate\b|update\s+public\.spc_workspaces/i);
});

test("phase 5A-5 atomically appends only new workflow-created defects without granting defect management", async () => {
  const sql = await read("supabase/migrations/202609040001_workspace_permission_enforcement.sql");
  const mergeStart = sql.indexOf("create or replace function public.spc_merge_permissioned_projects");
  const mergeEnd = sql.indexOf("create or replace function public.spc_filter_permissioned_workspace", mergeStart);
  const merge = sql.slice(mergeStart, mergeEnd);
  const atomicStart = merge.indexOf("if permissions.use_defects then");
  const atomicEnd = merge.indexOf("if events_writable then", atomicStart);
  const defects = merge.slice(atomicStart, atomicEnd);
  const loadStart = sql.indexOf("create or replace function public.spc_filter_permissioned_workspace");
  const loadEnd = sql.indexOf("create or replace function public.spc_load_workspace()", loadStart);
  const load = sql.slice(loadStart, loadEnd);

  assert.match(defects, /if permissions\.use_defects then[\s\S]*jsonb_build_object\('defects', coalesce\(incoming_unit->'defects', current_unit->'defects'\)\)/i);
  assert.match(defects, /elsif \(permissions\.use_survey and survey_changed\)\s*or \(permissions\.use_acceptance and acceptance_changed\) then/i);
  assert.match(defects, /atomic_defects := coalesce\(current_unit->'defects', '\[\]'::jsonb\)/i);
  assert.match(defects, /jsonb_array_elements\(coalesce\(incoming_unit->'defects', '\[\]'::jsonb\)\)/i);
  assert.match(defects, /incoming_defect->>'id'[\s\S]*not exists \([\s\S]*jsonb_array_elements\(atomic_defects\) as existing_defect\(value\)[\s\S]*existing_defect\.value->>'id' = incoming_defect->>'id'/i);
  assert.match(defects, /permissions\.use_survey and survey_changed and incoming_defect->>'source' = '場勘'/i);
  assert.match(defects, /permissions\.use_acceptance and acceptance_changed and incoming_defect->>'source' = '驗收'/i);
  assert.match(defects, /atomic_defects := atomic_defects \|\| jsonb_build_array\(incoming_defect\)/i);
  assert.match(defects, /merged_unit := merged_unit \|\| jsonb_build_object\('defects', atomic_defects\)/i);
  assert.equal((defects.match(/jsonb_build_array\(incoming_defect\)/g) || []).length, 1);
  assert.doesNotMatch(defects, /permissions\.use_survey\s+or\s+permissions\.use_acceptance\s+or\s+permissions\.use_defects/i);

  const statusStart = merge.indexOf("if incoming_status is not null");
  const statusEnd = merge.indexOf("merged_units :=", statusStart);
  const status = merge.slice(statusStart, statusEnd);
  assert.match(status, /permissions\.use_survey and survey_changed/i);
  assert.match(status, /permissions\.use_acceptance and acceptance_changed/i);
  assert.match(status, /permissions\.use_defects and defects_changed/i);
  assert.doesNotMatch(status, /atomic_defects|incoming_defect/i);
  assert.match(load, /'defects', case when permissions\.use_defects then[\s\S]*else '\[\]'::jsonb end/i);

  const workspaceIntegration = sql.slice(sql.indexOf("create or replace function public.spc_load_workspace()"));
  assert.match(workspaceIntegration, /spc_merge_permissioned_projects\(\s*current_snapshot->'projects',\s*p_projects/i);
  assert.match(workspaceIntegration, /spc_merge_permissioned_projects\(\s*current_snapshot->'projects',\s*p_base_projects/i);
  assert.match(merge, /approved_role in \('admin', 'shenyin'\)[\s\S]*return p_incoming/i);
  assert.doesNotMatch(sql, /create or replace function public\.spc_json_merge_three_way(?:_at)?\b/i);
  assert.doesNotMatch(sql, /\bstorage\.|create\s+policy|photo cleanup/i);
});

test("phase four permissions hide restricted UI and guard front-end operations", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const uiPermissions = await read("lib/ui-permissions.ts");
  const access = page.slice(page.indexOf("const canUseSystem"), page.indexOf("const sideViews"));
  const admin = page.slice(page.indexOf("function AdminApp("), page.indexOf("type ManagedUser"));
  const project = page.slice(page.indexOf("function ProjectArea("), page.indexOf("type ReportSourceDraft"));
  const units = page.slice(page.indexOf("function Units("), page.indexOf("function FloorAcceptanceView"));
  const unitDetail = page.slice(page.indexOf("function UnitDetail("), page.indexOf("function Next("));
  const next = page.slice(page.indexOf("function Next("), page.indexOf("function Master("));
  const master = page.slice(page.indexOf("function Master("), page.indexOf("function AutoRecord("));
  const accounts = page.slice(page.indexOf("function AccountManagement("), page.indexOf("function SystemEntry"));
  const billing = page.slice(page.indexOf("function Billing("), page.indexOf("type CompletionExportDraft"));

  assert.match(access, /canUseView = canUsePermissionView/);
  assert.match(access, /canUseUnitTab = canUsePermissionUnitTab/);
  assert.match(uiPermissions, /if \(view === "accounts"\) return role === "admin"/);
  assert.match(uiPermissions, /if \(hasFullBusinessAccess\(role\)\) return true/);
  for (const [key, permission] of [["daily-acceptance", "useAcceptance"], ["journal", "useAcceptanceJournal"]])
    assert.match(uiPermissions, new RegExp(`view === "${key}"[^\n]+permissions\\.${permission}`));
  assert.match(uiPermissions, /view === "billing"[^\n]+financeUiMode\(role, permissions\)\.canEnter/);
  for (const [tab, permission] of [["survey", "useSurvey"], ["work", "useWork"], ["journal", "useAcceptanceJournal"], ["defect", "useDefects"]])
    assert.match(uiPermissions, new RegExp(`tab === "${tab}"[^\n]+permissions\\.${permission}`));
  assert.match(uiPermissions, /tab === "accept" \|\| tab === "sheet"[^\n]+permissions\.useAcceptance/);
  assert.match(uiPermissions, /if \(tab === "master"\) return true/);

  assert.match(admin, /sideViews\.filter\(\(\[key\]\) => canUseView\(appRole, permissions, key\)\)/);
  assert.match(admin, /const canUseAcceptance = canUseUnitTab\(appRole, permissions, "accept"\)/);
  assert.match(admin, /if \(canUseAcceptance \|\| !floorContext\) return;[\s\S]*setFloorContext\(null\)/);
  assert.match(admin, /openFloor=\{\(building, floor\) => \{ if \(canUseAcceptance\)/);
  assert.match(unitDetail, /permissions: RolePermissions/);
  assert.match(unitDetail, /set=\{\(next\) => \{ if \(canUseUnitTab\(role, permissions, next\)\) setTab\(next\); \}\}/);
  assert.match(unitDetail, /if \(!canUseUnitTab\(role, permissions, tab\)\) setTab\("master"\)/);
  assert.match(unitDetail, /\.filter\(\(\[value\]\) => canUseUnitTab\(role, permissions, value\)\)/);
  assert.match(next, /if \(!canUseUnitTab\(role, permissions, t\)\) return null/);
  assert.match(units, /\{canAccept && <button className="floor-acceptance-entry"/);

  assert.match(units, /canEditExisting: boolean/);
  assert.match(units, /canCreate: boolean/);
  assert.match(units, /const create = \(\) => \{\s+if \(!canCreate\) return/);
  assert.match(units, /const createBatch = \(\) => \{\s+if \(!canCreate\) return/);
  assert.match(master, /canEditExisting: boolean/);
  assert.match(master, /canDelete: boolean/);
  assert.match(master, /canConfirm: boolean/);
  assert.match(master, /if \(!canEditExisting\) return/);
  assert.match(master, /disabled=\{!canEditExisting\}/);
  assert.match(master, /\{canDelete && <button[\s\S]*className="danger"/);
  assert.match(master, /\{canConfirm && \(u\.status === "待確認"/);
  assert.match(unitDetail, /patch=\{\(value\) => \{ if \(canEditExisting\) patch\(value\); \}\}/);
  assert.match(unitDetail, /remove=\{\(\) => \{ if \(canDelete\) remove\(\); \}\}/);

  assert.match(project, /safeView = canUseView\(role, permissions, view\)/);
  assert.match(project, /const financeAccess = financeUiMode\(role, permissions\)/);
  assert.match(billing, /const \{ canExportReceivables, canExportShipment, canManageFinance \} = financeAccess/);
  assert.match(billing, /if \(!receivableExportReady \|\| !financeExportProject\) return/);
  assert.match(billing, /if \(!shipmentExportReady \|\| !financeExportProject\) return/);
  assert.match(billing, /if \(!canManageFinance\) return/);
  assert.match(billing, /canExportReceivables && <button[\s\S]*應收帳款 Excel/);
  assert.match(billing, /canExportShipment && <button[\s\S]*SPC 已出貨明細總表/);
  assert.match(css, /\.shipment-export-preview\.finance-readonly[\s\S]*td:first-child[\s\S]*display:none/);
  assert.match(master, /const isCrew = role === "crew"/);
  assert.match(master, /const showCustomerDetails = !isCrew && canViewCustomerDetails\(role\)/);
  assert.match(master, /\{showCustomerDetails && <section className="customer-section unit-master-customer"/);

  assert.match(accounts, /permissionsDirty && !confirm\("尚未儲存的權限變更將被放棄，確定重新整理嗎？"\)\) return/);
  assert.match(accounts, /onClick=\{refreshUsers\}/);
  assert.doesNotMatch(project + unitDetail + master + billing, /delete\s+from|truncate|cleanupRemovedPhotos/);
});

test("floor acceptance entry stays a compact sibling action on the floor heading row", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const floorList = page.slice(page.indexOf("{buildingOpen && floors.map"), page.indexOf("{!shown.length"));
  const entryStart = floorList.indexOf('<button className="floor-acceptance-entry"');
  const entry = floorList.slice(entryStart, floorList.indexOf("</button>", entryStart) + "</button>".length);
  assert.match(floorList, /className="floor-row-main"[\s\S]*?<\/button>\s*\{canAccept && <button className="floor-acceptance-entry"/);
  assert.match(entry, /<b>驗收<\/b>/);
  assert.doesNotMatch(entry, /<small>|驗收／簽名/);
  assert.match(entry, /onClick=\{\(\) => openFloor\(/);
  const finalOverride = css.slice(css.lastIndexOf("Keep the floor acceptance entry compact"));
  assert.match(finalOverride, /\.unit-manager \.floor-head:not\(\.bulk\)\{[\s\S]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(finalOverride, /\.unit-manager \.floor-acceptance-entry\{[\s\S]*grid-column:auto!important;[\s\S]*width:auto!important;[\s\S]*min-height:44px!important/);
  assert.match(finalOverride, /@media\(max-width:700px\)[\s\S]*min-width:52px;[\s\S]*min-height:42px!important/);
  assert.doesNotMatch(finalOverride, /width:calc\(100% - 8px\)|grid-column:2/);
});

test("survey includes silicone, divider, parking, staging area, and two signatures", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["siliconeInspection", "dividerInspection", "parking", "stagingArea", "surveySignatures", "是否跟地板顏色一致", "其他顏色", "是否需要分隔條", "可停車數量", "停車位置說明", "放料區域", "注意事項", "場勘檢查人員簽名", "至少需要 2 位"]) assert.match(page, new RegExp(value));
  assert.doesNotMatch(page.slice(page.indexOf("const acceptLabels"), page.indexOf("const key")), /矽利康施工/);
  assert.match(page, /surveySignatures\.filter\(\(signature\) => signature\.valid\)\.length < 2/);
  assert.match(page, /survey-section-grid/);
  for (const detail of ["door", "silicone", "divider", "parking", "staging", "signatures"]) assert.match(page, new RegExp(`setSurveyDetail\\(\\"${detail}\\"\\)`));
});

test("divider note stays visible and optional for every needed state", async () => {
  const page = await read("app/page.tsx");
  const dividerModal = page.slice(page.indexOf('surveyDetail === "divider"'), page.indexOf('surveyDetail === "parking"'));
  const conditionalStart = dividerModal.indexOf('{divider.needed === "是" && <div className="grid3">');
  const conditionalFields = dividerModal.slice(conditionalStart, dividerModal.indexOf("</div>}", conditionalStart) + "</div>}".length);
  const validationStart = page.indexOf("dividerInvalid =");
  const dividerValidation = page.slice(validationStart, page.indexOf("\n", validationStart));

  assert.match(page, /dividerInspection\?: \{[\s\S]*?note: string/);
  assert.match(conditionalFields, /分隔條數量[\s\S]*分隔條位置/);
  assert.doesNotMatch(conditionalFields, /分隔條備註/);
  assert.match(dividerModal, /<Field label="分隔條備註（選填）" value=\{divider\.note\}/);
  assert.match(dividerModal, /needed !== "是" \? \{ quantity: undefined, location: "" \} : \{\}/);
  assert.doesNotMatch(dividerModal, /needed !== "是" \? \{[^}]*note/);
  assert.match(dividerValidation, /divider\.needed === "是"[\s\S]*Number\(divider\.quantity\)[\s\S]*divider\.location\.trim\(\)/);
  assert.doesNotMatch(dividerValidation, /divider\.note/);
  assert.match(page, /分隔條備註: dividerInspection\?\.note \|\| ""/);
});

test("records share notes, photos, optional measurements, confirmation, reopen, and unit journals", async () => {
  const page = await read("app/page.tsx");
  const pkg = JSON.parse(await read("package.json"));
  for (const value of ["數值（需要時填寫）", "最後確認｜場勘", "最後確認｜", "返回修改", "確認送出", "查看／修改", "暫存未完成場勘", "暫存未完成施工", "戶別工作日誌", "預覽／產生 Word", "確認產生 Word", "createdBy", "updatedAt"]) assert.match(page, new RegExp(value));
  assert.match(page, /journals: DailyNote\[\]/);
  assert.match(page, /downloadWorkJournalDocx/);
  assert.equal(pkg.dependencies.docx, "^9.7.1");
});

test("photo picker keeps separate camera and gallery inputs on one resilient handler", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const photos = page.slice(page.indexOf("function Photos"), page.indexOf("function PhotoGrid"));
  const camera = photos.slice(photos.indexOf('photo-source camera'), photos.indexOf('photo-source gallery'));
  const gallery = photos.slice(photos.indexOf('photo-source gallery'));
  assert.match(camera, /type="file"[\s\S]*accept="image\/\*"[\s\S]*useEnvironmentCapture[\s\S]*capture: "environment"/);
  assert.doesNotMatch(camera, /multiple/);
  assert.match(gallery, /type="file"[\s\S]*accept="image\/\*"[\s\S]*multiple/);
  assert.doesNotMatch(gallery, /capture=/);
  assert.equal((photos.match(/handleSelectedFiles\(input\.files\)/g) || []).length, 1);
  assert.match(page, /shouldUseEnvironmentCapture/);
  assert.match(photos, /for \(const file of selectedFiles\)/);
  assert.match(photos, /照片處理中…/);
  assert.match(css, /\.visually-hidden-file\{[^}]*position:absolute!important;[^}]*inset:0!important;[^}]*width:100%!important;[^}]*height:100%!important;[^}]*opacity:0!important;/);
  assert.doesNotMatch(css, /\.visually-hidden-file\{[^}]*display:none/);
});

test("offline IndexedDB outbox and acceptance exports are wired", async () => {
  const page = await read("app/page.tsx");
  const offline = await read("lib/offline-drafts.ts");
  const exports = await read("lib/acceptance-exports.ts");
  for (const value of ["indexedDB.open", "drafts", "outbox", "recordId", "baseVersion", "photoCount", "retries", "conflict"]) assert.match(offline, new RegExp(value));
  for (const value of ["應收帳款明細表", "SPC已出貨明細總表", "3.305785", "銷貨小計", "稅金", "應收合計", "發票字軌", "freeze", "autofilter", "printArea"]) assert.match(exports, new RegExp(value));
  for (const value of ["第一次使用，照這 5 步即可", "應收帳款 Excel", "報表／匯出", "SPC 已出貨明細總表", "shipmentRecords = monthlyBillingRecords", "createReceivableWorkbook", "saveReceivableWorkbook", "確認產生 Excel", "使用 Supabase 最新資料", "保留這台電腦內容並重新同步"]) assert.match(page, new RegExp(value));
  assert.doesNotMatch(page, /帳單 Word|createReceivableDocx|應收帳款明細表\.docx/);
});

test("unit header shows estimated area and readable status while inspection pages omit the six-step guide only", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const unitDetail = page.slice(page.indexOf("function UnitDetail("), page.indexOf("function Next("));
  const master = page.slice(page.indexOf("function Master("), page.indexOf("function SurveyTab"));
  const survey = page.slice(page.indexOf("function SurveyTab"), page.indexOf("function WorkTab"));
  const work = page.slice(page.indexOf("function WorkTab"), page.indexOf("function completionDefaults"));
  const accept = page.slice(page.indexOf("function AcceptTab"), page.indexOf("function DefectsTab"));
  assert.match(unitDetail, /\{unit\.brand\} \{unit\.model\}／\{unit\.colorNo\}/);
  assert.match(unitDetail, /className="unit-head-estimated"[\s\S]*<small>坪數<\/small>[\s\S]*Number\.isFinite\(unit\.estimated\) \? `\$\{unit\.estimated\} 坪` : "—"/);
  assert.match(master, /<span>坪數<\/span>[\s\S]*value=\{areaValueFromPing\(u\.estimated, estimatedUnit\)\}/);
  assert.match(unitDetail, /className="unit-head-current-status"[\s\S]*目前工程狀態[\s\S]*<Pill s=\{unit\.status\}/);
  assert.match(css, /\.unit-head-estimated,\.unit-head-current-status\{[^}]*display:flex;[^}]*flex-direction:column;[^}]*align-items:flex-start/);
  assert.match(css, /\.unit-head-current-status>small\{[^}]*color:#fff/);
  assert.doesNotMatch(page, /InspectionGuide|inspection-guide/);
  for (const value of ["進場條件場勘", "基本資料會沿用至後續所有工程節點。", "施工紀錄", "基本資料會沿用，施工時間由系統自動記錄。", "完工驗收", "基本資料與施工紀錄會自動帶入", "場勘開始時間", "施工紀錄時間", "驗收開始時間"]) assert.match(page, new RegExp(value));
  assert.equal((survey.match(/<AutoRecord label="場勘開始時間" at=\{s\.startedAt \|\| s\.date\} \/>/g) || []).length, 1);
  assert.ok(survey.indexOf("場勘開始時間") > survey.indexOf('title="歷次場勘"'));
  assert.equal((work.match(/<AutoRecord label="施工紀錄時間" at=\{w\.startedAt \|\| w\.date\} \/>/g) || []).length, 1);
  assert.ok(work.indexOf("施工紀錄時間") > work.indexOf('title="施工歷史（不覆蓋）"'));
  assert.equal((accept.match(/<AutoRecord label=\{a\.recheck \? "複驗開始時間" : "驗收開始時間"\} at=\{a\.startedAt \|\| a\.date\} \/>/g) || []).length, 1);
  assert.ok(accept.indexOf("驗收開始時間") > accept.indexOf('title="歷次驗收／複驗"'));
  assert.match(accept, /複驗開始時間/);
  assert.match(accept, /className="acceptance-work-date"[\s\S]*<b>施工日期<\/b>[\s\S]*u\.works\.map\(\(w\) => w\.date\)\.join\("、"\) \|\| "—"/);
  assert.ok(accept.indexOf("acceptance-work-date") > accept.indexOf('title="歷次驗收／複驗"'));
  assert.ok(accept.indexOf("acceptance-work-date") < accept.indexOf("驗收開始時間"));
  assert.doesNotMatch(survey, /結束查看／建立新場勘|正在查看最新場勘紀錄/);
  assert.doesNotMatch(work, /結束查看／建立新施工|正在查看最新施工紀錄/);
  assert.doesNotMatch(accept, /結束查看／建立新驗收|正在查看最新正式驗收／複驗紀錄/);
  assert.doesNotMatch(accept, /實際施工坪數|施工照片<b>/);
  assert.doesNotMatch(work, /label="本次施工坪數"[\s\S]*value=\{w\.area\}/);
  assert.match(work, /area: u\.estimated/);
});

test("survey door photos are optional while required checks and rationale remain enforced", async () => {
  const page = await read("app/page.tsx");
  const survey = page.slice(page.indexOf("function SurveyTab"), page.indexOf("function WorkTab"));
  const validation = survey.slice(survey.indexOf("doorItemsInvalid ="), survey.indexOf("siliconeInvalid ="));
  const doorModal = survey.slice(survey.indexOf('surveyDetail === "door"'), survey.indexOf('surveyDetail === "silicone"'));

  assert.match(validation, /doorInvalid = \(door\.meetsThreshold === null \|\| door\.meetsThreshold === undefined\) \|\| door\.hasGap === null \|\| \(doorResult === "不合格" && !door\.rationale\.trim\(\)\)/);
  assert.doesNotMatch(validation.slice(validation.indexOf("doorInvalid =")), /door\.photos/);
  assert.match(validation, /doorItemEvidenceInvalid = doorItems\.some/);
  assert.match(doorModal, /<Photos node="場勘｜門檢查" label="門檢查照片" photos=\{door\.photos \|\| \[\]\}/);
  assert.doesNotMatch(doorModal, /上傳至少 1 張門檻照片|門檢查不合格時[^<]*照片/);
});

test("survey signature roles preserve shape and only a valid index-zero save syncs person", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const surveyType = page.slice(page.indexOf("type Survey ="), page.indexOf("type Work ="));
  const survey = page.slice(page.indexOf("function SurveyTab"), page.indexOf("function WorkTab"));
  const signaturePanel = survey.slice(survey.indexOf('surveyDetail === "signatures"'), survey.indexOf("{incomplete &&"));
  const signing = survey.slice(survey.indexOf("{surveySigning !== null"), survey.indexOf('<div className="form-actions">', survey.indexOf("{surveySigning !== null")));
  const signed = page.slice(page.indexOf("function Signed"), page.indexOf("function Sign("));
  const personDisplay = survey.slice(survey.indexOf('<div className="grid3">', survey.indexOf("<Checklist")), survey.indexOf("<Photos", survey.indexOf("<Checklist")));

  assert.match(surveyType, /surveySignatures\?: \{ name: string; data: string; at: string; valid: boolean \}\[\]/);
  assert.match(signaturePanel, /\["場勘人員", "工班人員"\][\s\S]*\.map\(\(role, index\)/);
  assert.match(signaturePanel, /surveySignatures\[index\]\?\.valid \? <>[\s\S]*<Signed s=\{surveySignatures\[index\]\} \/>[\s\S]*onClick=\{\(\) => setSurveySigning\(index\)\}>修改簽名<\/button><\/>/);
  assert.match(signaturePanel, /disabled=\{index === 1 && !surveySignatures\[0\]\?\.valid\}[\s\S]*觸控電子簽名/);
  assert.doesNotMatch(signed, /修改簽名|setSurveySigning/);
  assert.match(signing, /if \(!signature\.valid\) return/);
  assert.match(signing, /nextSignatures\[surveySigning\] = signature/);
  assert.match(signing, /surveySigning === 0 \? \{ person: signature\.name \} : \{\}/);
  assert.match(signing, /close=\{\(\) => setSurveySigning\(null\)\}/);
  assert.match(personDisplay, /<div className="field"><span>場勘人員<\/span><strong>\{s\.person \|\| "尚未簽名"\}<\/strong><\/div>/);
  assert.doesNotMatch(personDisplay, /<Field[\s\S]*label="場勘人員"|set=\{\(person: string\) => setS/);
  assert.doesNotMatch(css, /\.survey-tab \.survey-section-grid \.signature-tile\{grid-column:span 2\}/);
  assert.match(css, /\.completion-signatures\{display:grid/);
  assert.match(css, /\.floor-signature-grid\{display:grid/);
  assert.doesNotMatch(survey, /person:\s*["'](?:場勘人員|工班人員)["']/);
  assert.doesNotMatch(survey, /surveySignatures[\s\S]{0,80}(?:backfill|migration)/i);
});

test("billing screen, receivable Excel, and totals share the selected month records", async () => {
  const page = await read("app/page.tsx");
  for (const value of [
    "monthlyBillingRecords = financeExportProject ? buildAcceptanceExportRecords(financeExportProject).filter",
    "const shipmentDate = record.shipmentDateText?.trim() || record.exportDate",
    "shipmentDate.startsWith(ym)",
    "shipmentRecords = monthlyBillingRecords",
    "billSubtotal = billRecords.reduce",
    "record.areaPing",
    "record.amount",
  ]) assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(page, /\.filter\(\(record\) => record\.exportDate\.startsWith\(ym\)\)/);
  assert.doesNotMatch(page, /\bexportCsv\b|CSV 匯出|月結戶別明細 · CSV|月結\.csv/);
});

test("monthly shipment filtering prefers the formal shipment date and safely falls back", async () => {
  const page = await read("app/page.tsx");
  const billing = page.slice(page.indexOf("function Billing("), page.indexOf("type CompletionExportDraft"));
  const included = (record, ym) => (record.shipmentDateText?.trim() || record.exportDate).startsWith(ym);

  assert.match(billing, /const shipmentDate = record\.shipmentDateText\?\.trim\(\) \|\| record\.exportDate;[\s\S]*return shipmentDate\.startsWith\(ym\)/);
  assert.equal(included({ shipmentDateText: "2026-08-27", exportDate: "2026-09-01" }, "2026-09"), false);
  assert.equal(included({ shipmentDateText: "2026-09-02", exportDate: "2026-08-31" }, "2026-09"), true);
  assert.equal(included({ shipmentDateText: "", exportDate: "2026-09-01" }, "2026-09"), true);
  assert.equal(included({ shipmentDateText: "   ", exportDate: "2026-09-01" }, "2026-09"), true);
  assert.equal(included({ exportDate: "2026-09-01" }, "2026-09"), true);
});

test("electronic acceptance excludes drafts after billing CSV export removal", async () => {
  const page = await read("app/page.tsx");
  const acceptanceRecords = await read("lib/acceptance-records.ts");
  const acceptanceExports = await read("lib/acceptance-exports.ts");
  for (const value of [
    "const a = getLatestFinalAcceptance(u)",
    "目前尚無正式驗收紀錄，完成驗收後即可產生電子驗收單。",
  ]) assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(page, /\bexportCsv\b|CSV 匯出|月結戶別明細 · CSV/);
  for (const value of ["getLatestFinalAcceptance", "acceptance.draft !== true", "acceptanceRecordTime(acceptance) > acceptanceRecordTime(latest)"])
    assert.match(acceptanceRecords, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(acceptanceExports, /const acceptance = getLatestFinalAcceptance\(unit\)/);
  assert.doesNotMatch(acceptanceExports, /\.find\(\(item\) => !item\.draft\)/);
  assert.doesNotMatch(page, /const a = u\.acceptances\[0\]/);
});

test("work journal Word export uses adaptive borderless six-photo pages", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const exporter = page.slice(page.indexOf("async function buildJournalPhotoRun"), page.indexOf("function UnitJournalTab"));
  assert.match(exporter, /const PHOTO_PER_PAGE = 6/);
  assert.match(exporter, /planJournalPhotoRows\(firstPagePhotos\.slice\(1\)\)/);
  assert.match(exporter, /planJournalPhotoRows\(pagePhotos\)/);
  assert.match(exporter, /measuredPhotos\.slice\(index \* PHOTO_PER_PAGE, \(index \+ 1\) \* PHOTO_PER_PAGE\)/);
  assert.match(exporter, /photoPages\.slice\(1\)/);
  assert.match(exporter, /Math\.min\(maxWidth \/ intrinsic\.width, maxHeight \/ intrinsic\.height\)/);
  assert.match(exporter, /Math\.floor\(columnWidth \/ 15\) - 4/);
  assert.match(exporter, /buildJournalPhotoRun\(firstPagePhotos\[0\]\.value, 320, 300, firstPagePhotos\[0\]\)/);
  assert.match(exporter, /Math\.floor\(570 \/ Math\.max\(1, firstPageRows\.length\)\)/);
  assert.match(exporter, /Math\.floor\(900 \/ Math\.max\(1, followingRows\.length\)\)/);
  assert.match(exporter, /Math\.min\(440, availableWidth\)/);
  assert.match(exporter, /margins: \{ top: 30, bottom: 30, left: 30, right: 30 \}/);
  assert.match(exporter, /spacing: \{ after: 105 \}[\s\S]*bold: true, size: 24[\s\S]*text: value \|\| "—", size: 24/);
  assert.match(exporter, /cantSplit: true/);
  assert.match(exporter, /JOURNAL_NO_BORDERS[\s\S]*BorderStyle\.NIL/);
  assert.match(exporter, /borders: JOURNAL_NO_BORDERS/);
  assert.match(exporter, /fetch\("\/shen-yin-logo\.png"\)/);
  assert.doesNotMatch(exporter, /dist\/client\/shen-yin-logo/);
  assert.match(exporter, /columnWidths: \[3120, 3120, 3120\]/);
  assert.match(exporter, /journalHeader[\s\S]*alignment: AlignmentType\.CENTER/);
  assert.match(exporter, /photoTable[\s\S]*alignment: AlignmentType\.CENTER/);
  assert.match(exporter, /columnWidths: \[4540, 4820\][\s\S]*alignment: AlignmentType\.CENTER|alignment: AlignmentType\.CENTER[\s\S]*columnWidths: \[4540, 4820\]/);
  assert.match(exporter, /size: \{ width: 11906, height: 16838, orientation: PageOrientation\.PORTRAIT \}/);
  assert.match(exporter, /margin: \{ top: 720, right: 720, bottom: 720, left: 720 \}/);
  assert.match(exporter, /text: "SPC 工程工作日誌"/);
  assert.match(exporter, /"無工作照片"/);
  assert.doesNotMatch(exporter, /工作照片", bold|圖一|圖二|cleanupRemovedPhotos|uploadEmbeddedPhotos|entry\.photos\s*=/);
  assert.match(page, /word-preview-first-row[\s\S]*entry\.photos\[0\][\s\S]*JournalWordPreviewPhotoRows photos=\{entry\.photos\}/);
  assert.match(page, /function JournalWordPreviewPhotoRows[\s\S]*planJournalPhotoRows\(measured\)/);
  assert.match(css, /\.word-preview-first-row\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1\.08fr\)/);
});

test("unit import confirms one batch area unit before canonical ping conversion", async () => {
  const page = await read("app/page.tsx");
  const unitImport = page.slice(page.indexOf("function ImportUnits("), page.indexOf("function ProjectForm("));
  assert.match(unitImport, /detectImportAreaBatch\(raw\)/);
  assert.match(unitImport, /本批面積單位/);
  assert.match(unitImport, /自動判定/);
  assert.match(unitImport, /areaUnitChoice === "auto" \? areaDetection\.unit : areaUnitChoice/);
  assert.match(unitImport, /if \(!interpretedAreaUnit\) return setMessage/);
  assert.match(unitImport, /importedAreaToCanonicalPing\(row\.estimated, interpretedAreaUnit\)/);
  assert.doesNotMatch(unitImport.slice(unitImport.indexOf("const parsed ="), unitImport.indexOf("const importable =")), /areaInputToPing|importedAreaToCanonicalPing/);
});

test("billing edits stay local until one confirmed project patch", async () => {
  const page = await read("app/page.tsx");
  const billing = page.slice(page.indexOf("type BillingUnitDraft"), page.indexOf("type CompletionExportDraft"));
  const confirmSave = billing.slice(billing.indexOf("confirmSave = () => {"), billing.indexOf("startShipmentReportEdit ="));

  assert.match(billing, /type BillingUnitDraft = \{ rate: string; priced: boolean \}/);
  assert.match(billing, /setBillingDrafts\(\(current\) =>/);
  assert.match(billing, /保存修改/);
  assert.match(billing, /確認保存月結修改/);
  assert.match(billing, /確認保存/);
  assert.match(confirmSave, /const changes = new Map\(billingChanges/);
  assert.equal((confirmSave.match(/\bpatch\(\{/g) || []).length, 1);
  assert.match(confirmSave, /units: p\.units\.map/);
  assert.match(confirmSave, /if \(!changed\) return unit/);
  assert.match(billing, /沒有需要保存的修改/);
  assert.match(billing, /record\.areaPing \* rate/);
  assert.match(billing, /editing \? previewSubtotal : billSubtotal/);
  assert.match(billing, /priced: unit\.status === "已計價"/);
  assert.match(confirmSave, /rate,/);
  assert.match(confirmSave, /pricingStatusChanged = changed\.draft\.priced !== wasPriced/);
  assert.match(confirmSave, /status: changed\.draft\.priced \? "已計價" : "已驗收"/);
  assert.match(confirmSave, /pricedAt: changed\.draft\.priced \? day\(\) : ""/);
  assert.match(confirmSave, /title: changed\.draft\.priced \? "月結已計價" : "月結取消計價"/);
  assert.match(confirmSave, /detail: changed\.draft\.priced \? `金額 \$\{changed\.record\.amount\}` : "狀態恢復為已驗收"/);
  assert.match(confirmSave, /events: \[\{[\s\S]*\}, \.\.\.unit\.events\]/);
  assert.doesNotMatch(confirmSave, /acceptances\s*:/);
  assert.match(billing, /editing \? <label className="check"><input type="checkbox" checked=\{draft\.priced\}/);
  assert.match(billing, /\{draft\.priced \? "已計價" : "已驗收"\}/);
  assert.match(billing, /`\$\{unit\.status\} → \$\{draft\.priced \? "已計價" : "已驗收"\}`/);
  assert.match(billing, /unit\.status === "已驗收" \|\| unit\.status === "已計價"/);
  assert.match(billing, /if \(editing && billingChanges\.length\)/);
  assert.match(billing, /匯出內容仍以已保存資料為準/);
  assert.match(billing, /createReceivableWorkbook\(financeExportProject, billRecords, ym, receivableDraft\)/);
  assert.doesNotMatch(billing, /\bexportCsv\b|CSV 匯出|月結戶別明細 · CSV/);
  assert.match(billing, /shipmentRecords = monthlyBillingRecords/);
  assert.match(billing, /savedRecord: record/);
  assert.match(billing, /billing-print-only/);
  assert.doesNotMatch(billing, /onChange=\{\(e\) =>\s*patch\(/);
  const css = await read("app/globals.css");
  assert.match(css, /body\.printing-billing \.billing-screen-only,body\.printing-billing input\.money\{display:none!important\}/);
  assert.match(css, /body\.printing-billing \.billing-print-only\{display:inline!important\}/);
});

test("IndexedDB photo drafts restore through markers without overriding full local drafts", async () => {
  const page = await read("app/page.tsx");
  const restore = page.slice(page.indexOf("function useOfflineDraftRestore"), page.indexOf("function queueRecordChange"));
  const survey = page.slice(page.indexOf("function SurveyTab"), page.indexOf("function WorkTab"));
  const durability = await read("lib/storage-durability.ts");

  assert.match(restore, /loadOfflineDraft<T>\(draftStorageKey\)/);
  assert.match(restore, /if \(!active \|\| !draft \|\| restoreAllowed\?\.current === false\) return/);
  assert.match(restore, /shouldRestoreIndexedDbDraft\(local\)\) setValue\(draft\.payload\)/);
  assert.match(durability, /if \(!localValue\) return true/);
  assert.match(durability, /return isIndexedDbMarker\(JSON\.parse\(localValue\)\)/);
  assert.match(durability, /catch \(error\)[\s\S]*logStorageException\("localStorage", "read", error\)[\s\S]*return true/);
  assert.match(survey, /readDraft\(draftKey\(authUserId, "survey", u\.id\)/);
  assert.match(survey, /const setRestorableSurvey = useRef\(\(restored: Survey\) => \{\s*if \(surveyHistoryModeRef\.current\) preHistorySurveyRef\.current = restored;\s*else setS\(restored\);/);
  assert.match(survey, /useOfflineDraftRestore\(draftKey\(authUserId, "survey", u\.id\), setRestorableSurvey\)/);
  assert.doesNotMatch(survey, /useOfflineDraftRestore\(draftKey\(authUserId, "survey", u\.id\), setS\)/);
  assert.match(survey, /writeLocalDraft\(draftKey\(authUserId, "survey", u\.id\), s, authUserId\)/);
});

test("survey required-item navigation continues through special checks and excludes optional parking", async () => {
  const page = await read("app/page.tsx");
  const survey = page.slice(page.indexOf("function SurveyTab"), page.indexOf("function WorkTab"));
  const checklist = page.slice(page.indexOf("function Checklist"), page.indexOf("function History"));
  assert.match(survey, /onBeforeLast=\{\(\) => \{ setDoorFlowActive\(true\); setSurveyDetail\("door"\); \}\}/);
  assert.match(survey, /resumeAtLast=\{doorFlowResume\}/);
  assert.match(survey, /onBeforeLast=\{\(\) => \{ setDoorFlowActive\(true\); setSurveyDetail\("door"\); \}\}/);
  assert.match(survey, /onAfterLast=\{\(\) => setSurveyDetail\("signatures"\)\}/);
  assert.match(survey, /<button type="button" className="ghost" onClick=\{\(\) => \{ setSurveyDetail\(null\); setDoorFlowActive\(false\); \}\}>上一項<\/button>[\s\S]*下一項：矽利康施工/);
  assert.match(survey, /beforeLastItem=\{<>[\s\S]*門與門檻/);
  assert.match(checklist, /beforeLastItem && i === items\.length - 1/);
  assert.match(checklist, /if \(onBeforeLast && active === items\.length - 2\) onBeforeLast\(\)/);
  assert.match(checklist, /else if \(onAfterLast && active === items\.length - 1\) onAfterLast\(\)/);
  assert.match(checklist, /if \(resumeAtLast > 0 && items\.length\) open\(items\.length - 1\)/);
  assert.match(checklist, /onClick=\{\(\) => setActive\(Math\.max\(0, active - 1\)\)\}/);
  assert.match(checklist, /else if \(active < items\.length - 1\) open\(active \+ 1\)/);
  assert.match(survey, /上一項：門與門檻[\s\S]*setSurveyDetail\("divider"\)[\s\S]*下一項：分隔條/);
  assert.match(survey, /上一項：矽利康施工[\s\S]*setSurveyDetail\("staging"\)[\s\S]*下一項：放料區域/);
  assert.match(survey, /上一項：分隔條[\s\S]*setDoorFlowResume\(\(value\) => value \+ 1\)[\s\S]*下一項：其他異常/);
  assert.match(survey, /上一項：其他異常[\s\S]*完成／返回場勘總覽/);
  assert.doesNotMatch(survey, /(?:上一項|下一項)：停車/);
});

test("door threshold choices stay required while door photos are optional and old measurements remain compatible", async () => {
  const page = await read("app/page.tsx");
  const survey = page.slice(page.indexOf("function SurveyTab"), page.indexOf("function WorkTab"));
  assert.match(survey, /doorInspection: \{ thresholdCm: undefined, meetsThreshold: null/);
  assert.match(survey, /doorResult: "合格" \| "不合格" = door\.meetsThreshold === false \|\| door\.hasGap === true \? "不合格" : "合格"/);
  assert.match(survey, /doorInvalid = \(door\.meetsThreshold === null \|\| door\.meetsThreshold === undefined\) \|\| door\.hasGap === null \|\| \(doorResult === "不合格" && !door\.rationale\.trim\(\)\)/);
  assert.doesNotMatch(survey, /門檻實際測量（cm）|doorMeasured|doorThresholdFailed/);
  assert.match(survey, /updateDoor\(\{ meetsThreshold: true \}\)[\s\S]*有 1\.5 cm 以上/);
  assert.match(survey, /updateDoor\(\{ meetsThreshold: false \}\)[\s\S]*沒有 1\.5 cm 以上/);
  assert.match(survey, /door\.hasGap === true[\s\S]*updateDoor\(\{ hasGap: true \}\)[\s\S]*updateDoor\(\{ hasGap: false \}\)/);
  assert.match(survey, /doorItemEvidenceInvalid = doorItems\.some\(\(item\) => item\.result === "不合格" && \(!item\.note\.trim\(\) \|\| !item\.photos\?\.length\)\)/);
  assert.match(survey, /門檢查不合格時，必須說明如何改善。/);
  assert.doesNotMatch(survey, /上傳至少 1 張門檻照片|門檢查不合格時[^<]*照片/);
  assert.match(survey, /expandedDoorNotes\.includes\(item\.label\)[\s\S]*<textarea value=\{item\.note\}/);
  assert.match(survey, /<\/label>\}<Photos node=\{`場勘｜\$\{item\.label\}`\}/);
  assert.match(survey, /doorInspection: \{ \.\.\.door, result: doorResult \}/);
  assert.doesNotMatch(survey, /doorInspection: \{ \.\.\.door, meetsThreshold:/);
  assert.match(survey, /doorThresholdDisplay = Number\.isFinite\(Number\(door\.thresholdCm\)\)/);
  assert.match(survey, /patch\(\{[\s\S]*surveys:/);
});

test("PhotoGrid thumbnails share one non-mutating lightbox while editing controls remain", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const grid = page.slice(page.indexOf("function ZoomablePhoto"), page.indexOf("function Field"));
  assert.equal((grid.match(/<ZoomablePhoto photo=\{x\}/g) || []).length, 2);
  assert.match(grid, /src=\{photo\.data\}/);
  assert.match(grid, /className="photo-lightbox"/);
  assert.match(grid, /onClick=\{\(\) => setOpen\(false\)\}/);
  assert.match(grid, /aria-label="關閉放大照片"/);
  assert.match(grid, /x\.caption|caption: e\.target\.value/);
  assert.match(grid, /includeReport: e\.target\.checked/);
  assert.match(grid, /set\(photos\.filter\(\(p\) => p\.id !== x\.id\)\)/);
  assert.doesNotMatch(grid, /localStorage|indexedDB|fetch\(|compress\(/);
  assert.match(page, /word-preview-photo-row[\s\S]*ZoomablePhoto key=\{photo\.id\} photo=\{photo\}/);
  assert.match(css, /\.photo-lightbox \.photo-lightbox-image\{[^}]*max-width:[^;]+!important;[^}]*max-height:[^;]+!important;[^}]*object-fit:contain!important/);
  assert.match(css, /\.photo-zoom-trigger\{cursor:zoom-in\}/);
});

test("unit acceptance journal alone uses larger frameless responsive photos", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const unitJournal = page.slice(page.indexOf("function UnitJournalTab"), page.indexOf("function Journal({"));
  const scopedStyles = css.slice(css.indexOf("Unit acceptance journal photos only"));

  assert.match(unitJournal, /<div className="unit-journal-photos"><Photos node="戶別工作日誌"/);
  assert.match(scopedStyles, /\.unit-journal-photos \.photo-records\{[\s\S]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(scopedStyles, /\.unit-journal-photos \.photo-record\{[\s\S]*grid-template-columns:minmax\(220px,52%\) minmax\(0,1fr\);[\s\S]*border:0;[\s\S]*border-radius:0;[\s\S]*background:transparent;[\s\S]*overflow:visible/);
  assert.match(scopedStyles, /\.unit-journal-photos \.photo-record>\.photo-zoom-trigger\{[\s\S]*width:100%;[\s\S]*height:220px;[\s\S]*object-fit:cover/);
  assert.match(scopedStyles, /@media\(max-width:700px\)[\s\S]*\.unit-journal-photos \.photo-records\{grid-template-columns:minmax\(0,1fr\);[\s\S]*\.unit-journal-photos \.photo-record>\.photo-zoom-trigger\{[\s\S]*width:100%;/);
  assert.match(css, /\.photo-record\{display:grid/);
  assert.match(page, /function PhotoGrid[\s\S]*<ZoomablePhoto photo=\{x\}/);
  assert.match(page, /function ZoomablePhoto[\s\S]*photo-lightbox/);
  assert.match(unitJournal, /word-preview-first-row/);
  assert.match(page, /async function downloadWorkJournalDocx/);
});

test("storage cache failures are classified and do not block Supabase saving", async () => {
  const page = await read("app/page.tsx");
  const durability = await read("lib/storage-durability.ts");
  const offline = await read("lib/offline-drafts.ts");
  assert.match(page, /shouldAttemptCloudSave\(changed, pendingDraft, navigator\.onLine\)/);
  assert.match(page, /雲端已同步，但本機離線暫存不可用/);
  assert.doesNotMatch(durability, /空間可能不足/);
  for (const value of ["QuotaExceededError", "SecurityError", "InvalidStateError", "VersionError", "AbortError", "UnknownError", "layer", "operation", "name", "message", "code"])
    assert.match(durability, new RegExp(value));
  assert.match(offline, /request\.onupgradeneeded/);
  assert.match(offline, /createObjectStore\("drafts"/);
  assert.match(offline, /createObjectStore\("outbox"/);
  assert.match(offline, /request\.onsuccess/);
});

test("unit and project journals reopen and update the same record without duplicates", async () => {
  const page = await read("app/page.tsx");
  const unitJournal = page.slice(page.indexOf("function UnitJournalTab"), page.indexOf("function Journal("));
  const projectJournal = page.slice(page.indexOf("function Journal("), page.indexOf("function Billing("));
  const wordExporter = page.slice(page.indexOf("async function buildJournalPhotoRun"), page.indexOf("function UnitJournalTab"));

  assert.match(unitJournal, /journals: \[record, \.\.\.u\.journals\.filter\(\(item\) => item\.id !== entry\.id\)\]/);
  assert.match(unitJournal, /createdAt: entry\.createdAt \|\| now/);
  assert.match(unitJournal, /updatedAt: now/);
  assert.match(unitJournal, /createdBy: entry\.createdBy \|\|/);
  assert.match(unitJournal, /actionLabel="查看／修改"/);
  assert.match(unitJournal, /新增驗收日誌/);

  assert.match(projectJournal, /const existing = p\.journals\.find\(\(item\) => item\.id === entry\.id\)/);
  assert.match(projectJournal, /journals: \[saved, \.\.\.p\.journals\.filter\(\(item\) => item\.id !== saved\.id\)\]/);
  assert.match(projectJournal, /notes = liveEntities\(p\.journals\)\.sort\(\(a, b\) => b\.date\.localeCompare\(a\.date\)\)/);
  assert.doesNotMatch(projectJournal, /notes = p\.journals\.filter\(\(x\) => x\.date === date\)/);
  assert.match(projectJournal, /施工紀錄日期/);
  assert.match(projectJournal, /所有案場日誌/);
  assert.match(projectJournal, /createdAt: existing\?\.createdAt \|\| entry\.createdAt \|\| now/);
  assert.match(projectJournal, /updatedAt: now/);
  assert.match(projectJournal, /setEntry\(blank\(date\)\)/);
  assert.match(projectJournal, /查看／修改/);
  assert.match(projectJournal, /新增今日日誌/);
  assert.match(projectJournal, /confirm\("刪除此筆當日日誌？"\)/);
  assert.match(projectJournal, /removeDurableDraft\(draftKey\(authUserId, "journal", p\.id\)\)/);

  assert.match(wordExporter, /columnWidths: \[4540, 4820\]/);
  assert.doesNotMatch(wordExporter, /正在修改|新增今日日誌|新增驗收日誌/);
});

test("daily acceptance keeps formal history without an export entry and billing owns the daily shipment export", async () => {
  const page = await read("app/page.tsx");
  const dailyAcceptances = await read("lib/daily-acceptances.ts");
  const daily = page.slice(page.indexOf("function DailyAcceptanceView"), page.indexOf("function Dashboard"));
  const billing = page.slice(page.indexOf("function Billing("), page.indexOf("type CompletionExportDraft"));
  assert.match(page, /\["daily-acceptance", "✓", "今日驗收"\]/);
  assert.match(daily, /buildDailyAcceptanceEntries<Acceptance, Unit>/);
  assert.doesNotMatch(daily, /當日總細表|shipmentPreview|exportDay|createShipmentWorkbook|saveShipmentWorkbook/);
  assert.match(daily, /<ReportMetadataEditor draft=\{reportDraft\}/);
  for (const label of ["SPC 已出貨明細總表", "當日細總表", "應收帳款 Excel"]) assert.match(billing, new RegExp(label));
  assert.doesNotMatch(billing.slice(billing.indexOf('<section className="acceptance-exports billing-no-print">'), billing.indexOf("{canManageFinance && <><div className=\"summary\">")), /PDF／列印/);
  assert.match(billing, /buildDailyAcceptanceEntries\(financeExportProject\.units \|\| \[\]\)\.filter\(\(entry\) => entry\.date === dailyShipmentDate\)/);
  assert.doesNotMatch(billing, /as unknown(?: as Unit\[\])?/);
  assert.match(billing, /dailyShipmentEntries\.map\(\(\{ unit, acceptance \}\) => buildAcceptanceExportRecord\(financeExportProject!, unit, acceptance, true\)\)/);
  assert.match(billing, /createShipmentWorkbook\(financeExportProject, dailyShipmentRecords, dailyShipmentDate\.slice\(0, 7\)\)/);
  assert.match(billing, /saveShipmentWorkbook\(workbook, `\$\{dailyShipmentDate\}_\$\{financeExportProject\.name\}_當日細總表\.xlsx`\)/);
  assert.doesNotMatch(page, /(?:function|const)\s+createDaily(?:Shipment)?Workbook/i);
  assert.match(dailyAcceptances, /id\?: string;[\s\S]*date\?: string;/);
  assert.match(dailyAcceptances, /acceptance\.draft === true[\s\S]*\|\| !acceptance\.id[\s\S]*\|\| !acceptance\.date[\s\S]*\|\| seen\.has\(acceptance\.id\)[\s\S]*seen\.add\(acceptance\.id\)/);
});

test("receivable Excel uses a local billRecords preview draft before export", async () => {
  const page = await read("app/page.tsx");
  const exports = await read("lib/acceptance-exports.ts");
  const css = await read("app/globals.css");
  const billing = page.slice(page.indexOf("function Billing("), page.indexOf("type CompletionExportDraft"));
  const receivableFlow = billing.slice(billing.indexOf("openReceivablePreview ="), billing.indexOf("changeBillingPeriod ="));
  const receivableModal = billing.slice(billing.indexOf("{canExportReceivables && receivablePreview && receivableDraft"), billing.indexOf("{canExportShipment && shipmentPreview &&"));

  assert.match(billing, /onClick=\{openReceivablePreview\}[\s\S]*<b>應收帳款 Excel<\/b>[\s\S]*<em>預覽 ›<\/em>/);
  assert.match(receivableFlow, /setReceivableDraft\(buildReceivableExportDraft\(financeExportProject, billRecords\)\)/);
  assert.match(receivableModal, /title="應收帳款 Excel｜匯出預覽"/);
  assert.match(receivableModal, /billRecords\.map\(\(record, index\)/);
  assert.match(receivableModal, /className="export-preview-table receivable-preview-table"/);
  assert.match(receivableModal, /<th>日期<\/th><th>戶別<\/th><th>型號<\/th><th>尺寸cm<\/th><th>數量\(坪\)<\/th><th>單價／元<\/th><th>合計<\/th><th>備註<\/th>/);
  assert.match(receivableModal, /type="number" min="0" step="0\.01" value=\{detail\.quantity\}/);
  assert.match(receivableModal, /label="送貨聯絡人"/);
  assert.match(receivableModal, /實際戶別筆數<b>\{billRecords\.length\}<\/b>/);
  assert.match(receivableModal, /createReceivableWorkbook\(financeExportProject, billRecords, ym, receivableDraft\)/);
  assert.match(billing, /receivableTotals = receivableDraft \? receivableDraftTotals\(receivableDraft\) : null/);
  assert.match(receivableModal, /saveReceivableWorkbook\(workbook/);
  assert.match(receivableModal, /receivableExporting \? "產生中…" : "確認產生 Excel"/);
  for (const field of ["deliveryContact", "deliveryAddress", "invoiceTrack", "invoiceDate", "receivedAmount", "receivedDate", "preparedBy", "paymentMethod", "deliveryDate", "handler", "supervisor", "accounting"])
    assert.match(receivableModal, new RegExp(`receivableDraft\\.${field}`));
  for (const field of ["date", "unitDisplay", "model", "sizeCm", "quantity", "unitPrice", "note"])
    assert.match(receivableModal, new RegExp(`detail\\.${field}`));
  assert.match(receivableModal, /value=\{detail\.note\}[\s\S]*updateDetail\(\{ note: event\.target\.value \}\)/);
  for (const field of ["bankAccount", "contactPerson", "mobile", "phone", "fax", "address"])
    assert.match(receivableModal, new RegExp(`companyReportConfig\\.${field}`));
  assert.doesNotMatch(receivableFlow + receivableModal, /\bpatch\(|queueRecordChange|writeLocalDraft|saveOfflineDraft|localStorage|indexedDB|\bstatus\s*:|events\s*:/i);

  assert.match(exports, /const detailCount = records\.length/);
  assert.match(exports, /export type ReceivableDetailDraft = \{[\s\S]*date: string;[\s\S]*unitDisplay: string;/);
  assert.match(exports, /deliveryAddress: project\.address \|\| ""/);
  assert.match(exports, /\["日期", "戶別", "型號", "尺寸cm", "數量\(坪\)", "單價／元", "合計", "備註"\]/);
  assert.match(exports, /\["送貨聯絡人：", draft\.deliveryContact/);
  assert.match(exports, /`\$\{project\.name \|\| ""\} SPC`/);
  assert.match(exports, /note: record\.noteText \?\? record\.note/);
  assert.match(exports, /detail\.note/);
  assert.match(exports, /\["SPC", "", "", "", "", "", "", ""\]/);
  assert.match(exports, /`A1:H1`[\s\S]*`A\$\{summaryTitle\}:H\$\{summaryTitle\}`[\s\S]*`A\$\{bankLabelRow\}:H\$\{bankLabelRow\}`/);
  assert.match(exports, /worksheet\["!cols"\] = \[13, 14, 18, 14, 13, 15, 17, 28\]/);
  assert.match(exports, /worksheet\["!printArea"\] = `A1:H\$\{addressRow\}`/);
  assert.match(exports, /col === 4\) cell\.z = "0\.00"/);
  assert.doesNotMatch(exports, /Math\.max\(records\.length,\s*10\)/);
  assert.match(exports, /IF\(OR\(E\$\{row\}=\\"\\",F\$\{row\}=\\"\\"\),0,E\$\{row\}\*F\$\{row\}\)/);
  assert.match(exports, /SUM\(G\$\{detailStart\}:G\$\{detailEnd\}\)/);
  assert.match(exports, /ROUND\(G\$\{subtotalRow\}/);
  assert.match(exports, /G\$\{subtotalRow\}-G\$\{taxRow\}/);
  assert.match(exports, /date: receivableDate\(record\.shipmentDateText \|\| record\.exportDate\)/);
  for (const mapping of [
    /unitDisplay: record\.unitDisplayText \?\? record\.unitDisplay/,
    /model: record\.productText \?\? record\.model/,
    /quantity: record\.pingText \?\? \(record\.areaPing > 0 \? String\(record\.areaPing\) : ""\)/,
    /unitPrice: record\.unitPriceText \?\? \(record\.unitPrice > 0 \? String\(record\.unitPrice\) : ""\)/,
    /note: record\.noteText \?\? record\.note/,
  ]) assert.match(exports, mapping);
  assert.match(exports, /invoiceTrack: records\.find\(\(record\) => record\.outgoingVoOriginal\.trim\(\)\)/);
  assert.match(exports, /invoiceDate: records\.find\(\(record\) => record\.outgoingVoOriginalDate\.trim\(\)\)/);
  assert.doesNotMatch(exports, /invoiceTrack:[^\n]*incomingVoOriginal|invoiceDate:[^\n]*incomingVoOriginal/);
  assert.match(exports, /export type AcceptanceReportMetadata = \{[\s\S]*outgoingVoOriginalDate\?: string;/);
  assert.match(exports, /outgoingVoOriginalDate: report\?\.outgoingVoOriginalDate \|\| ""/);
  assert.match(exports, /\[record\.outgoingVoOriginal, record\.outgoingVoOriginalDate\]\.filter\(Boolean\)\.join\("\\n"\)/);
  for (const field of ["bankAccount", "contactPerson", "mobile", "phone", "fax", "address"])
    assert.match(exports, new RegExp(`companyReportConfig\\.${field}`));
  assert.match(css, /\.receivable-preview-table input\{[^}]*width:100%[^}]*max-width:150px[^}]*border:1px solid[^}]*border-radius:[^;]+;[^}]*background:#fff[^}]*padding:/);
  assert.match(css, /\.receivable-preview-table input:focus\{[^}]*border-color:var\(--green\)[^}]*box-shadow:/);
});

test("daily and monthly shipment report edits persist only approved formal source fields", async () => {
  const page = await read("app/page.tsx");
  const exports = await read("lib/acceptance-exports.ts");
  const sourceUpdate = page.slice(page.indexOf("const updateReportSource"), page.indexOf("function DailyAcceptanceView"));
  const editor = page.slice(page.indexOf("function ReportMetadataEditor"), page.indexOf("function DailyAcceptanceView"));
  const daily = page.slice(page.indexOf("function DailyAcceptanceView"), page.indexOf("function Dashboard"));
  const billing = page.slice(page.indexOf("function Billing("), page.indexOf("type CompletionExportDraft"));
  const dailySave = daily.slice(daily.indexOf("const saveReportSource"), daily.indexOf("return ("));
  const shipmentOpen = billing.slice(billing.indexOf("startShipmentReportEdit ="), billing.indexOf("saveShipmentReportSource ="));
  const shipmentSave = billing.slice(billing.indexOf("saveShipmentReportSource ="), billing.indexOf("changeBillingPeriod ="));

  assert.match(sourceUpdate, /unit\.acceptances\.map\(\(acceptance\) => acceptance\.id === draft\.acceptanceId\s*\? \{ \.\.\.acceptance, report: \{/);
  const textFields = [
    "shipmentDateText", "sequenceText", "customerNameText", "productText", "unitDisplayText", "squareMetersText",
    "pingText", "unitPriceText", "amountText", "vendorText", "purchasePriceText", "noteText",
    "incomingVoOriginal", "incomingVoCopy", "outgoingVoOriginal", "outgoingVoOriginalDate", "outgoingVoCopy", "submitted", "vendorInvoice",
    "tier", "payable", "profitPercent", "profit",
  ];
  for (const field of [
    ...textFields, "signedOriginal", "signedCopy",
  ]) {
    assert.match(sourceUpdate, new RegExp(`${field}: draft\\.${field}`));
    assert.match(exports, new RegExp(`${field}: report\\?\\.${field}`));
  }
  for (const field of textFields) assert.match(editor, new RegExp(`value=\\{draft\\.${field}\\}`));
  assert.match(editor, /checked=\{draft\.signedOriginal\}/);
  assert.match(editor, /checked=\{draft\.signedCopy\}/);
  assert.doesNotMatch(editor, /type="number"/);
  assert.match(editor, /label="銷VO正日期" type="date" value=\{draft\.outgoingVoOriginalDate\}/);
  assert.doesNotMatch(sourceUpdate, /\bstatus\b|defects|events|\badd\(|removeDurableDraft|id: id\(\)|model: draft|colorNo: draft|brand: draft|rate:|area: draft|note: draft/);

  for (const save of [dailySave, shipmentSave]) {
    assert.match(save, /acceptance\.id === .*acceptanceId && acceptance\.draft !== true/);
    assert.match(save, /updateReportSource\(currentUnit/);
    assert.match(save, /patch\(\{ units: p\.units\.map\(\(unit\) => unit\.id === updatedUnit\.id \? updatedUnit : unit\) \}\)/);
    assert.match(save, /queueRecordChange\(authUserId, "accept", updatedUnit\.id, updatedAcceptance, "complete"\)/);
    assert.doesNotMatch(save, /\bstatus\b|defects:|events:|\badd\(|removeDurableDraft|id: id\(\)/);
  }
  assert.match(page, /function queueRecordChange[\s\S]*queueOfflineWrite\(\{[^}]*payload: record \}\)/);

  assert.match(daily, /buildAcceptanceExportRecord\(p, selected\.unit, selected\.acceptance, true\)/);
  assert.match(billing, /monthlyBillingRecords = financeExportProject \? buildAcceptanceExportRecords\(financeExportProject\)/);
  assert.equal((page.match(/<ReportMetadataEditor draft=/g) || []).length, 3);
  assert.match(exports, /const headers = \["出貨日期", "序號", "客戶名稱", "商品", "戶別", "m²", "片／件\\n\*0\.3025", "單價／元", "合計", "廠商", "進價／元", "備註", "簽單正", "簽單影", "進VO正", "進VO影", "銷VO正", "銷VO影", "送單", "廠商帳單", "級距", "應付", "利潤%", "利潤"\]/);
  assert.doesNotMatch(exports, /const headers = \[[^\]]*銷VO正日期/);
  assert.doesNotMatch(shipmentOpen, /\bpatch\(|queueRecordChange|updateReportSource/);
  assert.match(daily, /onClick=\{\(\) => \{ setSelected\(entry\); setReportDraft\(null\); setReportMessage\(""\); \}\}/);
  assert.match(daily, /onClick=\{\(\) => \{ setReportDraft\(null\); setReportMessage\(""\); \}\}>取消修改/);
  assert.match(billing, /onClick=\{\(\) => \{ setShipmentReportDraft\(null\); setShipmentReportMessage\(""\); \}\}>取消修改/);
  assert.match(billing, /createShipmentWorkbook\(financeExportProject, shipmentRecords, ym\)/);
  assert.match(billing, /disabled=\{shipmentExporting \|\| !shipmentRecords\.length \|\| !!shipmentReportDraft \|\| !shipmentExportReady\}/);
  assert.doesNotMatch(billing, /createShipmentWorkbook\(p, shipmentReportDraft/);
  assert.doesNotMatch(exports, /Array\(12\)\.fill/);
  assert.match(exports, /record\.shipmentDateText !== undefined \? display\.shipmentDateText : excelDate\(record\.exportDate\)/);
  assert.match(exports, /record\.pingText !== undefined \? display\.pingText : \{ f: `ROUND/);
  assert.match(exports, /record\.amountText !== undefined \? display\.amountText : \{ f: `IF/);
  assert.match(exports, /records\.map\(\(record\) => \(\{ hpt: estimateShipmentRowHeight\(record\) \}\)\)/);
  assert.match(exports, /wrapText: true/);
});

test("checklist measurement fields require an explicit item flag", async () => {
  const page = await read("app/page.tsx");
  const surveyInitialization = page.slice(page.indexOf("items: surveyLabels.map"), page.indexOf("photos: [],", page.indexOf("items: surveyLabels.map") + 100));
  assert.match(page, /requiresMeasurement\?: boolean/);
  assert.doesNotMatch(surveyInitialization, /requiresMeasurement/);
  assert.doesNotMatch(page, /requiresMeasurement: label === "地坪平整度"/);
  assert.match(page, /currentRequiresMeasurement = current\?\.requiresMeasurement === true && current\.label !== "地坪平整度"/);
  assert.match(page, /currentRequiresMeasurement && <div className="inspection-measure">/);
  assert.doesNotMatch(page, /current\.value.*&& <div className="inspection-measure">/);
  assert.doesNotMatch(page, /current\.result.*&& <div className="inspection-measure">/);
});

test("acceptance entry and formal sheet keep one completion mapping and three A4 copies", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  for (const value of [
    "第一聯：客戶存根聯",
    "第二聯：公司收執聯",
    "第三聯：廠商收執聯",
    "completion.floorAbnormal",
    "completion.boardDamaged",
    "completion.trashCleared",
    "completion.abnormalUnit",
    "completion.damagedMaterialType",
    'a.completion?.floorAbnormal === true',
    'a.completion?.boardDamaged === true',
    'printWithLifecycleCleanup("printing-completion")',
  ]) assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const completionPrintStart = css.lastIndexOf("@media print{", css.indexOf("body.printing-completion{"));
  const completionPrintEnd = css.indexOf("@media print{", completionPrintStart + 1);
  const completionPrint = css.slice(completionPrintStart, completionPrintEnd > completionPrintStart ? completionPrintEnd : css.indexOf(".area-input-row"));
  for (const value of [
    "body.printing-completion .completion-paper",
    "width:210mm",
    "height:87mm",
    "break-inside:avoid",
    "page-break-inside:avoid",
    ".acceptance-checklist .inspection-grid{grid-template-columns:repeat(3,minmax(0,1fr))}",
  ]) assert.match(css, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(completionPrint, /:not\([\s\S]*:has\(\.completion-report-page\)[\s\S]*\)\{display:none!important\}/);
  assert.doesNotMatch(completionPrint, /visibility:hidden/);
  assert.match(completionPrint, /\.completion-paper\{[\s\S]*height:auto;[\s\S]*min-height:0;[\s\S]*max-height:285mm[\s\S]*padding:6mm 8mm[\s\S]*overflow:hidden[\s\S]*box-sizing:border-box/);
  assert.match(completionPrint, /\.completion-copy:last-child\{margin-bottom:0;padding-bottom:0/);
  assert.match(completionPrint, /:is\(h1,span,small,th,td,b,p,label\)\{color:#000!important\}/);
  assert.match(completionPrint, /border-color:#000!important/);
  assert.doesNotMatch(completionPrint, /grayscale|filter:/);
  assert.doesNotMatch(page, /const a = u\.acceptances\[0\]/);
});

test("floor batch acceptance export keeps unit-scoped drafts, signatures, and one A4 three-copy group per unit", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const helper = await read("lib/floor-acceptance.ts");
  const batch = page.slice(page.indexOf("function FloorBatchExport"), page.indexOf("function UnitDetail"));
  assert.match(page, />匯出驗收單<\/button>/);
  assert.match(batch, /floorBatchSelectableIds\(units\)/);
  assert.match(helper, /return !!getLatestFinalAcceptance\(unit\)/);
  assert.match(batch, /disabled=\{disabled\}/);
  assert.match(batch, /全選可匯出/);
  assert.match(batch, /buildUnitScopedRecord\(targets, createUnitExport\)/);
  assert.match(batch, /updateUnitScopedRecord\(record, currentUnit\.id, update\)/);
  assert.match(batch, /buildCompletionExportDraft\(project, unit, acceptance, completion\)/);
  assert.match(batch, /signatures: floorUnitSignatures\(unit\), conflicts: \[\]/);
  assert.match(batch, /const signatureCount = acceptance \? floorUnitSignatureCount\(unit\) : 0/);
  assert.doesNotMatch(batch, /resolveUnitSignatures|resolveFloorSignatures|floorRecord|舊簽名資料不一致/);
  assert.match(batch, /還原此戶自動資料/);
  assert.match(batch, /className="floor-batch-export-editor-grid"/);
  assert.match(batch, /<span>部門別<\/span><input value="派工部" readOnly/);
  assert.doesNotMatch(batch, /\['department','部門別'\]/);
  assert.doesNotMatch(batch, /className="grid3"/);
  assert.match(batch, /printWithLifecycleCleanup\("printing-completion-batch"\)/);
  assert.match(batch, /completionCopyLabels\.map\(\(copy\) => <CompletionCopy/);
  assert.match(page, /printWithLifecycleCleanup\("printing-completion"\)/);
  assert.match(css, /\.floor-batch-print\{display:none\}/);
  assert.match(css, /\.modal-card:has\(> \.floor-batch-export\)\{[^}]*width:min\(900px,calc\(100vw - 40px\)\)[^}]*overflow-x:hidden;overflow-y:auto/);
  assert.match(css, /\.floor-batch-unit-grid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*max-width:100%/);
  assert.match(css, /\.floor-batch-export-editor-grid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*max-width:100%/);
  assert.match(css, /\.floor-batch-unit-selector\{[^}]*overflow-x:auto;overflow-y:hidden/);
  assert.match(css, /@media\(max-width:700px\)\{[\s\S]*\.floor-batch-unit-grid,\.floor-batch-export-editor-grid,\.floor-batch-review,\.floor-batch-summary\{grid-template-columns:1fr\}/);
  assert.match(css, /body\.printing-completion-batch \.floor-batch-paper\{[\s\S]*max-height:285mm[\s\S]*break-after:page;page-break-after:always/);
  assert.match(css, /\.floor-batch-paper:last-child\{break-after:auto;page-break-after:auto\}/);
  assert.match(css, /body\.printing-completion-batch \.completion-copy\{[\s\S]*height:87mm/);
});

test("completion export confirmation edits one temporary draft shared by all three copies", async () => {
  const page = await read("app/page.tsx");
  const report = page.slice(page.indexOf("type CompletionExportDraft"), page.indexOf("function Timeline"));
  const css = await read("app/globals.css");
  assert.match(report, /buildCompletionExportDraft\(project, unit, acceptance, completion\)/);
  assert.match(report, /department: "派工部"/);
  assert.doesNotMatch(report, /department: completion\.department/);
  assert.equal((report.match(/<span>部門別<\/span><input value="派工部" readOnly/g) || []).length, 1);
  assert.doesNotMatch(report, /\['department','部門別'\]/);
  assert.match(report, /<td colSpan=\{2\}>\{draft\.department\}<\/td>/);
  assert.doesNotMatch(report.slice(report.indexOf("function CompletionCopy")), /<td colSpan=\{2\}>派工部<\/td>/);
  assert.match(page, /function completionDefaults[\s\S]*department: a\.completion\?\.department \|\| "工程部"/);
  assert.match(page, /completion: \{\s*department: "工程部"/);
  for (const value of ["project.name", "project.address", "unit.order", "acceptance.area", "unit.estimated", "completion.floorAbnormal", "completion.boardDamaged", "completion.trashCleared"])
    assert.match(report, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(report, /const \[exportDraft, setExportDraft\]/);
  assert.match(report, /const reportSignatures = signatures \|\| completion\.signatures/);
  assert.match(report, /\.map\(\(copy\) => <CompletionCopy key=\{copy\} copy=\{copy\} draft=\{exportDraft\} signatures=\{reportSignatures\}/);
  assert.match(report, /signatures=\{floorUnitSignatures\(u\)\}/);
  assert.doesNotMatch(report.slice(report.indexOf("function Sheet("), report.indexOf("function CompletionReport(")), /resolveUnitSignatures|resolveFloorSignatures|floorAcceptances|signatureConflicts/);
  assert.match(report, /setText\("projectName"|\['projectName','案場名稱'\]/);
  assert.match(report, /setText\("area"|\['area','坪數確認'\]/);
  assert.match(report, /CompletionDraftBoolean label="地坪是否異常"/);
  assert.match(report, /signatureNames/);
  assert.match(report, /setExportDraft\(createDraft\(\)\)/);
  assert.match(report, /printWithLifecycleCleanup\("printing-completion"\)/);
  assert.doesNotMatch(report, /patch\(\{|patchProject|acceptances\[0\]/);
  assert.match(css, /\.completion-report-page>:not\(\.completion-paper\)\{display:none!important\}/);
  const billingPrint = css.slice(css.indexOf("body.printing-billing"), css.indexOf("Acceptance entry and its dedicated"));
  assert.match(billingPrint, /body\.printing-billing/);
});

test("acceptance editor remounts by unit and rejects stale cross-unit draft restores", async () => {
  const page = await read("app/page.tsx");
  const unitDetail = page.slice(page.indexOf("function UnitDetail("), page.indexOf("function Next("));
  const acceptance = page.slice(page.indexOf("function AcceptTab("), page.indexOf("function DefectsTab("));
  const restore = page.slice(page.indexOf("function useOfflineDraftRestore"), page.indexOf("function queueRecordChange"));
  const sharedReadDraft = page.slice(page.indexOf("readDraft ="), page.indexOf("writeLocalDraft ="));

  assert.match(unitDetail, /<AcceptTab key=\{unit\.id\} project=\{project\} u=\{unit\}/);
  assert.doesNotMatch(unitDetail, /key=\{(?:unit\.acceptances|acceptance|unit\.status|unit\.updatedAt)/);
  assert.match(acceptance, /const latestFormalAcceptance = u\.acceptances\.find\(\(item\) => item\.draft !== true\)/);
  assert.match(acceptance, /const historyModeRef = useRef\(!!latestFormalAcceptance\)/);
  assert.match(acceptance, /const preHistoryAcceptanceRef = useRef<Acceptance \| null>\(null\)/);
  assert.match(acceptance, /const acceptanceDraftActiveRef = useRef\(!latestFormalAcceptance\)/);
  assert.match(acceptance, /const restored = readDraft\(draftKey\(authUserId, "accept", u\.id\), fallback\);\s*const initialAcceptance = restored\.draft === false \? fallback : restored;\s*if \(latestFormalAcceptance\) preHistoryAcceptanceRef\.current = initialAcceptance;\s*return latestFormalAcceptance \|\| initialAcceptance;/);
  assert.match(acceptance, /const setRestorableAcceptance = useRef\(\(restored: Acceptance\) => \{\s*if \(restored\.draft === false\) return;\s*if \(historyModeRef\.current\) preHistoryAcceptanceRef\.current = restored;\s*else setA\(restored\);/);
  assert.match(acceptance, /useOfflineDraftRestore\(draftKey\(authUserId, "accept", u\.id\), setRestorableAcceptance\)/);
  assert.doesNotMatch(acceptance, /restored\.draft !== true|restored\.draft === true \?/);
  assert.doesNotMatch(sharedReadDraft, /draft === false|draft !== false/);
  assert.doesNotMatch(restore, /draft === false|draft !== false/);
  assert.match(acceptance, /const \[historyMode, setHistoryMode\] = useState\(!!latestFormalAcceptance\)/);
  assert.match(acceptance, /if \(skipNextDraftWrite\.current\) \{\s*skipNextDraftWrite\.current = false;\s*return;/);
  assert.match(acceptance, /if \(historyModeRef\.current\) return;/);
  assert.match(acceptance, /writeLocalDraft\(draftKey\(authUserId, "accept", u\.id\), a, authUserId\)/);
  assert.match(acceptance, /rows=\{u\.acceptances\.map/);
  assert.match(acceptance, /onOpen: \(\) => openAcceptanceRecord\(x\)/);
  assert.match(acceptance, /if \(!historyModeRef\.current\) preHistoryAcceptanceRef\.current = a;[\s\S]*historyModeRef\.current = true;[\s\S]*acceptanceDraftActiveRef\.current = false;[\s\S]*setA\(record\)/);
  assert.match(acceptance, /acceptances: \[completed, \.\.\.u\.acceptances\.filter/);
  assert.match(acceptance, /const savingHistory = historyModeRef\.current/);
  assert.match(acceptance, /if \(!savingHistory\) await removeDurableDraft/);
  assert.equal((acceptance.match(/removeDurableDraft\(/g) || []).length, 1);
  assert.doesNotMatch(acceptance, /localStorage\.removeItem|removeOfflineDraft|deleteOfflineDraft/);
  assert.match(acceptance, /if \(savingHistory\) \{\s*const resumeAcceptance = preHistoryAcceptanceRef\.current;\s*skipNextDraftWrite\.current = true;\s*historyModeRef\.current = false;\s*acceptanceDraftActiveRef\.current = true;/);
  assert.match(acceptance, /setHistoryMode\(false\);\s*if \(resumeAcceptance\) setA\(resumeAcceptance\)/);
  const historyOpen = acceptance.slice(acceptance.indexOf("openAcceptanceRecord ="), acceptance.indexOf("exitAcceptanceHistory ="));
  assert.doesNotMatch(historyOpen, /removeDurableDraft/);
  assert.match(acceptance, /if \(historyModeRef\.current\) return setSaved\("歷史驗收只能正式保存；原本未完成草稿不會被覆蓋"\)/);
  assert.match(restore, /let active = true/);
  assert.match(restore, /if \(!active \|\| !draft/);
  assert.match(restore, /return \(\) => \{ active = false; \}/);
  assert.doesNotMatch(acceptance, /cleanupRemovedPhotos|deletePhoto|removePhoto/);
});

test("billing shipment previews expose the same company summary fields without changing other exporters", async () => {
  const page = await read("app/page.tsx");
  const billing = page.slice(page.indexOf("function Billing("), page.indexOf("type CompletionExportDraft"));
  assert.equal((billing.match(/<thead><tr><th>操作<\/th><th>出貨日期<\/th>/g) || []).length, 2);
  assert.match(billing, /<td><button type="button" className="primary" disabled=\{!!shipmentReportDraft\} onClick=\{\(\) => startShipmentReportEdit\(record, index\)\}>修改<\/button><\/td><td>\{display\.shipmentDateText\}<\/td>/);
  assert.match(billing, /shipmentRecords\.map\(\(record, index\) => \{ const display = shipmentDisplayValues\(record, index\)/);
  assert.match(billing, /dailyShipmentRecords\.map\(\(record, index\) => \{ const display = shipmentDisplayValues\(record, index\)/);
  for (const field of [
    "shipmentDateText", "sequenceText", "customerNameText", "productText", "unitDisplayText", "squareMetersText",
    "pingText", "unitPriceText", "amountText", "vendorText", "purchasePriceText", "noteText",
    "signedOriginal", "signedCopy", "incomingVoOriginal", "incomingVoCopy", "outgoingVoOriginal", "outgoingVoCopy",
    "submitted", "vendorInvoice", "tier", "payable", "profitPercent", "profit",
  ]) assert.ok((billing.match(new RegExp(`display\\.${field}`, "g")) || []).length >= 2);
  for (const heading of ["出貨日期", "序號", "客戶名稱", "商品", "戶別", "m²", "片／件 *0.3025", "單價／元", "合計", "廠商", "進價／元", "備註", "簽單正", "簽單影", "進VO正", "進VO影", "銷VO正", "銷VO影", "送單", "廠商帳單", "級距", "應付", "利潤%", "利潤"])
    assert.ok((billing.match(new RegExp(`<th>${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/th>`, "g")) || []).length >= 2);
  assert.match(billing, /<ReportMetadataEditor draft=\{shipmentReportDraft\}/);
});

test("overlapping saves keep the newest local state pending until Supabase confirms it", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["retrySyncRef", "stillCurrent", "正在接續同步最新修改", "latestRef.current.projects"]) assert.match(page, new RegExp(value));
  assert.doesNotMatch(page, /if \(savingRef\.current\) return;/);
});

test("tablet and phone layouts use drawers, stacked forms, and safe scrolling", async () => {
  const css = await read("app/globals.css");
  for (const value of ["max-width:900px", "max-width:600px", "max-width:390px", "translateX(-105%)", "100dvh", "safe-area-inset-bottom", "-webkit-overflow-scrolling:touch"]) assert.match(css, new RegExp(value.replace(/[()]/g, "\\$&")));
  assert.match(css, /\.form-actions\{display:grid!important;grid-template-columns:1fr/);
});

test("final mobile unit manager override stays full-width with compact shrinkable floor rows", async () => {
  const css = await read("app/globals.css");
  const marker = "Final mobile unit-manager width and compact-floor override (#7/#8).";
  const mobile = css.slice(css.indexOf(marker), css.indexOf("Keep the floor acceptance entry compact", css.indexOf(marker)));
  assert.match(mobile, /@media\(max-width:700px\)/);
  assert.match(mobile, /\.unit-manager[\s\S]*\.unit-manager \.building-groups[\s\S]*\.unit-manager \.building-group[\s\S]*width:100%;[\s\S]*min-width:0;[\s\S]*max-width:100%/);
  assert.match(mobile, /\.unit-manager \.floor-head\{[\s\S]*grid-template-columns:minmax\(0,1fr\);[\s\S]*min-height:46px/);
  assert.match(mobile, /\.unit-manager \.floor-head\.bulk\{[\s\S]*grid-template-columns:28px minmax\(0,1fr\)/);
  assert.match(mobile, /\.unit-manager \.floor-row-main\{[\s\S]*min-height:46px;[\s\S]*grid-template-columns:auto auto minmax\(0,1fr\) 18px/);
  assert.doesNotMatch(mobile, /@media\(min-width:701px\)/);
});

test("unit master keeps customer contacts visible above collapsible engineering details", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const master = page.slice(page.indexOf("function Master("), page.indexOf("function AutoRecord("));
  const customerStart = master.indexOf('<section className="customer-section unit-master-customer">');
  const disclosureStart = master.indexOf('className="unit-details-disclosure"');
  const detailsStart = master.indexOf('{unitDetailsOpen && <section id="unit-master-details"');

  assert.match(master, /const \[unitDetailsOpen, setUnitDetailsOpen\] = useState\(false\)/);
  assert.match(master, /useEffect\(\(\) => \{\s*setUnitDetailsOpen\(false\);\s*\}, \[u\.id\]\)/);
  assert.match(master, /type="button"[\s\S]*aria-expanded=\{unitDetailsOpen\}[\s\S]*aria-controls="unit-master-details"/);
  assert.ok(customerStart >= 0 && customerStart < disclosureStart && disclosureStart < detailsStart);
  assert.doesNotMatch(master.slice(customerStart, detailsStart), /\{unitDetailsOpen &&[\s\S]*customer-section/);
  const details = master.slice(detailsStart);
  for (const content of ["建案名稱（全案共用）", "客變戶", "刪除戶別", "確認資料無誤 → 安排場勘"])
    assert.match(details, new RegExp(content));
  assert.match(master, /confirm\("確定刪除此戶及全部工程紀錄？"\) && remove\(\)/);
  for (const mapping of ["owner", "phone", "lineId", "email", "customerRole", "contactPreference", "customerNeed", "customerSource", "marketingConsent", "consentAt"])
    assert.match(master, new RegExp(`patch\\(\\{[^}]*${mapping}`));
  assert.match(css, /\.customer-contact-grid\{[\s\S]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(min-width:701px\) and \(max-width:1000px\)\{[\s\S]*\.customer-contact-grid\{[\s\S]*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:700px\)\{[\s\S]*\.customer-contact-grid\{[\s\S]*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:340px\)\{[\s\S]*\.customer-contact-grid\{[\s\S]*grid-template-columns:1fr/);
});

test("every unfinished data-entry flow has durable drafts and notes", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["project-onboarding", "unit-create", "global-product", "project-product", "riskDraftKey", "logStorageException", "停車備註", "改善備註"]) assert.match(page, new RegExp(value));
  assert.match(page, /readWorkspaceDraft\(authUserId\) \|\| indexedWorkspace\?\.payload/);
  assert.match(page, /saveOfflineDraft\(\{ key: scopedKey\(workspaceDraftKey, owner\)/);
});

test("phase 5C-1 exposes a permission-minimized read-only finance export RPC", async () => {
  const sql = await read("supabase/migrations/202609040001_workspace_permission_enforcement.sql");
  const start = sql.indexOf("create or replace function public.spc_load_finance_export_data()");
  const end = sql.indexOf("create or replace function public.spc_merge_workspace(", start);
  const rpc = sql.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(rpc, /spc_load_finance_export_data\(\)\s*returns jsonb/i);
  assert.match(rpc, /language plpgsql[\s\S]*stable[\s\S]*security definer[\s\S]*set search_path = pg_catalog, public/i);
  assert.match(rpc, /approved_role text := public\.spc_current_approved_role\(\)/i);
  assert.match(rpc, /from public\.spc_current_effective_permissions\(\)/i);
  assert.match(rpc, /approved_role is null[\s\S]*approved_role not in \('admin', 'shenyin', 'crew', 'client', 'sales'\)[\s\S]*SPC_ACCESS_REQUIRED[\s\S]*42501/i);
  assert.match(rpc, /approved_role in \('admin', 'shenyin'\)[\s\S]*can_export_receivables := true[\s\S]*can_export_shipment_details := true/i);
  assert.match(rpc, /can_export_receivables := coalesce\(permissions\.export_receivables, false\)/i);
  assert.match(rpc, /can_export_shipment_details := coalesce\(permissions\.export_shipment_details, false\)/i);
  assert.match(rpc, /if not can_export_receivables and not can_export_shipment_details then[\s\S]*SPC_ACCESS_REQUIRED[\s\S]*42501/i);
  assert.match(rpc, /snapshot := public\.spc_load_workspace_unchecked\(\)/i);
  assert.doesNotMatch(rpc, /public\.spc_load_workspace\(\)/i);
  assert.match(rpc, /'canExportReceivables', can_export_receivables[\s\S]*'canExportShipmentDetails', can_export_shipment_details[\s\S]*'projects', finance_projects/i);

  const projectDto = rpc.slice(rpc.indexOf("finance_projects := finance_projects"), rpc.indexOf("return jsonb_build_object"));
  for (const field of ["id", "name", "address", "contact", "units"])
    assert.match(projectDto, new RegExp(`'${field}'`));
  for (const field of ["journals", "surveys", "defects", "events", "photos", "catalog", "version"])
    assert.doesNotMatch(projectDto, new RegExp(`'${field}'`));

  const unitDto = rpc.slice(rpc.indexOf("finance_units := finance_units ||"), rpc.indexOf("finance_projects := finance_projects"));
  for (const field of ["id", "building", "floor", "number", "model", "colorNo", "brand", "estimated", "rate", "note", "status", "works", "acceptances"])
    assert.match(unitDto, new RegExp(`'${field}'`));
  assert.match(rpc, /where value->'_deleted' is distinct from 'true'::jsonb/i);

  const workDto = rpc.slice(rpc.indexOf("finance_works := finance_works ||"), rpc.indexOf("finance_acceptances := '[]'"));
  assert.match(workDto, /jsonb_build_object\(\s*'date', source_work->'date',\s*'area', source_work->'area'\s*\)/i);
  assert.equal((workDto.match(/source_work->/g) || []).length, 2);

  const acceptanceDto = rpc.slice(rpc.indexOf("finance_acceptances := finance_acceptances ||"), rpc.indexOf("finance_units := finance_units ||"));
  for (const field of ["id", "date", "startedAt", "area", "note", "draft", "report"])
    assert.match(acceptanceDto, new RegExp(`'${field}'`));
  assert.equal((acceptanceDto.match(/source_acceptance->/g) || []).length, 6);

  const reportStart = rpc.indexOf("if can_export_shipment_details then");
  const reportEnd = rpc.indexOf("finance_acceptances := finance_acceptances ||", reportStart);
  const report = rpc.slice(reportStart, reportEnd);
  const shipment = report.slice(0, report.indexOf("else"));
  const receivablesOnly = report.slice(report.indexOf("else"));
  const shipmentFields = [
    "shipmentDateText", "sequenceText", "customerNameText", "productText", "unitDisplayText",
    "squareMetersText", "pingText", "unitPriceText", "amountText", "vendorText",
    "purchasePriceText", "noteText", "signedOriginal", "signedCopy", "incomingVoOriginal",
    "incomingVoCopy", "outgoingVoOriginal", "outgoingVoCopy", "submitted", "vendorInvoice",
    "tier", "payable", "profitPercent", "profit",
  ];
  for (const field of shipmentFields) assert.match(shipment, new RegExp(`'${field}'`));
  assert.match(receivablesOnly, /jsonb_build_object\(\s*'noteText', source_acceptance->'report'->'noteText'\s*\)/i);
  for (const field of shipmentFields.filter((field) => field !== "noteText"))
    assert.doesNotMatch(receivablesOnly, new RegExp(`'${field}'`));
  for (const field of ["photos", "signatures", "items", "completion"])
    assert.doesNotMatch(report, new RegExp(`'${field}'`));

  assert.doesNotMatch(rpc, /\b(?:insert|update|delete|truncate)\b|spc_save_workspace_unchecked|spc_merge_workspace|spc_log_workspace_changes/i);
  assert.doesNotMatch(rpc, /spc_json_merge_three_way|\bstorage\./i);
  assert.match(sql, /revoke all on function public\.spc_load_finance_export_data\(\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.spc_load_finance_export_data\(\) to authenticated/i);
  assert.doesNotMatch(sql, /grant execute on function public\.spc_(?:current_approved_role|current_effective_permissions)\(\) to authenticated/i);

  const workspaceIntegration = sql.slice(sql.indexOf("create or replace function public.spc_load_workspace()"), start);
  assert.match(workspaceIntegration, /snapshot := public\.spc_load_workspace_unchecked\(\)[\s\S]*return public\.spc_filter_permissioned_workspace\(snapshot\)/i);
  assert.doesNotMatch(sql, /create or replace function public\.spc_json_merge_three_way(?:_at)?\s*\(/i);
  assert.doesNotMatch(sql, /\bstorage\.|create\s+policy/i);
});

test("phase 5C-2 loads the protected finance DTO without hydration or write behavior", async () => {
  const backend = await read("lib/spc-backend.ts");
  const start = backend.indexOf("export async function loadFinanceExportData");
  const end = backend.indexOf("export async function loadLegacyWorkspace", start);
  const wrapper = backend.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(backend, /export type FinanceExportProject = ExportProject & \{ id: string \}/);
  assert.match(backend, /export type FinanceExportData = \{[\s\S]*canExportReceivables: boolean[\s\S]*canExportShipmentDetails: boolean[\s\S]*projects: FinanceExportProject\[\]/);
  assert.match(wrapper, /supabase\.rpc\("spc_load_finance_export_data"\)/);
  assert.match(wrapper, /if \(error\) throw error/);
  assert.doesNotMatch(wrapper, /hydratePrivatePhotos|serializePrivatePhotos|\.storage\.|spc_(?:merge|save)_workspace|uploadEmbeddedPhotos/);
});

test("phase 5C-2 keeps ordinary finance exports on the protected project with no workspace fallback", async () => {
  const page = await read("app/page.tsx");
  const start = page.indexOf("function Billing(");
  const end = page.indexOf("type CompletionExportDraft", start);
  const billing = page.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(page, /import \{[^}]*loadFinanceExportData[^}]*type FinanceExportData[^}]*type FinanceExportProject[^}]*\} from "\.\.\/lib\/spc-backend"/);
  assert.match(billing, /needsProtectedFinanceData = !canManageFinance && \(canExportReceivables \|\| canExportShipment\)/);
  assert.match(billing, /if \(!needsProtectedFinanceData\)[\s\S]*loadFinanceExportData\(\)\.then/);
  assert.match(billing, /let active = true[\s\S]*if \(!active\) return[\s\S]*return \(\) => \{ active = false; \}/);
  assert.match(billing, /data\.projects\.find\(\(candidate\) => candidate\.id === p\.id\)/);
  assert.match(billing, /if \(!project\)[\s\S]*setFinanceExportError/);
  assert.doesNotMatch(billing, /data\.projects\[0\]|protectedFinanceProject\s*\|\|\s*p|protectedFinanceProject\s*\?\?\s*p/);

  assert.match(billing, /serverCanExportReceivables = canManageFinance \|\| protectedFinanceData\?\.canExportReceivables === true/);
  assert.match(billing, /serverCanExportShipment = canManageFinance \|\| protectedFinanceData\?\.canExportShipmentDetails === true/);
  assert.match(billing, /financeExportProject = canManageFinance \? p : protectedFinanceProject/);
  assert.match(billing, /monthlyBillingRecords = financeExportProject \? buildAcceptanceExportRecords\(financeExportProject\)/);
  assert.match(billing, /const unit = financeExportProject\?\.units\?\.find\(\(item\) => item\.id === record\.unitId\)/);
  assert.match(billing, /buildReceivableExportDraft\(financeExportProject, billRecords\)/);
  assert.match(billing, /createReceivableWorkbook\(financeExportProject, billRecords, ym, receivableDraft\)/);
  assert.match(billing, /createShipmentWorkbook\(financeExportProject, shipmentRecords, ym\)/);

  assert.match(billing, /confirmSave = \(\) => \{[\s\S]*patch\(\{\s*units: p\.units\.map/);
  assert.match(billing, /startShipmentReportEdit = [\s\S]*if \(!canManageFinance\) return[\s\S]*const unit = p\.units\.find/);
  assert.match(billing, /saveShipmentReportSource = [\s\S]*if \(!canManageFinance\) return[\s\S]*const currentUnit = p\.units\.find[\s\S]*patch\(\{ units: p\.units\.map/);
  assert.doesNotMatch(billing.slice(billing.indexOf("loadFinanceExportData().then"), billing.indexOf("const financeExportProject")), /\bpatch\(|saveWorkspace|spc_merge_workspace|uploadEmbeddedPhotos/);
  assert.doesNotMatch(billing, /financeExportError[\s\S]*(?:signOut|localStorage\.(?:clear|removeItem)|indexedDB\.deleteDatabase)/i);
  assert.doesNotMatch(billing, /cleanupRemovedPhotos|supabase\.storage|spc-photos/);
  assert.match(billing, /financeExportLoading[\s\S]*正在讀取財務匯出資料/);
  assert.match(billing, /financeExportError[\s\S]*className="form-error billing-no-print"/);
});
