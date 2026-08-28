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
  assert.match(acceptance, /useOfflineDraftRestore\(draftKey\(authUserId, "accept", u\.id\), setA, acceptanceDraftActiveRef\)/);
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

test("unit estimated remains the canonical ping area and survey only displays it", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /estimated: areaInputToPing/);
  assert.match(page, /const importedEstimated = importedAreaToPing\(source\)/);
  assert.match(page, /const estimated = safeImportedEstimated\(importedEstimated\)/);
  assert.match(page, /survey-estimated-area/);
  assert.match(page, /沿用戶別主資料，此處僅供查看/);
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

test("admins can create email or Taiwan phone accounts with a forced password change", async () => {
  const page = await read("app/page.tsx");
  const api = await read("app/api/admin/users/route.ts");
  const audit = await read("supabase/migrations/202608260005_phone_identity_audit.sql");
  assert.match(page, /電子郵件或手機號碼/);
  assert.match(page, /must_change_password/);
  assert.match(api, /auth\.admin\.createUser/);
  assert.match(api, /1234qwer/);
  assert.match(api, /@phone\.spc\.internal/);
  assert.match(api, /local_phone/);
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

test("survey door inspection records measurements, gap, evidence, photos, and Excel fields", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["doorInspection", "thresholdCm", "meetsThreshold", "hasGap", "rationale", "至少 1.5 cm", "判斷依據（選填）", "如何改善", "門檢查照片", "門檢查結果"]) {
    assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(page, /Number\(door\.thresholdCm\) >= 1\.5/);
});

test("survey uses responsive launchers and one combined door workflow", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  for (const value of ["doorSurveyLabels", "門與門檻", "door-combined-checks", "updateDoorItem", "doorCombinedResult"])
    assert.match(page, new RegExp(value));
  assert.match(page, /const doorSurveyLabels = \["門框是否完成", "門扇是否已安裝", "廁所門框狀態"\]/);
  assert.match(page, /surveyChecklistItems = \[[\s\S]*!doorSurveyLabels\.includes\(item\.label\)[\s\S]*item\.label !== "其他異常"[\s\S]*item\.label === "其他異常"/);
  assert.match(page, /items=\{surveyChecklistItems\}/);
  assert.match(page, /panel form survey-tab/);
  assert.match(css, /\.survey-tab \.survey-section-grid\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(min-width:701px\) and \(max-width:1099px\)/);
  assert.match(css, /\.survey-tab \.survey-section-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
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

test("floor progress summaries count one normalized current status per unit", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["unitProgressStatuses", "getUnitCurrentStatus", 'case "待確認"', 'case "場勘待改善"', 'case "驗收缺失"', 'case "待複驗"', 'case "已計價"']) {
    assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(page, /floorUnits\.filter\(\(u\) => getUnitCurrentStatus\(u\) === s\)\.length/);
  assert.match(page, /\.filter\(\(x\) => x\[1\] > 0\)/);
  assert.match(page, /tasks = \{[\s\S]*getUnitCurrentStatus\(u\) === "待場勘"[\s\S]*getUnitCurrentStatus\(u\) === "改善中"[\s\S]*getUnitCurrentStatus\(u\) === "待驗收"/);
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
  for (const value of ["第一次使用，照這 5 步即可", "InspectionGuide", "應收帳款 Excel", "報表／匯出", "SPC 已出貨明細總表", "shipmentRecords = monthlyBillingRecords", "createReceivableWorkbook", "saveReceivableWorkbook", "確認產生 Excel", "使用 Supabase 最新資料", "保留這台電腦內容並重新同步"]) assert.match(page, new RegExp(value));
  assert.doesNotMatch(page, /帳單 Word|createReceivableDocx|應收帳款明細表\.docx/);
});

test("billing screen, receivable Excel, CSV, totals, and print share the selected month records", async () => {
  const page = await read("app/page.tsx");
  for (const value of [
    "monthlyBillingRecords = buildAcceptanceExportRecords(p).filter",
    "record.exportDate.startsWith(ym)",
    "shipmentRecords = monthlyBillingRecords",
    "billSubtotal = billRecords.reduce",
    "exportCsv(p, billRecords, ym)",
    "record.areaPing",
    "record.amount",
    "printing-billing",
  ]) assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(page, /exportCsv\(p, eligible\)/);
});

test("electronic acceptance excludes drafts and billing labels its CSV accurately", async () => {
  const page = await read("app/page.tsx");
  const acceptanceRecords = await read("lib/acceptance-records.ts");
  const acceptanceExports = await read("lib/acceptance-exports.ts");
  for (const value of [
    "const a = getLatestFinalAcceptance(u)",
    "目前尚無正式驗收紀錄，完成驗收後即可產生電子驗收單。",
    "CSV 匯出",
    "月結戶別明細 · CSV",
  ]) assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const value of ["getLatestFinalAcceptance", "acceptance.draft !== true", "acceptanceRecordTime(acceptance) > acceptanceRecordTime(latest)"])
    assert.match(acceptanceRecords, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(acceptanceExports, /const acceptance = getLatestFinalAcceptance\(unit\)/);
  assert.doesNotMatch(acceptanceExports, /\.find\(\(item\) => !item\.draft\)/);
  assert.doesNotMatch(page, /const a = u\.acceptances\[0\]/);
});

test("work journal Word export uses split first page and six fitted photos per page", async () => {
  const page = await read("app/page.tsx");
  const exporter = page.slice(page.indexOf("async function buildJournalPhotoRun"), page.indexOf("function UnitJournalTab"));
  assert.match(exporter, /columnWidths: \[4400, 4960\]/);
  assert.match(exporter, /const PHOTO_PER_PAGE = 6/);
  assert.match(exporter, /photos\.slice\(0, 2\)/);
  assert.match(exporter, /photos\.slice\(2, PHOTO_PER_PAGE\)/);
  assert.match(exporter, /index \+= PHOTO_PER_PAGE/);
  assert.match(exporter, /photos\.slice\(index, index \+ PHOTO_PER_PAGE\)/);
  assert.match(exporter, /Math\.min\(maxWidth \/ dimensions\.width, maxHeight \/ dimensions\.height\)/);
  assert.match(exporter, /cantSplit: true/);
  assert.match(exporter, /"無工作照片"/);
  assert.doesNotMatch(exporter, /填寫人：|建立：|最後修改：/);
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
  assert.match(survey, /useOfflineDraftRestore\(draftKey\(authUserId, "survey", u\.id\), setS\)/);
  assert.match(survey, /writeLocalDraft\(draftKey\(authUserId, "survey", u\.id\), s, authUserId\)/);
});

test("survey navigation inserts door inspection before the final other issue item", async () => {
  const page = await read("app/page.tsx");
  const survey = page.slice(page.indexOf("function SurveyTab"), page.indexOf("function WorkTab"));
  const checklist = page.slice(page.indexOf("function Checklist"), page.indexOf("function History"));
  assert.match(survey, /onBeforeLast=\{\(\) => \{ setDoorFlowActive\(true\); setSurveyDetail\("door"\); \}\}/);
  assert.match(survey, /resumeAtLast=\{doorFlowResume\}/);
  assert.match(survey, /下一項：其他異常/);
  assert.match(survey, /beforeLastItem=\{<button[\s\S]*門與門檻/);
  assert.match(checklist, /beforeLastItem && i === items\.length - 1/);
  assert.match(checklist, /if \(onBeforeLast && active === items\.length - 2\) onBeforeLast\(\)/);
  assert.match(checklist, /if \(resumeAtLast > 0 && items\.length\) open\(items\.length - 1\)/);
  assert.match(checklist, /onClick=\{\(\) => setActive\(Math\.max\(0, active - 1\)\)\}/);
  assert.match(checklist, /else if \(active < items\.length - 1\) open\(active \+ 1\)/);
});

test("normal door inspection keeps measurement optional while defects require evidence", async () => {
  const page = await read("app/page.tsx");
  const survey = page.slice(page.indexOf("function SurveyTab"), page.indexOf("function WorkTab"));
  assert.match(survey, /doorThresholdFailed = doorMeasured && Number\(door\.thresholdCm\) < 1\.5/);
  assert.match(survey, /doorInvalid = door\.hasGap === null \|\| \(doorResult === "不合格" && \(!door\.rationale\.trim\(\) \|\| !door\.photos\?\.length\)\)/);
  assert.doesNotMatch(survey, /doorInvalid = !doorMeasured/);
  assert.match(survey, /doorItemEvidenceInvalid = doorItems\.some\(\(item\) => item\.result === "不合格" && \(!item\.note\.trim\(\) \|\| !item\.photos\?\.length\)\)/);
  assert.match(survey, /門檢查不合格時，必須說明如何改善並上傳至少 1 張照片/);
  assert.match(survey, /thresholdCm/);
  assert.match(survey, /doorInspection: \{ \.\.\.door, meetsThreshold:/);
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
  assert.match(page, /word-preview-photos[\s\S]*ZoomablePhoto key=\{photo\.id\} photo=\{photo\}/);
  assert.match(css, /\.photo-lightbox \.photo-lightbox-image\{[^}]*max-width:[^;]+!important;[^}]*max-height:[^;]+!important;[^}]*object-fit:contain!important/);
  assert.match(css, /\.photo-zoom-trigger\{cursor:zoom-in\}/);
});

test("unit acceptance journal alone uses larger frameless responsive photos", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  const unitJournal = page.slice(page.indexOf("function UnitJournalTab"), page.indexOf("function Journal"));
  const scopedStyles = css.slice(css.indexOf("Unit acceptance journal photos only"));

  assert.match(unitJournal, /<div className="unit-journal-photos"><Photos node="戶別工作日誌"/);
  assert.match(scopedStyles, /\.unit-journal-photos \.photo-records\{[\s\S]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(scopedStyles, /\.unit-journal-photos \.photo-record\{[\s\S]*grid-template-columns:minmax\(220px,52%\) minmax\(0,1fr\);[\s\S]*border:0;[\s\S]*border-radius:0;[\s\S]*background:transparent;[\s\S]*overflow:visible/);
  assert.match(scopedStyles, /\.unit-journal-photos \.photo-record>\.photo-zoom-trigger\{[\s\S]*width:100%;[\s\S]*height:220px;[\s\S]*object-fit:cover/);
  assert.match(scopedStyles, /@media\(max-width:700px\)[\s\S]*\.unit-journal-photos \.photo-records\{grid-template-columns:minmax\(0,1fr\);[\s\S]*\.unit-journal-photos \.photo-record>\.photo-zoom-trigger\{[\s\S]*width:100%;/);
  assert.match(css, /\.photo-record\{display:grid/);
  assert.match(page, /function PhotoGrid[\s\S]*<ZoomablePhoto photo=\{x\}/);
  assert.match(page, /function ZoomablePhoto[\s\S]*photo-lightbox/);
  assert.match(unitJournal, /word-preview-photos/);
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

  assert.match(wordExporter, /columnWidths: \[4400, 4960\]/);
  assert.doesNotMatch(wordExporter, /正在修改|新增今日日誌|新增驗收日誌/);
});

test("project daily acceptance view derives final history and reuses shipment workbook", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /\["daily-acceptance", "✓", "今日驗收"\]/);
  assert.match(page, /buildDailyAcceptanceEntries<Acceptance, Unit>/);
  assert.match(page, /buildAcceptanceExportRecord\(p, unit, acceptance, true\)/);
  assert.match(page, /createShipmentWorkbook\(p, exportRecords/);
  assert.doesNotMatch(page, /function createDaily.*Workbook/i);
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
  const completionPrint = css.slice(css.lastIndexOf("@media print{"), css.indexOf(".area-input-row"));
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

test("completion export confirmation edits one temporary draft shared by all three copies", async () => {
  const page = await read("app/page.tsx");
  const report = page.slice(page.indexOf("type CompletionExportDraft"), page.indexOf("function Timeline"));
  const css = await read("app/globals.css");
  assert.match(report, /buildCompletionExportDraft\(project, unit, acceptance, completion\)/);
  for (const value of ["project.name", "project.address", "unit.order", "acceptance.area", "unit.estimated", "completion.floorAbnormal", "completion.boardDamaged", "completion.trashCleared"])
    assert.match(report, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(report, /const \[exportDraft, setExportDraft\]/);
  assert.match(report, /const reportSignatures = signatures \|\| completion\.signatures/);
  assert.match(report, /\.map\(\(copy\) => <CompletionCopy key=\{copy\} copy=\{copy\} draft=\{exportDraft\} signatures=\{reportSignatures\}/);
  assert.match(report, /resolveFloorSignatures\(floorRecord, floorUnits\)/);
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

test("shipment preview exposes the company summary fields without changing other exporters", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["出貨日期", "客戶名稱", "商品", "片／件 *0.3025", "單價／元", "進價／元", "record.areaSquareMeters", "record.areaPing", "record.unitPrice", "record.amount", "record.vendor"])
    assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
  const mobile = css.slice(css.indexOf(marker));
  assert.match(mobile, /@media\(max-width:700px\)/);
  assert.match(mobile, /\.unit-manager[\s\S]*\.unit-manager \.building-groups[\s\S]*\.unit-manager \.building-group[\s\S]*width:100%;[\s\S]*min-width:0;[\s\S]*max-width:100%/);
  assert.match(mobile, /\.unit-manager \.floor-head\{[\s\S]*grid-template-columns:minmax\(0,1fr\);[\s\S]*min-height:46px/);
  assert.match(mobile, /\.unit-manager \.floor-head\.bulk\{[\s\S]*grid-template-columns:28px minmax\(0,1fr\)/);
  assert.match(mobile, /\.unit-manager \.floor-row-main\{[\s\S]*min-height:46px;[\s\S]*grid-template-columns:auto auto minmax\(0,1fr\) 18px/);
  assert.doesNotMatch(mobile, /@media\(min-width:701px\)/);
});

test("every unfinished data-entry flow has durable drafts and notes", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["project-onboarding", "unit-create", "global-product", "project-product", "riskDraftKey", "logStorageException", "停車備註", "改善備註"]) assert.match(page, new RegExp(value));
  assert.match(page, /readWorkspaceDraft\(authUserId\) \|\| indexedWorkspace\?\.payload/);
  assert.match(page, /saveOfflineDraft\(\{ key: scopedKey\(workspaceDraftKey, owner\)/);
});
