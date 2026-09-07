import { threeWayMerge, isDeletedEntity } from "./three-way-merge.ts";
import type { AcceptanceExportRecord, AcceptanceReportMetadata, ReceivableDetailDraft } from "./acceptance-exports.ts";
import { containsWorkspaceChanges } from "./workspace-persistence.ts";

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

// Verify only intended changed fields; concurrent edits to unrelated fields are valid.
export function containsChanges(base: unknown, intended: unknown, committed: unknown): boolean {
  return containsWorkspaceChanges(base, intended, committed);
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
  acceptances?: Array<{ id: string; draft?: boolean; report?: AcceptanceReportMetadata }>;
}, E>(project: T, changes: Array<{ unitId: string; acceptanceId?: string; rate: number; priced: boolean; event: E }>, date: string): T {
  for (const change of changes) {
    if (!project.units.some((u) => u.id === change.unitId && !isDeletedEntity(u))) throw new Error("找不到原月結戶別，未保存修改");
  }
  return { ...project, units: project.units.map((unit) => {
    const change = changes.find((x) => x.unitId === unit.id);
    if (!change) return unit;
    const rateChanged = change.rate !== Number(unit.rate || 0);
    const statusChanged = change.priced !== (unit.status === "已計價");
    let acceptances = unit.acceptances;
    if (rateChanged && change.acceptanceId) {
      const formalAcceptance = acceptances?.find((acceptance) =>
        acceptance.id === change.acceptanceId && acceptance.draft !== true && !isDeletedEntity(acceptance));
      if (!formalAcceptance) throw new Error("找不到月結單價對應的正式驗收紀錄，未保存修改");
      acceptances = acceptances!.map((acceptance) => acceptance.id === change.acceptanceId
        ? { ...acceptance, report: { ...acceptance.report, unitPriceText: String(change.rate) } }
        : acceptance);
    }
    return { ...unit, rate: change.rate, ...(acceptances ? { acceptances } : {}), ...(statusChanged ? {
      status: change.priced ? "已計價" : "已驗收", pricedAt: change.priced ? date : "",
      events: [change.event, ...unit.events],
    } : {}) };
  }) };
}

type ReceivableAcceptance = {
  id: string;
  draft?: boolean;
  report?: AcceptanceReportMetadata;
};
type ReceivableUnit = { id: string; acceptances: ReceivableAcceptance[] };

const receivableSharedFields = [
  ["date", "shipmentDateText"],
  ["model", "productText"],
  ["unitDisplay", "unitDisplayText"],
  ["quantity", "pingText"],
  ["unitPrice", "unitPriceText"],
  ["note", "noteText"],
] as const satisfies ReadonlyArray<readonly [keyof ReceivableDetailDraft, keyof AcceptanceReportMetadata]>;

export function applyReceivableSharedFields<
  T extends { units: U[] },
  U extends ReceivableUnit,
>(project: T, records: AcceptanceExportRecord[], original: ReceivableDetailDraft[], edited: ReceivableDetailDraft[]): T {
  if (records.length !== original.length || records.length !== edited.length) {
    throw new Error("應收明細列已變更，未保存任何修改");
  }

  const targets = records.map((record, index) => {
    const unit = project.units.find((candidate) => candidate.id === record.unitId && !isDeletedEntity(candidate));
    const acceptance = unit?.acceptances.find((candidate) =>
      candidate.id === record.acceptanceId && candidate.draft !== true && !isDeletedEntity(candidate));
    if (!unit || !acceptance || !record.acceptanceId) {
      throw new Error("找不到應收明細對應的正式驗收紀錄，未保存任何修改");
    }
    const reportUpdates: AcceptanceReportMetadata = {};
    for (const [detailKey, reportKey] of receivableSharedFields) {
      if (edited[index][detailKey] !== original[index][detailKey]) {
        reportUpdates[reportKey] = edited[index][detailKey];
      }
    }
    return { unitId: unit.id, acceptanceId: acceptance.id, reportUpdates };
  });

  return { ...project, units: project.units.map((unit) => {
    const unitTargets = targets.filter((target) => target.unitId === unit.id);
    if (!unitTargets.length) return unit;
    return { ...unit, acceptances: unit.acceptances.map((acceptance) => {
      const target = unitTargets.find((candidate) => candidate.acceptanceId === acceptance.id);
      return target && Object.keys(target.reportUpdates).length
        ? { ...acceptance, report: { ...acceptance.report, ...target.reportUpdates } }
        : acceptance;
    }) };
  }) };
}
