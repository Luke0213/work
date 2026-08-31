import test from "node:test";
import assert from "node:assert/strict";
import { buildAcceptanceExportRecords, buildReceivableExportDraft, createReceivableWorkbook, createShipmentWorkbook, receivableDraftTotals } from "../lib/acceptance-exports.ts";
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
const emptyReportFields = {
  signedOriginal: false, signedCopy: false, incomingVoOriginal: "", incomingVoCopy: "",
  outgoingVoOriginal: "", outgoingVoCopy: "", submitted: "", vendorInvoice: "", tier: "",
  payable: "", profitPercent: "", profit: "",
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
  assert.deepEqual(Object.fromEntries(Object.keys(emptyReportFields).map((key) => [key, records[0][key as keyof typeof records[0]]])), emptyReportFields);
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
  assert.equal(sheet.F3.v, 41.95);
  assert.equal(sheet.G3.f, "ROUND(F3*0.3025,2)");
  assert.equal(sheet.H3.v, 2750);
  assert.equal(sheet.I3.f, 'IF(OR(G3="",H3=""),"",ROUND(G3*H3,0))');
  assert.equal(sheet.A2.v, "出貨日期");
  assert.equal(sheet.R2.v, "銷VO影");
  assert.equal(sheet.X2.v, "利潤");
  assert.equal(sheet.F4.f, "SUM(F3:F3)");
  assert.equal((sheet as any)["!freeze"].ySplit, 2);
  assert.equal((sheet as any)["!freeze"].topLeftCell, "A3");
  assert.equal((sheet as any)["!autofilter"].ref, "A2:X3");
  assert.equal((sheet as any)["!printHeader"], "1:2");
  assert.equal((sheet as any)["!cols"][12].wch, 5);
  assert.equal((sheet as any)["!cols"][13].wch, 5);
  assert.doesNotMatch(JSON.stringify(sheet), /工地下訂/);
  assert.doesNotMatch(JSON.stringify(sheet), /#REF!|#VALUE!|#DIV\/0!|#NAME\?/);
  assert.equal(sheet.A1.v, "2026年04月SPC已出貨明細總表");
});

test("receivable workbook uses exactly one detail row and safe Excel formulas", () => {
  const records = buildAcceptanceExportRecords(project);
  const workbook = createReceivableWorkbook(project, records, "2026-04") as {
    Sheets: Record<string, Record<string, { f?: string; v?: string | number; z?: string }>>;
  };
  const sheet = workbook.Sheets["應收帳款明細表"];
  assert.equal(sheet.A1.v, "家田富築 SPC");
  assert.equal(sheet.A2.v, "神銀建材 應收帳款明細表");
  assert.equal(sheet.A3.v, "送貨聯絡人：");
  assert.equal(sheet.A6.v, "日期");
  assert.equal(sheet.B6.v, "型號");
  assert.equal(sheet.C6.v, "尺寸cm");
  assert.equal(sheet.D6.v, "數量(坪)");
  assert.equal(sheet.E6.v, "單價／元");
  assert.equal(sheet.F6.v, "合計");
  assert.equal(sheet.G6.v, "備註");
  assert.equal(sheet.C7.v, "");
  assert.equal(sheet.D7.v, "");
  assert.equal(sheet.D7.z, "0.00");
  assert.equal(sheet.E7.v, 2750);
  assert.equal(sheet.F7.f, 'IF(OR(D7="",E7=""),0,D7*E7)');
  assert.equal(sheet.G7.v, "完成");
  assert.equal(sheet.A8.v, "");
  assert.equal(sheet.A9.v, "SPC");
  assert.equal(sheet.F11.f, "SUM(F7:F7)");
  assert.equal(sheet.F12.f, "ROUND(F11*5%,0)");
  assert.equal(sheet.F13.f, "F11-F12");
  assert.equal(sheet.A14.v, "發票字軌：");
  assert.equal(sheet.A19.v, "匯款帳號如下：");
  assert.equal(sheet.A20.v, "永豐銀行 龍江分行 戶名:神銀建材資訊有限公司 帳號:148-018-0005023-3");
  assert.equal(sheet.A21.v, "聯絡人:左沁靈 0930-616-025 電話: (02)2587-3066(代表號)");
  assert.equal(sheet.A22.v, "傳真: (02)2587-3028 地址: 臺北市中山區建國北路3段92號3樓");
  assert.equal((sheet as unknown as { "!rows": Array<{ hpt: number }> })["!rows"][18].hpt, 32);
  assert.equal((sheet as unknown as { "!rows": Array<{ hpt: number }> })["!rows"][21].hpt, 32);
  assert.equal(sheet["!printArea"], "A1:G22");
  assert.deepEqual((sheet as any)["!cols"].map((column: { wch: number }) => column.wch), [13, 18, 14, 13, 15, 17, 28]);
  assert.ok((sheet as any)["!merges"].some((range: { s: { r: number; c: number }; e: { r: number; c: number } }) => range.s.r === 0 && range.s.c === 0 && range.e.r === 0 && range.e.c === 6));
  assert.equal((sheet as any)["!pageSetup"].fitToHeight, 0);
  assert.doesNotMatch(JSON.stringify(workbook), /#REF!|#VALUE!|#DIV\/0!|#NAME\?/);
});

test("receivable workbook uses six actual detail rows before its summary", () => {
  const source = buildAcceptanceExportRecords(project)[0];
  const records = Array.from({ length: 6 }, (_, index) => ({ ...source, unitId: `six-${index}`, exportDate: `2026-04-${String(index + 1).padStart(2, "0")}` }));
  const workbook = createReceivableWorkbook(project, records, "2026-04") as {
    Sheets: Record<string, Record<string, { f?: string; v?: string | number }>>;
  };
  const sheet = workbook.Sheets["應收帳款明細表"];
  assert.equal(sheet.F12.f, 'IF(OR(D12="",E12=""),0,D12*E12)');
  assert.equal(sheet.A13.v, "");
  assert.equal(sheet.A14.v, "SPC");
  assert.equal(sheet.F16.f, "SUM(F7:F12)");
  assert.equal(sheet.F17.f, "ROUND(F16*5%,0)");
  assert.equal(sheet.F18.f, "F16-F17");
});

test("receivable workbook expands to twelve actual detail rows", () => {
  const source = buildAcceptanceExportRecords(project)[0];
  const records = Array.from({ length: 12 }, (_, index) => ({ ...source, unitId: `unit-${index}`, exportDate: `2026-04-${String(index + 1).padStart(2, "0")}` }));
  const workbook = createReceivableWorkbook(project, records, "2026-04") as {
    Sheets: Record<string, Record<string, { f?: string; v?: string | number }>>;
  };
  const sheet = workbook.Sheets["應收帳款明細表"];
  assert.equal(sheet.F18.f, 'IF(OR(D18="",E18=""),0,D18*E18)');
  assert.equal(sheet.A19.v, "");
  assert.equal(sheet.A20.v, "SPC");
  assert.equal(sheet.F22.f, "SUM(F7:F18)");
  assert.equal(sheet.F23.f, "ROUND(F22*5%,0)");
  assert.equal(sheet.F24.f, "F22-F23");
  assert.equal(sheet["!printArea"], "A1:G33");
});

test("receivable export-only draft overrides editable document fields", () => {
  const records = buildAcceptanceExportRecords(project);
  const draft = buildReceivableExportDraft(project, records);
  assert.equal(draft.deliveryAddress, project.address);
  draft.details[0] = { date: "115.08.31", model: "手動型號", sizeCm: "18x122", quantity: "15.40", unitPrice: "3200", note: "本次匯出備註" };
  Object.assign(draft, {
    deliveryContact: "林主任", deliveryAddress: "台北市測試地址", invoiceTrack: "AB12345678", invoiceDate: "115.09.01",
    receivedAmount: "1000", receivedDate: "115.09.02", preparedBy: "小王", paymentMethod: "匯款",
    deliveryDate: "115.09.03", handler: "陳小姐", supervisor: "主管甲", accounting: "會計乙",
  });
  const workbook = createReceivableWorkbook(project, records, "2026-04", draft) as {
    Sheets: Record<string, Record<string, { f?: string; v?: string | number; z?: string }>>;
  };
  const sheet = workbook.Sheets["應收帳款明細表"];
  assert.deepEqual(receivableDraftTotals(draft), { subtotal: 49280, tax: 2464, receivable: 46816 });
  assert.equal(sheet.B3.v, "林主任");
  assert.equal(sheet.B4.v, "台北市測試地址");
  assert.deepEqual([sheet.A7.v, sheet.B7.v, sheet.C7.v, sheet.D7.v, sheet.E7.v], ["115.08.31", "手動型號", "18x122", 15.4, 3200]);
  assert.equal(sheet.D7.z, "0.00");
  assert.equal(sheet.F7.f, 'IF(OR(D7="",E7=""),0,D7*E7)');
  assert.equal(sheet.G7.v, "本次匯出備註");
  assert.equal(sheet.A14.v, "發票字軌：AB12345678");
  assert.equal(sheet.C14.v, "發票日期：115.09.01");
  assert.equal(sheet.A15.v, "已收款金額：1000");
  assert.equal(sheet.C15.v, "收款日期：115.09.02");
  assert.equal(sheet.E15.v, "製表：小王");
  assert.equal(sheet.A16.v, "支付方式：匯款");
  assert.equal(sheet.C16.v, "送單日期：115.09.03");
  assert.equal(sheet.E16.v, "承辦人：陳小姐");
  assert.equal(sheet.A17.v, "主管：主管甲");
  assert.equal(sheet.C17.v, "會計：會計乙");
  assert.equal(sheet.E17.v, "客戶簽名：");
});

test("shipment workbook converts square meters to ping and keeps amount formulas editable", () => {
  const records = [
    { projectName: "測試案場", address: "", contact: "", unitId: "u6680", unitDisplay: "A2-2", model: "Y5006", colorNo: "伊西斯", vendor: "", workDate: "2026-08-01", acceptanceDate: "", exportDate: "2026-08-01", areaPing: 20.21, areaSquareMeters: 66.8, unitPrice: 2750, amount: 55578, note: "", ...emptyReportFields },
    { projectName: "測試案場", address: "", contact: "", unitId: "u4110", unitDisplay: "A4-1", model: "Y5006", colorNo: "伊西斯", vendor: "", workDate: "2026-08-02", acceptanceDate: "", exportDate: "2026-08-02", areaPing: 12.43, areaSquareMeters: 41.1, unitPrice: 0, amount: 0, note: "", ...emptyReportFields },
  ];
  const workbook = createShipmentWorkbook({ name: "測試案場", units: [] }, records, "2026-08") as {
    Sheets: Record<string, Record<string, { f?: string; v?: string | number; z?: string }>>;
  };
  const sheet = workbook.Sheets["已出貨明細總表"];
  assert.equal(Number((66.8 * 0.3025).toFixed(2)), 20.21);
  assert.equal(Number((41.1 * 0.3025).toFixed(2)), 12.43);
  assert.equal(Math.round(20.21 * 2750), 55578);
  assert.equal(sheet.F3.v, 66.8);
  assert.equal(sheet.G3.v, 20.21);
  assert.equal(sheet.G3.f, "ROUND(F3*0.3025,2)");
  assert.equal(sheet.I3.v, 55578);
  assert.equal(sheet.I3.f, 'IF(OR(G3="",H3=""),"",ROUND(G3*H3,0))');
  assert.equal(sheet.F4.v, 41.1);
  assert.equal(sheet.G4.v, 12.43);
  assert.equal(sheet.G4.f, "ROUND(F4*0.3025,2)");
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

test("explicit zero area and cleared acceptance note remain formal export values", () => {
  const exportProject = {
    ...project,
    units: [{
      ...project.units[0],
      note: "戶別備註",
      works: [{ date: "2026-05-01", area: 12 }],
      acceptances: [{ id: "a-zero", date: "2026-05-02", area: 0, note: "", draft: false }],
    }],
  };
  const [record] = buildAcceptanceExportRecords(exportProject);
  assert.equal(record.areaPing, 0);
  assert.equal(record.areaSquareMeters, 0);
  assert.equal(record.amount, 0);
  assert.equal(record.note, "");
});

test("shipment report metadata is shared by the export record and preserves arbitrary text", () => {
  const report = {
    shipmentDateText: "日期待確認", sequenceText: "A-01", customerNameText: "客戶另註",
    productText: "商品待確認", unitDisplayText: "戶別另註", squareMetersText: "面積待確認",
    pingText: "坪數另註", unitPriceText: "單價待確認", amountText: "金額另註",
    vendorText: "廠商待確認", purchasePriceText: "進價另註", noteText: "備註另註",
    signedOriginal: true, signedCopy: false, incomingVoOriginal: "進件正本待補", incomingVoCopy: "影本已收",
    outgoingVoOriginal: "銷項正本", outgoingVoCopy: "銷項影本", submitted: "王小姐確認中",
    vendorInvoice: "未送", tier: "特殊級距", payable: "待會計確認", profitPercent: "依合約", profit: "月底結算",
  };
  const exportProject = { ...project, units: [{ ...project.units[0], acceptances: [{ ...project.units[0].acceptances[0], report }] }] };
  const [record] = buildAcceptanceExportRecords(exportProject);
  assert.deepEqual(Object.fromEntries(Object.keys(report).map((key) => [key, record[key as keyof typeof record]])), report);
  const workbook = createShipmentWorkbook(exportProject, [record], "2026-05") as { Sheets: Record<string, any> };
  const sheet = workbook.Sheets["已出貨明細總表"];
  assert.equal(sheet.A3.v, "日期待確認");
  assert.equal(sheet.B3.v, "A-01");
  assert.equal(sheet.C3.v, "客戶另註");
  assert.equal(sheet.D3.v, "商品待確認");
  assert.equal(sheet.E3.v, "戶別另註");
  assert.equal(sheet.F3.v, "面積待確認");
  assert.equal(sheet.G3.v, "坪數另註");
  assert.equal(sheet.H3.v, "單價待確認");
  assert.equal(sheet.I3.v, "金額另註");
  assert.equal(sheet.J3.v, "廠商待確認");
  assert.equal(sheet.K3.v, "進價另註");
  assert.equal(sheet.L3.v, "備註另註");
  for (const cell of ["A3", "F3", "G3", "H3", "I3", "K3"]) assert.equal(sheet[cell].f, undefined);
  assert.equal(sheet.M3.v, "✓");
  assert.equal(sheet.N3.v, "");
  assert.equal(sheet.O3.v, "進件正本待補");
  assert.equal(sheet.P3.v, "影本已收");
  assert.equal(sheet.Q3.v, "銷項正本");
  assert.equal(sheet.R3.v, "銷項影本");
  assert.equal(sheet.S3.v, "王小姐確認中");
  assert.equal(sheet.T3.v, "未送");
  assert.equal(sheet.U3.v, "特殊級距");
  assert.equal(sheet.V3.v, "待會計確認");
  assert.equal(sheet.W3.v, "依合約");
  assert.equal(sheet.X3.v, "月底結算");
  assert.equal(sheet.S3.s.alignment.wrapText, true);
  assert.equal(sheet.S3.s.alignment.vertical, "center");
});

test("explicit blank shipment overrides stay blank instead of falling back to formulas", () => {
  const acceptance = { ...project.units[0].acceptances[0], report: { shipmentDateText: "", sequenceText: "", squareMetersText: "", pingText: "", unitPriceText: "", amountText: "" } };
  const exportProject = { ...project, units: [{ ...project.units[0], acceptances: [acceptance] }] };
  const [record] = buildAcceptanceExportRecords(exportProject);
  const workbook = createShipmentWorkbook(exportProject, [record], "2026-05") as { Sheets: Record<string, any> };
  const sheet = workbook.Sheets["已出貨明細總表"];
  for (const cell of ["A3", "B3", "F3", "G3", "H3", "I3"]) {
    assert.equal(sheet[cell].v, "");
    assert.equal(sheet[cell].f, undefined);
  }
});

test("shipment detail row height grows conservatively for long printable text", () => {
  const source = buildAcceptanceExportRecords(project)[0];
  const records = [
    source,
    { ...source, unitId: "long", customerNameText: "很長的客戶名稱與人工補充說明".repeat(5), submitted: "王小姐確認中，等待工地與會計完成最後核對後再正式送單".repeat(4), payable: "待會計確認".repeat(6) },
  ];
  const workbook = createShipmentWorkbook(project, records, "2026-05") as { Sheets: Record<string, { "!rows": Array<{ hpt: number }> }> };
  const rows = workbook.Sheets["已出貨明細總表"]["!rows"];
  assert.ok(rows[3].hpt > rows[2].hpt);
  assert.ok(rows[3].hpt > 34);
});
