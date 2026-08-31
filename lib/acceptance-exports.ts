import XLSXStyle from "xlsx-js-style";
import { getLatestFinalAcceptance } from "./acceptance-records.ts";
import { companyReportConfig } from "./company-report-config.ts";

export type AcceptanceExportRecord = {
  projectName: string;
  address: string;
  contact: string;
  unitId: string;
  unitDisplay: string;
  model: string;
  colorNo: string;
  vendor: string;
  workDate: string;
  acceptanceDate: string;
  exportDate: string;
  areaPing: number;
  areaSquareMeters: number;
  unitPrice: number;
  amount: number;
  note: string;
  shipmentDateText?: string;
  sequenceText?: string;
  customerNameText?: string;
  productText?: string;
  unitDisplayText?: string;
  squareMetersText?: string;
  pingText?: string;
  unitPriceText?: string;
  amountText?: string;
  vendorText?: string;
  purchasePriceText?: string;
  noteText?: string;
  signedOriginal: boolean;
  signedCopy: boolean;
  incomingVoOriginal: string;
  incomingVoCopy: string;
  outgoingVoOriginal: string;
  outgoingVoCopy: string;
  submitted: string;
  vendorInvoice: string;
  tier: string;
  payable: string;
  profitPercent: string;
  profit: string;
};

export type AcceptanceReportMetadata = {
  shipmentDateText?: string;
  sequenceText?: string;
  customerNameText?: string;
  productText?: string;
  unitDisplayText?: string;
  squareMetersText?: string;
  pingText?: string;
  unitPriceText?: string;
  amountText?: string;
  vendorText?: string;
  purchasePriceText?: string;
  noteText?: string;
  signedOriginal?: boolean;
  signedCopy?: boolean;
  incomingVoOriginal?: string;
  incomingVoCopy?: string;
  outgoingVoOriginal?: string;
  outgoingVoCopy?: string;
  submitted?: string;
  vendorInvoice?: string;
  tier?: string;
  payable?: string;
  profitPercent?: string;
  profit?: string;
};

export type ExportUnit = {
  id: string;
  _deleted?: boolean;
  building?: string;
  floor?: string;
  number?: string;
  model?: string;
  colorNo?: string;
  brand?: string;
  estimated?: number;
  rate?: number;
  note?: string;
  works?: Array<{ date?: string; area?: number }>;
  acceptances?: Array<{ id?: string; date?: string; startedAt?: string; area?: number; note?: string; draft?: boolean; report?: AcceptanceReportMetadata }>;
};

export type ExportProject = { name?: string; address?: string; contact?: string; units?: ExportUnit[] };
export type ExportAcceptance = NonNullable<ExportUnit["acceptances"]>[number];

export function buildAcceptanceExportRecord(project: ExportProject, unit: ExportUnit, acceptance?: ExportAcceptance, useAcceptanceDate = false): AcceptanceExportRecord {
  const workArea = (unit.works || []).reduce((sum, work) => sum + Number(work.area || 0), 0);
  const areaPing = Number(acceptance?.area ?? (workArea || unit.estimated || 0));
  const workDate = (unit.works || []).map((work) => work.date || "").filter(Boolean).sort().at(-1) || "";
  const acceptanceDate = acceptance?.date || "";
  const report = acceptance?.report;
  return {
    projectName: project.name || "",
    address: project.address || "",
    contact: project.contact || "",
    unitId: unit.id,
    unitDisplay: [unit.building, unit.floor, unit.number].filter(Boolean).join(" "),
    model: unit.model || "",
    colorNo: unit.colorNo || "",
    vendor: unit.brand || "",
    workDate,
    acceptanceDate,
    exportDate: useAcceptanceDate ? acceptanceDate : workDate || acceptanceDate,
    areaPing,
    areaSquareMeters: Number((areaPing * 3.305785).toFixed(2)),
    unitPrice: Number(unit.rate || 0),
    amount: Number((areaPing * Number(unit.rate || 0)).toFixed(0)),
    note: acceptance?.note ?? unit.note ?? "",
    shipmentDateText: report?.shipmentDateText,
    sequenceText: report?.sequenceText,
    customerNameText: report?.customerNameText,
    productText: report?.productText,
    unitDisplayText: report?.unitDisplayText,
    squareMetersText: report?.squareMetersText,
    pingText: report?.pingText,
    unitPriceText: report?.unitPriceText,
    amountText: report?.amountText,
    vendorText: report?.vendorText,
    purchasePriceText: report?.purchasePriceText,
    noteText: report?.noteText,
    signedOriginal: report?.signedOriginal === true,
    signedCopy: report?.signedCopy === true,
    incomingVoOriginal: report?.incomingVoOriginal || "",
    incomingVoCopy: report?.incomingVoCopy || "",
    outgoingVoOriginal: report?.outgoingVoOriginal || "",
    outgoingVoCopy: report?.outgoingVoCopy || "",
    submitted: report?.submitted || "",
    vendorInvoice: report?.vendorInvoice || "",
    tier: report?.tier || "",
    payable: report?.payable || "",
    profitPercent: report?.profitPercent || "",
    profit: report?.profit || "",
  };
}

export function buildAcceptanceExportRecords(project: ExportProject, currentUnit?: ExportUnit, currentAcceptance?: ExportAcceptance): AcceptanceExportRecord[] {
  const units = (project.units || []).filter((unit) => unit._deleted !== true).map((unit) => unit.id === currentUnit?.id ? { ...unit, acceptances: currentAcceptance ? [currentAcceptance, ...(unit.acceptances || []).filter((item) => item.id !== currentAcceptance.id)] : unit.acceptances } : unit);
  return units.flatMap((unit) => {
    const acceptance = getLatestFinalAcceptance(unit);
    if (!acceptance && !(unit.works || []).length && unit.id !== currentUnit?.id) return [];
    const record = buildAcceptanceExportRecord(project, unit, acceptance);
    if (!acceptance && currentAcceptance?.date) {
      record.acceptanceDate = currentAcceptance.date;
      record.exportDate = record.workDate || currentAcceptance.date;
    }
    return [record];
  }).sort((a, b) => a.exportDate.localeCompare(b.exportDate) || a.unitDisplay.localeCompare(b.unitDisplay));
}

const thin = { style: "thin", color: { rgb: "000000" } };
const excelBorder = { top: thin, bottom: thin, left: thin, right: thin };

const rocDate = (value: string) => {
  const [year, month, date] = value.split("-").map(Number);
  return year && month && date
    ? `${year - 1911}.${String(month).padStart(2, "0")}.${String(date).padStart(2, "0")}`
    : "";
};

export type ReceivableDetailDraft = {
  date: string;
  model: string;
  sizeCm: string;
  quantity: string;
  unitPrice: string;
  note: string;
};

export type ReceivableExportDraft = {
  details: ReceivableDetailDraft[];
  deliveryContact: string;
  deliveryAddress: string;
  invoiceTrack: string;
  invoiceDate: string;
  receivedAmount: string;
  receivedDate: string;
  preparedBy: string;
  paymentMethod: string;
  deliveryDate: string;
  handler: string;
  supervisor: string;
  accounting: string;
};

export function buildReceivableExportDraft(project: ExportProject, records: AcceptanceExportRecord[]): ReceivableExportDraft {
  return {
    details: records.map((record) => ({
      date: rocDate(record.exportDate),
      model: record.model,
      sizeCm: "",
      quantity: "",
      unitPrice: record.unitPrice > 0 ? String(record.unitPrice) : "",
      note: record.noteText ?? record.note,
    })),
    deliveryContact: project.contact || "",
    deliveryAddress: project.address || "",
    invoiceTrack: "",
    invoiceDate: "",
    receivedAmount: "",
    receivedDate: "",
    preparedBy: "",
    paymentMethod: "",
    deliveryDate: "",
    handler: project.contact || "",
    supervisor: "",
    accounting: "",
  };
}

const receivableNumber = (value: string) => {
  if (!value.trim()) return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "";
};

export function receivableDraftTotals(draft: ReceivableExportDraft) {
  const subtotal = draft.details.reduce((sum, detail) => sum + Number(receivableNumber(detail.quantity) || 0) * Number(receivableNumber(detail.unitPrice) || 0), 0);
  const tax = Math.round(subtotal * companyReportConfig.receivableTaxRate);
  return { subtotal, tax, receivable: subtotal - tax };
}

export function createReceivableWorkbook(project: ExportProject, records: AcceptanceExportRecord[], month: string, draft = buildReceivableExportDraft(project, records)) {
  const detailStart = 7;
  const detailCount = records.length;
  const detailEnd = detailStart + detailCount - 1;
  const summaryTitle = detailEnd + 2;
  const summarySubtitle = summaryTitle + 1;
  const subtotalRow = summarySubtitle + 1;
  const taxRow = subtotalRow + 1;
  const receivableRow = taxRow + 1;
  const invoiceRow = receivableRow + 1;
  const receiptRow = invoiceRow + 1;
  const businessRow = receiptRow + 1;
  const approvalRow = businessRow + 1;
  const bankLabelRow = approvalRow + 2;
  const bankAccountRow = bankLabelRow + 1;
  const contactRow = bankAccountRow + 1;
  const addressRow = contactRow + 1;
  const rows: unknown[][] = [
    [`${project.name || ""} SPC`, "", "", "", "", "", ""],
    [`${companyReportConfig.companyName} 應收帳款明細表`, "", "", "", "", "", ""],
    ["送貨聯絡人：", draft.deliveryContact, "", "", "", "", ""],
    ["送貨地址：", draft.deliveryAddress, "", "", "", "", ""],
    ["", "", "", "", "", "", ""],
    ["日期", "型號", "尺寸cm", "數量(坪)", "單價／元", "合計", "備註"],
  ];
  for (let index = 0; index < detailCount; index += 1) {
    const row = detailStart + index;
    const detail = draft.details[index] || buildReceivableExportDraft(project, [records[index]]).details[0];
    rows.push([
      detail.date,
      detail.model,
      detail.sizeCm,
      receivableNumber(detail.quantity),
      receivableNumber(detail.unitPrice),
      { f: `IF(OR(D${row}=\"\",E${row}=\"\"),0,D${row}*E${row})`, v: 0, t: "n" },
      detail.note,
    ]);
  }
  rows.push(
    ["", "", "", "", "", "", ""],
    ["SPC", "", "", "", "", "", ""],
    [`${companyReportConfig.companyName} 應收帳款明細表`, "", "", "", "", "", ""],
    ["銷貨小計", "", "", "", "", { f: detailCount ? `SUM(F${detailStart}:F${detailEnd})` : "0", v: 0, t: "n" }, ""],
    [`稅金（${companyReportConfig.receivableTaxRate * 100}%）`, "", "", "", "", { f: `ROUND(F${subtotalRow}*${companyReportConfig.receivableTaxRate * 100}%,0)`, v: 0, t: "n" }, ""],
    ["應收合計", "", "", "", "", { f: `F${subtotalRow}-F${taxRow}`, v: 0, t: "n" }, ""],
    [`發票字軌：${draft.invoiceTrack}`, "", `發票日期：${draft.invoiceDate}`, "", "", "", ""],
    [`已收款金額：${draft.receivedAmount}`, "", `收款日期：${draft.receivedDate}`, "", `製表：${draft.preparedBy}`, "", ""],
    [`支付方式：${draft.paymentMethod}`, "", `送單日期：${draft.deliveryDate}`, "", `承辦人：${draft.handler}`, "", ""],
    [`主管：${draft.supervisor}`, "", `會計：${draft.accounting}`, "", "客戶簽名：", "", ""],
    ["", "", "", "", "", "", ""],
    ["匯款帳號如下：", "", "", "", "", "", ""],
    [companyReportConfig.bankAccount, "", "", "", "", "", ""],
    [`聯絡人:${companyReportConfig.contactPerson} ${companyReportConfig.mobile} 電話: ${companyReportConfig.phone}`, "", "", "", "", "", ""],
    [`傳真: ${companyReportConfig.fax} 地址: ${companyReportConfig.address}`, "", "", "", "", "", ""],
  );

  const worksheet = XLSXStyle.utils.aoa_to_sheet(rows);
  const merges = [
    `A1:G1`, `A2:G2`, `B3:G3`, `B4:G4`,
    `A${summaryTitle}:G${summaryTitle}`, `A${summarySubtitle}:G${summarySubtitle}`,
    `A${subtotalRow}:E${subtotalRow}`, `F${subtotalRow}:G${subtotalRow}`, `A${taxRow}:E${taxRow}`, `F${taxRow}:G${taxRow}`, `A${receivableRow}:E${receivableRow}`, `F${receivableRow}:G${receivableRow}`,
    `A${invoiceRow}:B${invoiceRow}`, `C${invoiceRow}:D${invoiceRow}`, `E${invoiceRow}:G${invoiceRow}`,
    `A${receiptRow}:B${receiptRow}`, `C${receiptRow}:D${receiptRow}`, `E${receiptRow}:G${receiptRow}`,
    `A${businessRow}:B${businessRow}`, `C${businessRow}:D${businessRow}`, `E${businessRow}:G${businessRow}`,
    `A${approvalRow}:B${approvalRow}`, `C${approvalRow}:D${approvalRow}`, `E${approvalRow}:G${approvalRow}`,
    `A${bankLabelRow}:G${bankLabelRow}`, `A${bankAccountRow}:G${bankAccountRow}`, `A${contactRow}:G${contactRow}`, `A${addressRow}:G${addressRow}`,
  ];
  worksheet["!merges"] = merges.map((range) => XLSXStyle.utils.decode_range(range));
  worksheet["!cols"] = [13, 18, 14, 13, 15, 17, 28].map((wch) => ({ wch }));
  const fixedCompanyRows = new Set([bankLabelRow, bankAccountRow, contactRow, addressRow]);
  worksheet["!rows"] = rows.map((_, index) => {
    const sheetRow = index + 1;
    return { hpt: fixedCompanyRows.has(sheetRow) ? 32 : index === 0 ? 30 : index === 1 || index === summarySubtitle - 1 ? 26 : index === 5 ? 28 : 23 };
  });
  worksheet["!margins"] = { left: 0.35, right: 0.35, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 };
  worksheet["!pageSetup"] = { orientation: "portrait", fitToWidth: 1, fitToHeight: 0, paperSize: 9, horizontalCentered: true };
  worksheet["!printArea"] = `A1:G${addressRow}`;
  worksheet["!freeze"] = { xSplit: 0, ySplit: 6, topLeftCell: "A7", activePane: "bottomLeft", state: "frozen" };

  for (let row = 0; row < rows.length; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      const address = XLSXStyle.utils.encode_cell({ r: row, c: col });
      const cell = worksheet[address] || (worksheet[address] = { t: "s", v: "" });
      const sheetRow = row + 1;
      const inDetail = sheetRow >= 6 && sheetRow <= detailEnd;
      const inSummary = sheetRow >= summaryTitle && sheetRow <= approvalRow;
      cell.s = {
        font: { name: "Microsoft JhengHei", sz: sheetRow === 1 ? 20 : sheetRow === 2 || sheetRow === summarySubtitle ? 16 : 11, bold: sheetRow <= 2 || sheetRow === 6 || sheetRow === summaryTitle || sheetRow === summarySubtitle || (sheetRow >= subtotalRow && sheetRow <= invoiceRow) },
        alignment: { horizontal: sheetRow <= 2 || sheetRow === summaryTitle || sheetRow === summarySubtitle || sheetRow === 6 || inDetail ? "center" : "left", vertical: "center", wrapText: true },
        border: inDetail || inSummary ? excelBorder : undefined,
        fill: sheetRow === 6 ? { fgColor: { rgb: "FFF2CC" } } : sheetRow === receivableRow ? { fgColor: { rgb: "FFF200" } } : { fgColor: { rgb: "FFFFFF" } },
      };
      if (sheetRow >= detailStart && sheetRow <= detailEnd && col === 4) cell.z = '#,##0.0"元"';
      if (sheetRow >= detailStart && sheetRow <= detailEnd && col === 3) cell.z = "0.00";
      if ((sheetRow >= detailStart && sheetRow <= detailEnd && col === 5) || (sheetRow >= subtotalRow && sheetRow <= receivableRow && col === 5)) cell.z = "#,##0";
    }
  }
  const workbook = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(workbook, worksheet, "應收帳款明細表");
  workbook.Workbook = { CalcPr: { calcMode: "auto", fullCalcOnLoad: true, forceFullCalc: true } };
  workbook.Props = { Title: `${month} SPC應收帳款明細表`, Subject: project.name || "SPC工程", Author: companyReportConfig.companyName };
  return workbook;
}

export function saveReceivableWorkbook(workbook: ReturnType<typeof createReceivableWorkbook>, filename: string) {
  XLSXStyle.writeFile(workbook, filename.replace(/[\\/:*?"<>|]/g, "_"), { bookType: "xlsx", compression: true });
}

export function shipmentDisplayValues(record: AcceptanceExportRecord, index: number) {
  return {
    shipmentDateText: record.shipmentDateText ?? record.exportDate,
    sequenceText: record.sequenceText ?? String(index + 1),
    customerNameText: record.customerNameText ?? record.projectName,
    productText: record.productText ?? [record.model, record.colorNo].filter(Boolean).join(" "),
    unitDisplayText: record.unitDisplayText ?? record.unitDisplay,
    squareMetersText: record.squareMetersText ?? record.areaSquareMeters.toFixed(2),
    pingText: record.pingText ?? record.areaPing.toFixed(2),
    unitPriceText: record.unitPriceText ?? (record.unitPrice > 0 ? String(record.unitPrice) : ""),
    amountText: record.amountText ?? (record.unitPrice > 0 ? String(record.amount) : ""),
    vendorText: record.vendorText ?? record.vendor,
    purchasePriceText: record.purchasePriceText ?? "",
    noteText: record.noteText ?? record.note,
    signedOriginal: record.signedOriginal,
    signedCopy: record.signedCopy,
    incomingVoOriginal: record.incomingVoOriginal,
    incomingVoCopy: record.incomingVoCopy,
    outgoingVoOriginal: record.outgoingVoOriginal,
    outgoingVoCopy: record.outgoingVoCopy,
    submitted: record.submitted,
    vendorInvoice: record.vendorInvoice,
    tier: record.tier,
    payable: record.payable,
    profitPercent: record.profitPercent,
    profit: record.profit,
  };
}

export function createShipmentWorkbook(project: ExportProject, records: AcceptanceExportRecord[], month: string) {
  const headers = ["出貨日期", "序號", "客戶名稱", "商品", "戶別", "m²", "片／件\n*0.3025", "單價／元", "合計", "廠商", "進價／元", "備註", "簽單正", "簽單影", "進VO正", "進VO影", "銷VO正", "銷VO影", "送單", "廠商帳單", "級距", "應付", "利潤%", "利潤"];
  const dataStart = 3;
  const excelDate = (value: string) => {
    const [year, monthValue, date] = value.split("-").map(Number);
    return year && monthValue && date ? new Date(year, monthValue - 1, date) : "";
  };
  const rows: unknown[][] = [
    [`${month.replace("-", "年")}月SPC已出貨明細總表`, ...Array(headers.length - 1).fill("")],
    headers,
    ...records.map((record, index) => {
      const row = dataStart + index;
      const display = shipmentDisplayValues(record, index);
      return [
        record.shipmentDateText !== undefined ? display.shipmentDateText : excelDate(record.exportDate),
        record.sequenceText !== undefined ? display.sequenceText : index + 1,
        display.customerNameText,
        display.productText,
        display.unitDisplayText,
        record.squareMetersText !== undefined ? display.squareMetersText : record.areaSquareMeters,
        record.pingText !== undefined ? display.pingText : { f: `ROUND(F${row}*0.3025,2)`, v: record.areaPing, t: "n" },
        record.unitPriceText !== undefined ? display.unitPriceText : record.unitPrice > 0 ? record.unitPrice : "",
        record.amountText !== undefined ? display.amountText : { f: `IF(OR(G${row}=\"\",H${row}=\"\"),\"\",ROUND(G${row}*H${row},0))`, v: record.unitPrice > 0 ? record.amount : undefined, t: "n" },
        display.vendorText, display.purchasePriceText, display.noteText,
        record.signedOriginal ? "✓" : "",
        record.signedCopy ? "✓" : "",
        record.incomingVoOriginal,
        record.incomingVoCopy,
        record.outgoingVoOriginal,
        record.outgoingVoCopy,
        record.submitted,
        record.vendorInvoice,
        record.tier,
        record.payable,
        record.profitPercent,
        record.profit,
      ];
    }),
  ];
  const totalRow = dataStart + records.length;
  const total = Array<unknown>(headers.length).fill("");
  total[3] = "小計";
  total[5] = { f: `SUM(F${dataStart}:F${Math.max(dataStart, totalRow - 1)})` };
  total[6] = { f: `SUM(G${dataStart}:G${Math.max(dataStart, totalRow - 1)})` };
  total[8] = { f: `SUM(I${dataStart}:I${Math.max(dataStart, totalRow - 1)})` };
  rows.push(total);
  const worksheet = XLSXStyle.utils.aoa_to_sheet(rows);
  worksheet["!merges"] = [XLSXStyle.utils.decode_range("A1:X1")];
  worksheet["!cols"] = [10, 6, 18, 20, 12, 10, 13, 12, 13, 11, 12, 16, 5, 5, 9, 9, 9, 9, 9, 11, 9, 12, 10, 12].map((wch) => ({ wch }));
  const estimateShipmentRowHeight = (record: AcceptanceExportRecord) => {
    const display = shipmentDisplayValues(record, 0);
    const values: Array<[unknown, number]> = [
      [display.shipmentDateText, 10], [display.sequenceText, 6], [display.customerNameText, 18], [display.productText, 20],
      [display.unitDisplayText, 12], [display.squareMetersText, 10], [display.pingText, 13], [display.unitPriceText, 12],
      [display.amountText, 13], [display.vendorText, 11], [display.purchasePriceText, 12], [display.noteText, 16],
      [display.incomingVoOriginal, 9], [display.incomingVoCopy, 9], [display.outgoingVoOriginal, 9], [display.outgoingVoCopy, 9],
      [display.submitted, 9], [display.vendorInvoice, 11], [display.tier, 9], [display.payable, 12],
      [display.profitPercent, 10], [display.profit, 12],
    ];
    const lines = Math.max(1, ...values.map(([value, width]) => String(value ?? "").split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0)));
    return Math.max(34, 8 + lines * 18);
  };
  worksheet["!rows"] = [{ hpt: 24 }, { hpt: 42 }, ...records.map((record) => ({ hpt: estimateShipmentRowHeight(record) })), { hpt: 24 }];
  worksheet["!freeze"] = { xSplit: 0, ySplit: 2, topLeftCell: "A3", activePane: "bottomLeft", state: "frozen" };
  worksheet["!autofilter"] = { ref: `A2:X${Math.max(2, totalRow - 1)}` };
  worksheet["!margins"] = { left: 0.2, right: 0.2, top: 0.3, bottom: 0.3, header: 0.1, footer: 0.1 };
  worksheet["!pageSetup"] = { orientation: "landscape", fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  worksheet["!printHeader"] = "1:2";
  const range = XLSXStyle.utils.decode_range(worksheet["!ref"] || "A1:X3");
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const address = XLSXStyle.utils.encode_cell({ r: row, c: col });
      const target = worksheet[address] || (worksheet[address] = { t: "s", v: "" });
      const detailRecord = row >= dataStart - 1 && row < totalRow - 1 ? records[row - (dataStart - 1)] : undefined;
      target.s = { font: { name: "Microsoft JhengHei", sz: row === 0 ? 16 : 10, bold: row === 0 || row === 1 || row === totalRow - 1 }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: excelBorder, fill: row === 0 ? { fgColor: { rgb: "11DDE0" } } : row === 1 ? { fgColor: { rgb: "FFF2CC" } } : row === totalRow - 1 ? { fgColor: { rgb: "FFF200" } } : { fgColor: { rgb: "FFFFFF" } } };
      if (row === totalRow - 1 && (col === 5 || col === 6)) target.z = col === 6 ? '0.00" 坪"' : "0.00";
      if (detailRecord && col === 5 && detailRecord.squareMetersText === undefined) target.z = "0.00";
      if (detailRecord && col === 6 && detailRecord.pingText === undefined) target.z = '0.00" 坪"';
      if (detailRecord && col === 7 && detailRecord.unitPriceText === undefined) target.z = '#,##0.0"元"';
      if (detailRecord && col === 10 && detailRecord.purchasePriceText === undefined) target.z = '#,##0.0"元"';
      if (detailRecord && col === 8 && detailRecord.amountText === undefined) target.z = "#,##0";
      if (detailRecord && col === 0 && detailRecord.shipmentDateText === undefined) target.z = "mm/dd";
    }
  }
  const workbook = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(workbook, worksheet, "已出貨明細總表");
  workbook.Workbook = { CalcPr: { calcMode: "auto", fullCalcOnLoad: true, forceFullCalc: true } };
  workbook.Props = { Title: `${month} SPC已出貨明細總表`, Subject: project.name || "SPC工程", Author: "神銀建材" };
  return workbook;
}

export function saveShipmentWorkbook(workbook: ReturnType<typeof createShipmentWorkbook>, filename: string) {
  XLSXStyle.writeFile(workbook, filename, { bookType: "xlsx", compression: true });
}
