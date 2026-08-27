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
};

export type ExportUnit = {
  id: string;
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
  acceptances?: Array<{ id?: string; date?: string; startedAt?: string; area?: number; note?: string; draft?: boolean }>;
};

export type ExportProject = { name?: string; address?: string; contact?: string; units?: ExportUnit[] };
export type ExportAcceptance = NonNullable<ExportUnit["acceptances"]>[number];

export function buildAcceptanceExportRecord(project: ExportProject, unit: ExportUnit, acceptance?: ExportAcceptance, useAcceptanceDate = false): AcceptanceExportRecord {
  const workArea = (unit.works || []).reduce((sum, work) => sum + Number(work.area || 0), 0);
  const areaPing = Number(acceptance?.area || workArea || unit.estimated || 0);
  const workDate = (unit.works || []).map((work) => work.date || "").filter(Boolean).sort().at(-1) || "";
  const acceptanceDate = acceptance?.date || "";
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
    note: acceptance?.note || unit.note || "",
  };
}

export function buildAcceptanceExportRecords(project: ExportProject, currentUnit?: ExportUnit, currentAcceptance?: { id?: string; date?: string; startedAt?: string; area?: number; note?: string; draft?: boolean }): AcceptanceExportRecord[] {
  const units = (project.units || []).map((unit) => unit.id === currentUnit?.id ? { ...unit, acceptances: currentAcceptance ? [currentAcceptance, ...(unit.acceptances || []).filter((item) => item.id !== currentAcceptance.id)] : unit.acceptances } : unit);
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

export function createReceivableWorkbook(project: ExportProject, records: AcceptanceExportRecord[], month: string) {
  const detailStart = 7;
  const detailCount = Math.max(records.length, 10);
  const detailEnd = detailStart + detailCount - 1;
  const summaryTitle = detailEnd + 2;
  const summarySubtitle = summaryTitle + 1;
  const subtotalRow = summarySubtitle + 1;
  const taxRow = subtotalRow + 1;
  const receivableRow = taxRow + 1;
  const invoiceRow = receivableRow + 1;
  const approvalRow = invoiceRow + 2;
  const datesRow = approvalRow + 1;
  const bankLabelRow = datesRow + 2;
  const bankAccountRow = bankLabelRow + 1;
  const contactRow = bankAccountRow + 1;
  const addressRow = contactRow + 1;
  const generatedDate = new Date();
  const generatedDateText = `${generatedDate.getFullYear() - 1911}.${String(generatedDate.getMonth() + 1).padStart(2, "0")}.${String(generatedDate.getDate()).padStart(2, "0")}`;
  const rows: unknown[][] = [
    ["SPC", "", "", "", "", ""],
    [`${companyReportConfig.companyName} 應收帳款明細表`, "", "", "", "", ""],
    ["送貨連絡人：", project.contact || "", "", "", "", ""],
    ["送貨地址：", project.address || "", "", "", "", ""],
    ["", "", "", "", "", ""],
    ["日期", "型號", "尺寸cm", "數量", "單價／元", "合計"],
  ];
  for (let index = 0; index < detailCount; index += 1) {
    const row = detailStart + index;
    const record = records[index];
    rows.push([
      record ? rocDate(record.exportDate) : "",
      record?.model || "",
      "",
      "",
      record && record.unitPrice > 0 ? record.unitPrice : "",
      { f: `IF(OR(D${row}=\"\",E${row}=\"\"),0,D${row}*E${row})`, v: 0, t: "n" },
    ]);
  }
  rows.push(
    ["", "", "", "", "", ""],
    ["SPC", "", "", "", "", ""],
    [`${companyReportConfig.companyName} 應收帳款明細表`, "", "", "", "", ""],
    ["銷貨小計", "", "", "", "", { f: `SUM(F${detailStart}:F${detailEnd})`, v: 0, t: "n" }],
    [`稅金（${companyReportConfig.receivableTaxRate * 100}%）`, "", "", "", "", { f: `ROUND(F${subtotalRow}*${companyReportConfig.receivableTaxRate * 100}%,0)`, v: 0, t: "n" }],
    ["應收合計", "", "", "", "", { f: `F${subtotalRow}+F${taxRow}`, v: 0, t: "n" }],
    ["發票字軌", "", "", "", "", ""],
    ["", "", "", "", "", ""],
    ["主管：", "", "審核：", "", "製表：", ""],
    [`製表日期：${generatedDateText}`, "", "送單日期：", "", `負責窗口：${project.contact || ""}`, ""],
    ["", "", "", "", "", ""],
    ["匯款帳號如下：", "", "", "", "", ""],
    [companyReportConfig.bankAccount, "", "", "", "", ""],
    [`聯絡人:${companyReportConfig.contactPerson} ${companyReportConfig.mobile} 電話: ${companyReportConfig.phone}`, "", "", "", "", ""],
    [`傳真: ${companyReportConfig.fax} 地址: ${companyReportConfig.address}`, "", "", "", "", ""],
  );

  const worksheet = XLSXStyle.utils.aoa_to_sheet(rows);
  const merges = [
    `A1:F1`, `A2:F2`, `B3:F3`, `B4:F4`,
    `A${summaryTitle}:F${summaryTitle}`, `A${summarySubtitle}:F${summarySubtitle}`,
    `A${subtotalRow}:E${subtotalRow}`, `A${taxRow}:E${taxRow}`, `A${receivableRow}:E${receivableRow}`, `A${invoiceRow}:E${invoiceRow}`,
    `A${approvalRow}:B${approvalRow}`, `C${approvalRow}:D${approvalRow}`, `E${approvalRow}:F${approvalRow}`,
    `A${datesRow}:B${datesRow}`, `C${datesRow}:D${datesRow}`, `E${datesRow}:F${datesRow}`,
    `A${bankLabelRow}:F${bankLabelRow}`, `A${bankAccountRow}:F${bankAccountRow}`, `A${contactRow}:F${contactRow}`, `A${addressRow}:F${addressRow}`,
  ];
  worksheet["!merges"] = merges.map((range) => XLSXStyle.utils.decode_range(range));
  worksheet["!cols"] = [13, 28, 14, 13, 15, 17].map((wch) => ({ wch }));
  const fixedCompanyRows = new Set([bankLabelRow, bankAccountRow, contactRow, addressRow]);
  worksheet["!rows"] = rows.map((_, index) => {
    const sheetRow = index + 1;
    return { hpt: fixedCompanyRows.has(sheetRow) ? 32 : index === 0 ? 30 : index === 1 || index === summarySubtitle - 1 ? 26 : index === 5 ? 28 : 23 };
  });
  worksheet["!margins"] = { left: 0.35, right: 0.35, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 };
  worksheet["!pageSetup"] = { orientation: "portrait", fitToWidth: 1, fitToHeight: 1, paperSize: 9, horizontalCentered: true };
  worksheet["!printArea"] = `A1:F${addressRow}`;
  worksheet["!freeze"] = { xSplit: 0, ySplit: 6, topLeftCell: "A7", activePane: "bottomLeft", state: "frozen" };

  for (let row = 0; row < rows.length; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      const address = XLSXStyle.utils.encode_cell({ r: row, c: col });
      const cell = worksheet[address] || (worksheet[address] = { t: "s", v: "" });
      const sheetRow = row + 1;
      const inDetail = sheetRow >= 6 && sheetRow <= detailEnd;
      const inSummary = sheetRow >= summaryTitle && sheetRow <= invoiceRow;
      cell.s = {
        font: { name: "Microsoft JhengHei", sz: sheetRow === 1 ? 20 : sheetRow === 2 || sheetRow === summarySubtitle ? 16 : 11, bold: sheetRow <= 2 || sheetRow === 6 || sheetRow === summaryTitle || sheetRow === summarySubtitle || (sheetRow >= subtotalRow && sheetRow <= invoiceRow) },
        alignment: { horizontal: sheetRow <= 2 || sheetRow === summaryTitle || sheetRow === summarySubtitle || sheetRow === 6 || inDetail ? "center" : "left", vertical: "center", wrapText: true },
        border: inDetail || inSummary ? excelBorder : undefined,
        fill: sheetRow === 6 ? { fgColor: { rgb: "FFF2CC" } } : sheetRow === receivableRow ? { fgColor: { rgb: "FFF200" } } : { fgColor: { rgb: "FFFFFF" } },
      };
      if (sheetRow >= detailStart && sheetRow <= detailEnd && col === 4) cell.z = '#,##0.0"元"';
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

export function createShipmentWorkbook(project: ExportProject, records: AcceptanceExportRecord[], month: string) {
  const headers = ["出貨日期", "序號", "客戶名稱", "商品", "戶別", "m²", "片／件\n*0.3025", "單價／元", "合計", "廠商", "進價／元", "備註", "簽單正", "簽單影", "進VO正", "進VO影", "銷VO正", "銷VO影", "送單", "廠商帳單", "級距", "應付", "利潤%", "利潤"];
  const dataStart = 4;
  const excelDate = (value: string) => {
    const [year, monthValue, date] = value.split("-").map(Number);
    return year && monthValue && date ? new Date(year, monthValue - 1, date) : "";
  };
  const rows: unknown[][] = [
    [`${month.replace("-", "年")}月SPC已出貨明細總表`, ...Array(headers.length - 1).fill("")],
    ["工地下訂\n數量", "", project.name || "", records[0] ? `${records[0].model}${records[0].colorNo}` : "", "", "", "", "", "", records[0]?.vendor || "", "", ...Array(headers.length - 11).fill("")],
    headers,
    ...records.map((record, index) => {
      const row = dataStart + index;
      return [
        excelDate(record.exportDate), index + 1, `${record.projectName}\nSPC連工帶料`,
        [record.model, record.colorNo].filter(Boolean).join(" "), record.unitDisplay,
        record.areaSquareMeters,
        { f: `ROUND(F${row}*0.3025,2)`, v: record.areaPing, t: "n" },
        record.unitPrice > 0 ? record.unitPrice : "",
        { f: `IF(OR(G${row}=\"\",H${row}=\"\"),\"\",ROUND(G${row}*H${row},0))`, v: record.unitPrice > 0 ? record.amount : undefined, t: "n" },
        record.vendor, "", record.note, ...Array(12).fill(""),
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
  worksheet["!cols"] = [10, 6, 18, 20, 12, 10, 13, 12, 13, 11, 12, 16, 9, 9, 9, 9, 9, 9, 9, 11, 9, 12, 10, 12].map((wch) => ({ wch }));
  worksheet["!rows"] = [{ hpt: 24 }, { hpt: 34 }, { hpt: 42 }, ...records.map(() => ({ hpt: 34 })), { hpt: 24 }];
  worksheet["!freeze"] = { xSplit: 0, ySplit: 3, topLeftCell: "A4", activePane: "bottomLeft", state: "frozen" };
  worksheet["!autofilter"] = { ref: `A3:X${Math.max(3, totalRow - 1)}` };
  worksheet["!margins"] = { left: 0.2, right: 0.2, top: 0.3, bottom: 0.3, header: 0.1, footer: 0.1 };
  worksheet["!pageSetup"] = { orientation: "landscape", fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  worksheet["!printHeader"] = "1:3";
  const range = XLSXStyle.utils.decode_range(worksheet["!ref"] || "A1:X4");
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const address = XLSXStyle.utils.encode_cell({ r: row, c: col });
      const target = worksheet[address] || (worksheet[address] = { t: "s", v: "" });
      target.s = { font: { name: "Microsoft JhengHei", sz: row === 0 ? 16 : 10, bold: row === 0 || row === 2 || row === totalRow - 1 }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: excelBorder, fill: row === 0 ? { fgColor: { rgb: "11DDE0" } } : row === 2 ? { fgColor: { rgb: "FFF2CC" } } : row === totalRow - 1 ? { fgColor: { rgb: "FFF200" } } : { fgColor: { rgb: "FFFFFF" } } };
      if (row >= dataStart - 1 && (col === 5 || col === 6)) target.z = col === 6 ? '0.00" 坪"' : "0.00";
      if (row >= dataStart - 1 && (col === 7 || col === 10 || col === 21 || col === 23)) target.z = '#,##0.0"元"';
      if (row >= dataStart - 1 && col === 8) target.z = "#,##0";
      if (row >= dataStart - 1 && col === 22) target.z = "0.00%";
      if (col === 0 && row >= dataStart - 1 && row < totalRow - 1) target.z = "mm/dd";
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
