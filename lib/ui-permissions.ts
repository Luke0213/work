import type { AppRole, RolePermissions } from "./role-permissions.ts";

export type FinanceUiMode = {
  canEnter: boolean;
  canExportReceivables: boolean;
  canExportShipment: boolean;
  canManageFinance: boolean;
};

const hasFullBusinessAccess = (role: AppRole) => role === "admin" || role === "shenyin";

export function canViewCustomerDetails(role: AppRole): boolean {
  return role !== "crew";
}

export function canEditUnitMaster(role: AppRole, permissions: RolePermissions): boolean {
  return hasFullBusinessAccess(role) || permissions.editUnitMaster;
}

export function canCreateUnit(role: AppRole): boolean {
  return hasFullBusinessAccess(role);
}

export function canDeleteUnit(role: AppRole): boolean {
  return hasFullBusinessAccess(role);
}

export function canConfirmUnit(role: AppRole): boolean {
  return hasFullBusinessAccess(role);
}

export function financeUiMode(role: AppRole, permissions: RolePermissions): FinanceUiMode {
  const canManageFinance = hasFullBusinessAccess(role);
  const canExportReceivables = canManageFinance || permissions.exportReceivables;
  const canExportShipment = canManageFinance || permissions.exportShipmentDetails;
  return {
    canEnter: canExportReceivables || canExportShipment,
    canExportReceivables,
    canExportShipment,
    canManageFinance,
  };
}

export function canUsePermissionView(role: AppRole, permissions: RolePermissions, view: string): boolean {
  if (view === "accounts") return role === "admin";
  if (hasFullBusinessAccess(role)) return true;
  if (view === "dashboard") return role === "crew";
  if (view === "units") return true;
  if (view === "daily-acceptance") return permissions.useAcceptance;
  if (view === "journal") return permissions.useAcceptanceJournal;
  if (view === "billing") return financeUiMode(role, permissions).canEnter;
  return false;
}

export function canUsePermissionUnitTab(role: AppRole, permissions: RolePermissions, tab: string): boolean {
  if (hasFullBusinessAccess(role)) return true;
  if (tab === "master") return true;
  if (tab === "timeline") return role === "crew";
  if (tab === "survey") return permissions.useSurvey;
  if (tab === "work") return permissions.useWork;
  if (tab === "accept" || tab === "sheet") return permissions.useAcceptance;
  if (tab === "journal") return permissions.useAcceptanceJournal;
  if (tab === "defect") return permissions.useDefects;
  return false;
}
