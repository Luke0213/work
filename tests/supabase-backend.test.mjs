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

test("monitoring, scheduled backups, and full Excel export are wired", async () => {
  const page = await read("app/page.tsx");
  const monitoring = await read("lib/monitoring.ts");
  const sql = await read("supabase/migrations/202608240004_monitoring_and_schedule.sql");
  assert.match(page, /exportFullExcel/);
  for (const sheet of ["專案","產品","戶別","場勘","施工","驗收","缺失","工作日誌","事件"]) assert.match(page, new RegExp(`add\\("${sheet}"`));
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
  assert.match(page, /const estimated = importedAreaToPing\(source\)/);
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

test("survey door inspection records measurements, gap, evidence, photos, and Excel fields", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["doorInspection", "thresholdCm", "meetsThreshold", "hasGap", "rationale", "至少 1.5 cm", "為什麼合格", "如何改善", "門檢查照片", "門檢查結果"]) {
    assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(page, /Number\(door\.thresholdCm\) >= 1\.5/);
});

test("survey uses responsive launchers and one combined door workflow", async () => {
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  for (const value of ["doorSurveyLabels", "門與門檻", "door-combined-checks", "updateDoorItem", "doorCombinedResult"])
    assert.match(page, new RegExp(value));
  assert.match(page, /items=\{s\.items\.filter\(\(item\) => !doorSurveyLabels\.includes\(item\.label\)\)\}/);
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
  assert.match(css, /\.visually-hidden-file\{position:absolute!important;width:1px!important/);
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
  assert.match(page, /requiresMeasurement\?: boolean/);
  assert.match(page, /requiresMeasurement: label === "地坪平整度"/);
  assert.match(page, /current\.requiresMeasurement === true && <div className="inspection-measure">/);
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
  for (const value of [
    "body.printing-completion .completion-paper",
    "width:210mm",
    "height:297mm",
    "height:87mm",
    "break-inside:avoid",
    "page-break-inside:avoid",
    ".acceptance-checklist .inspection-grid{grid-template-columns:repeat(3,minmax(0,1fr))}",
  ]) assert.match(css, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(page, /const a = u\.acceptances\[0\]/);
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

test("every unfinished data-entry flow has durable drafts and notes", async () => {
  const page = await read("app/page.tsx");
  for (const value of ["project-onboarding", "unit-create", "global-product", "project-product", "riskDraftKey", "IndexedDB workspace save failed", "停車備註", "改善備註"]) assert.match(page, new RegExp(value));
  assert.match(page, /readWorkspaceDraft\(authUserId\) \|\| indexedWorkspace\?\.payload/);
  assert.match(page, /saveOfflineDraft\(\{ key: scopedKey\(workspaceDraftKey, owner\)/);
});
