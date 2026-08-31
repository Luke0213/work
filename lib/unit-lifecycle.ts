export type UnitLifecycleStatus =
  | "待確認"
  | "待場勘"
  | "場勘待改善"
  | "可進場"
  | "施工中"
  | "待驗收"
  | "驗收缺失"
  | "改善中"
  | "待複驗"
  | "已驗收"
  | "已計價";

export const canWriteWorkLifecycle = (status: UnitLifecycleStatus): boolean =>
  status === "可進場" || status === "施工中";

export const canWriteAcceptanceLifecycle = (
  status: UnitLifecycleStatus,
  recheck: boolean | undefined,
  editingFormalHistory = false,
): boolean => editingFormalHistory || (recheck ? status === "待複驗" : status === "待驗收");
