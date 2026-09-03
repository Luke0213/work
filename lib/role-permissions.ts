export type AppRole = "admin" | "shenyin" | "client" | "crew" | "sales";

export type ConfigurableRole = "crew" | "client" | "sales";

export const ROLE_PERMISSION_KEYS = [
  "editUnitMaster",
  "useSurvey",
  "useWork",
  "useAcceptance",
  "useAcceptanceJournal",
  "useDefects",
  "exportReceivables",
  "exportShipmentDetails",
] as const;

export type RolePermissionKey = (typeof ROLE_PERMISSION_KEYS)[number];
export type RolePermissions = Record<RolePermissionKey, boolean>;
export type RolePermissionMatrix = Record<ConfigurableRole, RolePermissions>;

export const CONFIGURABLE_ROLES = ["crew", "client", "sales"] as const satisfies readonly ConfigurableRole[];

const DB_PERMISSION_KEYS: Record<RolePermissionKey, string> = {
  editUnitMaster: "edit_unit_master",
  useSurvey: "use_survey",
  useWork: "use_work",
  useAcceptance: "use_acceptance",
  useAcceptanceJournal: "use_acceptance_journal",
  useDefects: "use_defects",
  exportReceivables: "export_receivables",
  exportShipmentDetails: "export_shipment_details",
};

const permissions = (
  editUnitMaster: boolean,
  useSurvey: boolean,
  useWork: boolean,
  useAcceptance: boolean,
  useAcceptanceJournal: boolean,
  useDefects: boolean,
  exportReceivables: boolean,
  exportShipmentDetails: boolean,
): RolePermissions => ({
  editUnitMaster,
  useSurvey,
  useWork,
  useAcceptance,
  useAcceptanceJournal,
  useDefects,
  exportReceivables,
  exportShipmentDetails,
});

export const ALL_ROLE_PERMISSIONS = permissions(true, true, true, true, true, true, true, true);
export const NO_ROLE_PERMISSIONS = permissions(false, false, false, false, false, false, false, false);

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<ConfigurableRole, RolePermissions>> = {
  crew: permissions(true, true, true, true, true, true, false, false),
  client: permissions(true, false, false, false, false, false, false, false),
  sales: permissions(true, false, false, false, false, false, false, false),
};

export function isConfigurableRole(role: unknown): role is ConfigurableRole {
  return role === "crew" || role === "client" || role === "sales";
}

export function normalizeRolePermissions(payload: unknown): RolePermissions {
  const source = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return Object.fromEntries(
    ROLE_PERMISSION_KEYS.map((key) => [key, source[key] === true]),
  ) as RolePermissions;
}

export function rolePermissionsFromDatabaseRow(payload: unknown): RolePermissions {
  const source = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return normalizeRolePermissions(Object.fromEntries(
    ROLE_PERMISSION_KEYS.map((key) => [key, source[DB_PERMISSION_KEYS[key]]]),
  ));
}

export function isExactRolePermissions(payload: unknown): payload is RolePermissions {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const source = payload as Record<string, unknown>;
  const keys = Object.keys(source);
  return keys.length === ROLE_PERMISSION_KEYS.length
    && ROLE_PERMISSION_KEYS.every((key) => typeof source[key] === "boolean");
}

export function parseRolePermissionMatrix(payload: unknown): RolePermissionMatrix | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== CONFIGURABLE_ROLES.length || !CONFIGURABLE_ROLES.every((role) => keys.includes(role))) return null;
  if (!CONFIGURABLE_ROLES.every((role) => isExactRolePermissions(source[role]))) return null;
  return Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, { ...(source[role] as RolePermissions) }])) as RolePermissionMatrix;
}

export function rolePermissionMatrixFromDatabaseRows(payload: unknown): RolePermissionMatrix {
  const rows = Array.isArray(payload) ? payload : [];
  return Object.fromEntries(CONFIGURABLE_ROLES.map((role) => {
    const row = rows.find((candidate) => candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).role === role);
    return [role, row ? rolePermissionsFromDatabaseRow(row) : { ...DEFAULT_ROLE_PERMISSIONS[role] }];
  })) as RolePermissionMatrix;
}

export function getEffectiveRolePermissions(role: unknown, configured?: unknown): RolePermissions {
  if (role === "admin" || role === "shenyin") return { ...ALL_ROLE_PERMISSIONS };
  if (!isConfigurableRole(role)) return { ...NO_ROLE_PERMISSIONS };
  if (configured === undefined || configured === null) return { ...DEFAULT_ROLE_PERMISSIONS[role] };
  return normalizeRolePermissions(configured);
}

export function hasAllRolePermissions(value: RolePermissions): boolean {
  return ROLE_PERMISSION_KEYS.every((key) => value[key] === true);
}

export function setAllRolePermissions(value: RolePermissions, enabled: boolean): RolePermissions {
  return Object.fromEntries(
    ROLE_PERMISSION_KEYS.map((key) => [key, enabled]),
  ) as RolePermissions;
}
