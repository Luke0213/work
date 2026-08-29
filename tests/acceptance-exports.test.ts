import test from "node:test";
import assert from "node:assert/strict";
import { buildAcceptanceExportRecords, createReceivableWorkbook, createShipmentWorkbook } from "../lib/acceptance-exports.ts";
import { getLatestFinalAcceptance } from "../lib/acceptance-records.ts";

const project = {
  name: "家田富築",
  address: "桃園市測試路 1 號",
  contact: "王主任",
  units: [{
    id: "u1",
    building: "A棟",
    floor: "15樓",
    number: "A15-5",
    model: "Y5006",
    colorNo: "伊西斯",
    brand: "神祇系列",
    rate: 2750,
    estimated: 10,
    works: [{ date: "2026-04-30", area: 12.69 }],
    acceptances: [{ id: "a1", date: "2026-05-01", area: 12.69, note: "完成", draft: false }],
  }],
};

test("normalizes acceptance records with ping and square meter values", () => {
  const records = buildAcceptanceExportRecords(project);
  assert.equal(records.length, 1);
  assert.equal(records[0].areaPing, 12.69);
  assert.equal(records[0].areaSquareMeters, 41.95);
  assert.equal(records[0].unitPrice, 2750);
  assert.equal(records[0].amount, 34898);
  assert.equal(records[0].exportDate, "2026-04-30");
  assert.match(records[0].unitDisplay, /A15-5/);
});

test("deleted units are excluded from acceptance export rows", () => {
  const deletedUnit = { ...project.units[0], id: "deleted", _deleted: true };
  const records = buildAcceptanceExportRecords({ ...project, units: [project.units[0], deletedUnit] });
  assert.deepEqual(records.map((record) => record.unitId), ["u1"]);
});

test("shipment workbook contains stable formulas without reference errors", () => {
  const records = buildAcceptanceExportRecords(project);
  const workbook = createShipmentWorkbook(project, records, "2026-04") as {
    Sheets: Record<string, Record<string, { f?: string; v?: string }>>;
  };
  const sheet = workbook.Sheets["已出貨明細總表"];
  assert.equal(sheet.F4.v, 41.95);
  assert.equal(sheet.G4.f, "ROUND(F4*0.3025,2)");
  assert.equal(sheet.H4.v, 2750);
  assert.equal(sheet.I4.f, 'IF(OR(G4="",H4=""),"",ROUND(G4*H4,0))');
  assert.equal(sheet.R3.v, "銷VO影");
  assert.equal(sheet.X3.v, "利潤");
  assert.doesNotMatch(JSON.stringify(sheet), /#REF!|#VALUE!|#DIV\/0!|#NAME\?/);
  assert.equal(sheet.A1.v, "2026年04月SPC已出貨明細總表");
});

test("receivable workbook keeps quantity blank and uses safe Excel formulas", () => {
  const records = buildAcceptanceExportRecords(project);
  const workbook = createReceivableWorkbook(project, records, "2026-04") as {
    Sheets: Record<string, Record<string, { f?: string; v?: string | number }>>;
  };
  const sheet = workbook.Sheets["應收帳款明細表"];
  assert.equal(sheet.A1.v, "SPC");
  assert.equal(sheet.A2.v, "神銀建材 應收帳款明細表");
  assert.equal(sheet.A6.v, "日期");
  assert.equal(sheet.B6.v, "型號");
  assert.equal(sheet.C6.v, "尺寸cm");
  assert.equal(sheet.D6.v, "數量");
  assert.equal(sheet.E6.v, "單價／元");
  assert.equal(sheet.F6.v, "合計");
  assert.equal(sheet.C7.v, "");
  assert.equal(sheet.D7.v, "");
  assert.equal(sheet.E7.v, 2750);
  assert.equal(sheet.F7.f, 'IF(OR(D7="",E7=""),0,D7*E7)');
  assert.equal(sheet.F20.f, "SUM(F7:F16)");
  assert.equal(sheet.F21.f, "ROUND(F20*5%,0)");
  assert.equal(sheet.F22.f, "F20+F21");
  assert.equal(sheet.A23.v, "發票字軌");
  assert.equal(sheet.A28.v, "匯款帳號如下：");
  assert.equal(sheet.A29.v, "永豐銀行 龍江分行 戶名:神銀建材資訊有限公司 帳號:148-018-0005023-3");
  assert.equal(sheet.A30.v, "聯絡人:左沁靈 0930-616-025 電話: (02)2587-3066(代表號)");
  assert.equal(sheet.A31.v, "傳真: (02)2587-3028 地址: 臺北市中山區建國北路3段92號3樓");
  assert.equal((sheet as unknown as { "!rows": Array<{ hpt: number }> })["!rows"][27].hpt, 32);
  assert.equal((sheet as unknown as { "!rows": Array<{ hpt: number }> })["!rows"][30].hpt, 32);
  assert.equal(sheet["!printArea"], "A1:F31");
  assert.doesNotMatch(JSON.stringify(workbook), /#REF!|#VALUE!|#DIV\/0!|#NAME\?/);
});

test("receivable workbook expands beyond its ten blank detail rows", () => {
  const source = buildAcceptanceExportRecords(project)[0];
  const records = Array.from({ length: 12 }, (_, index) => ({ ...source, unitId: `unit-${index}`, exportDate: `2026-04-${String(index + 1).padStart(2, "0")}` }));
  const workbook = createReceivableWorkbook(project, records, "2026-04") as {
    Sheets: Record<string, Record<string, { f?: string; v?: string | number }>>;
  };
  const sheet = workbook.Sheets["應收帳款明細表"];
  assert.equal(sheet.F18.f, 'IF(OR(D18="",E18=""),0,D18*E18)');
  assert.equal(sheet.F22.f, "SUM(F7:F18)");
  assert.equal(sheet["!printArea"], "A1:F33");
});

test("shipment workbook converts square meters to ping and keeps amount formulas editable", () => {
  const records = [
    { projectName: "測試案場", address: "", contact: "", unitId: "u6680", unitDisplay: "A2-2", model: "Y5006", colorNo: "伊西斯", vendor: "", workDate: "2026-08-01", acceptanceDate: "", exportDate: "2026-08-01", areaPing: 20.21, areaSquareMeters: 66.8, unitPrice: 2750, amount: 55578, note: "" },
    { projectName: "測試案場", address: "", contact: "", unitId: "u4110", unitDisplay: "A4-1", model: "Y5006", colorNo: "伊西斯", vendor: "", workDate: "2026-08-02", acceptanceDate: "", exportDate: "2026-08-02", areaPing: 12.43, areaSquareMeters: 41.1, unitPrice: 0, amount: 0, note: "" },
  ];
  const workbook = createShipmentWorkbook({ name: "測試案場", units: [] }, records, "2026-08") as {
    Sheets: Record<string, Record<string, { f?: string; v?: string | number; z?: string }>>;
  };
  const sheet = workbook.Sheets["已出貨明細總表"];
  assert.equal(Number((66.8 * 0.3025).toFixed(2)), 20.21);
  assert.equal(Number((41.1 * 0.3025).toFixed(2)), 12.43);
  assert.equal(Math.round(20.21 * 2750), 55578);
  assert.equal(sheet.F4.v, 66.8);
  assert.equal(sheet.G4.v, 20.21);
  assert.equal(sheet.G4.f, "ROUND(F4*0.3025,2)");
  assert.equal(sheet.I4.v, 55578);
  assert.equal(sheet.I4.f, 'IF(OR(G4="",H4=""),"",ROUND(G4*H4,0))');
  assert.equal(sheet.F5.v, 41.1);
  assert.equal(sheet.G5.v, 12.43);
  assert.equal(sheet.G5.f, "ROUND(F5*0.3025,2)");
  assert.doesNotMatch(JSON.stringify(workbook), /#REF!|#VALUE!|#DIV\/0!|#NAME\?/);
});

test("latest final acceptance selection handles final, recheck, and draft histories", () => {
  const finalA = { id: "a", date: "2026-08-20", startedAt: "2026/8/20 上午 9:10:00", area: 10, note: "第一次驗收", draft: false };
  const finalB = { id: "b", date: "2026-08-22", startedAt: "2026/8/22 下午 3:20:00", area: 12, note: "正式複驗", draft: false, recheck: true };
  const draftC = { id: "c", date: "2026-08-23", startedAt: "2026/8/23 下午 4:00:00", area: 13, note: "新草稿", draft: true };

  assert.equal(getLatestFinalAcceptance({ acceptances: [finalA] })?.id, "a");
  assert.equal(getLatestFinalAcceptance({ acceptances: [draftC, finalA] })?.id, "a");
  assert.equal(getLatestFinalAcceptance({ acceptances: [finalA, finalB] })?.id, "b");
  assert.equal(getLatestFinalAcceptance({ acceptances: [draftC, finalA, finalB] })?.id, "b");
  assert.equal(getLatestFinalAcceptance({ acceptances: [draftC] }), undefined);
});

test("acceptance exporter derives fields from the latest final recheck", () => {
  const exportProject = {
    ...project,
    units: [{
      ...project.units[0],
      acceptances: [
        { id: "draft", date: "2026-05-03", startedAt: "2026/5/3 下午 4:00:00", area: 15, note: "草稿", draft: true },
        { id: "first", date: "2026-05-01", startedAt: "2026/5/1 上午 9:00:00", area: 11, note: "第一次驗收", draft: false },
        { id: "recheck", date: "2026-05-02", startedAt: "2026/5/2 下午 2:00:00", area: 13, note: "正式複驗", draft: false },
      ],
    }],
  };
  const [record] = buildAcceptanceExportRecords(exportProject);
  assert.equal(record.acceptanceDate, "2026-05-02");
  assert.equal(record.areaPing, 13);
  assert.equal(record.note, "正式複驗");
});
