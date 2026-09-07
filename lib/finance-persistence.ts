import { threeWayMerge, isDeletedEntity } from "./three-way-merge.ts";
import type { AcceptanceReportMetadata } from "./acceptance-exports.ts";

export const updateReportSource = <T extends { acceptances: Array<{ id: string; report?: AcceptanceReportMetadata }> }>(unit: T, draft: AcceptanceReportMetadata & { unitId: string; acceptanceId: string }): T => ({
  ...unit,
  acceptances: unit.acceptances.map((acceptance) => acceptance.id === draft.acceptanceId
    ? { ...acceptance, report: {
        ...acceptance.report,
        shipmentDateText: draft.shipmentDateText, sequenceText: draft.sequenceText,
        customerNameText: draft.customerNameText, productText: draft.productText,
        unitDisplayText: draft.unitDisplayText, squareMetersText: draft.squareMetersText,
        pingText: draft.pingText, unitPriceText: draft.unitPriceText, amountText: draft.amountText,
        vendorText: draft.vendorText, purchasePriceText: draft.purchasePriceText, noteText: draft.noteText,
        signedOriginal: draft.signedOriginal, signedCopy: draft.signedCopy,
        incomingVoOriginal: draft.incomingVoOriginal, incomingVoCopy: draft.incomingVoCopy,
        outgoingVoOriginal: draft.outgoingVoOriginal, outgoingVoOriginalDate: draft.outgoingVoOriginalDate, outgoingVoCopy: draft.outgoingVoCopy,
        submitted: draft.submitted, vendorInvoice: draft.vendorInvoice, tier: draft.tier,
        payable: draft.payable, profitPercent: draft.profitPercent, profit: draft.profit,
      } }
    : acceptance),
});

export const financeSyncError = "尚未完成 Supabase 同步／請勿關閉頁面：雲端尚未確認本次修改";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

// Verify only intended changed fields; concurrent edits to unrelated fields are valid.
export function containsChanges(base: unknown, intended: unknown, committed: unknown): boolean {
  if (equal(base, intended)) return true;
  if (Array.isArray(intended) && intended.every((x) => record(x) && typeof x.id === "string")) {
    if (!Array.isArray(committed)) return false;
    return intended.every((item) => containsChanges(
      Array.isArray(base) ? base.find((x) => x.id === item.id) : undefined,
      item, committed.find((x) => x.id === item.id),
    ));
  }
  if (record(intended)) {
    if (!record(committed) || (committed._deleted === true && intended._deleted !== true)) return false;
    return [...new Set([...Object.keys(record(base) ? base : {}), ...Object.keys(intended)])]
      .every((key) => containsChanges(record(base) ? base[key] : undefined, intended[key], committed[key]));
  }
  return equal(intended, committed);
}

type FinanceProject = { id: string; receivableReports?: unknown; units: Array<{
  id: string; rate?: number; status?: string; pricedAt?: string;
  events?: Array<{ id: string; at?: string; title?: string; detail?: string }>;
  acceptances?: Array<{ id: string; report?: unknown }>;
}> };

// Photo URLs may be renewed by reload. They are not financial acknowledgement fields.
export function financeSnapshot(projects: FinanceProject[]) {
  return projects.map((p) => ({ id: p.id, _deleted: isDeletedEntity(p), receivableReports: p.receivableReports,
    units: p.units.map((u) => ({ id: u.id, _deleted: isDeletedEntity(u), rate: u.rate, status: u.status, pricedAt: u.pricedAt,
      events: u.events?.map(({ id, at, title, detail }) => ({ id, at, title, detail })),
      acceptances: u.acceptances?.map((a) => ({ id: a.id, _deleted: isDeletedEntity(a), report: a.report })),
    })),
  }));
}

export function canApplySharedReload(saving: boolean, current: unknown, baseline: unknown, pending = false) {
  return !saving && !pending && equal(current, baseline);
}

export function rebaseProjectEdit<T>(displayed: T, edited: T, latest: T): T {
  const merged = threeWayMerge(displayed, edited, latest);
  if (merged.conflicts.length || !containsChanges(displayed, edited, merged.value)) throw new Error("資料已由其他使用者修改，請核對後重試；尚未完成 Supabase 同步／請勿關閉頁面");
  return merged.value;
}

export function applyBillingChanges<T extends { units: U[] }, U extends {
  id: string; rate?: number; status: string; pricedAt?: string; events: E[];
}, E>(project: T, changes: Array<{ unitId: string; rate: number; priced: boolean; event: E }>, date: string): T {
  for (const change of changes) {
    if (!project.units.some((u) => u.id === change.unitId && !isDeletedEntity(u))) throw new Error("找不到原月結戶別，未保存修改");
  }
  return { ...project, units: project.units.map((unit) => {
    const change = changes.find((x) => x.unitId === unit.id);
    if (!change) return unit;
    const statusChanged = change.priced !== (unit.status === "已計價");
    return { ...unit, rate: change.rate, ...(statusChanged ? {
      status: change.priced ? "已計價" : "已驗收", pricedAt: change.priced ? date : "",
      events: [change.event, ...unit.events],
    } : {}) };
  }) };
}
