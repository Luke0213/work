import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ALL_ROLE_PERMISSIONS,
  CONFIGURABLE_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  NO_ROLE_PERMISSIONS,
  ROLE_PERMISSION_KEYS,
  getEffectiveRolePermissions,
  hasAllRolePermissions,
  isConfigurableRole,
  normalizeRolePermissions,
  parseRolePermissionMatrix,
  rolePermissionMatrixFromDatabaseRows,
  rolePermissionsFromDatabaseRow,
  setAllRolePermissions,
} from "../lib/role-permissions.ts";

test("role permission keys are exactly the eight business permissions", () => {
  assert.deepEqual(ROLE_PERMISSION_KEYS, [
    "editUnitMaster", "useSurvey", "useWork", "useAcceptance",
    "useAcceptanceJournal", "useDefects", "exportReceivables", "exportShipmentDetails",
  ]);
  assert.equal(ROLE_PERMISSION_KEYS.length, 8);
});

test("fixed and configurable roles receive safe effective defaults", () => {
  assert.deepEqual(getEffectiveRolePermissions("admin"), ALL_ROLE_PERMISSIONS);
  assert.deepEqual(getEffectiveRolePermissions("shenyin"), ALL_ROLE_PERMISSIONS);
  assert.deepEqual(getEffectiveRolePermissions("crew"), DEFAULT_ROLE_PERMISSIONS.crew);
  assert.deepEqual(getEffectiveRolePermissions("client"), DEFAULT_ROLE_PERMISSIONS.client);
  assert.deepEqual(getEffectiveRolePermissions("sales"), DEFAULT_ROLE_PERMISSIONS.sales);
  assert.deepEqual(getEffectiveRolePermissions("unknown"), NO_ROLE_PERMISSIONS);
  assert.equal(isConfigurableRole("crew"), true);
  assert.equal(isConfigurableRole("admin"), false);
});

test("malformed payloads fail closed instead of accepting truthy values", () => {
  const normalized = normalizeRolePermissions({
    editUnitMaster: "true",
    useSurvey: 1,
    useWork: null,
    useAcceptance: undefined,
    useDefects: true,
  });
  assert.deepEqual(normalized, { ...NO_ROLE_PERMISSIONS, useDefects: true });
  assert.deepEqual(getEffectiveRolePermissions("crew", {}), NO_ROLE_PERMISSIONS);
});

test("snake case database rows map to camel case without accepting non-booleans", () => {
  const source = {
    edit_unit_master: true, use_survey: true, use_work: false, use_acceptance: true,
    use_acceptance_journal: false, use_defects: true, export_receivables: false,
    export_shipment_details: true,
  };
  const before = { ...source };
  assert.deepEqual(rolePermissionsFromDatabaseRow(source), {
    editUnitMaster: true, useSurvey: true, useWork: false, useAcceptance: true,
    useAcceptanceJournal: false, useDefects: true, exportReceivables: false,
    exportShipmentDetails: true,
  });
  assert.deepEqual(source, before);
  assert.deepEqual(rolePermissionsFromDatabaseRow({ ...source, use_survey: "true", use_work: 1, use_defects: null }), {
    editUnitMaster: true, useSurvey: false, useWork: false, useAcceptance: true,
    useAcceptanceJournal: false, useDefects: false, exportReceivables: false,
    exportShipmentDetails: true,
  });
});

test("database matrix supplies defaults only for missing configurable role rows", () => {
  const matrix = rolePermissionMatrixFromDatabaseRows([{ role: "crew", edit_unit_master: false }]);
  assert.deepEqual(matrix.crew, NO_ROLE_PERMISSIONS);
  assert.deepEqual(matrix.client, DEFAULT_ROLE_PERMISSIONS.client);
  assert.deepEqual(matrix.sales, DEFAULT_ROLE_PERMISSIONS.sales);
});

test("matrix payload requires exactly three roles and eight real booleans", () => {
  const valid = Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, { ...DEFAULT_ROLE_PERMISSIONS[role] }]));
  const parsed = parseRolePermissionMatrix(valid);
  assert.deepEqual(parsed, valid);
  assert.notEqual(parsed, valid);
  assert.equal(parseRolePermissionMatrix({ crew: valid.crew, client: valid.client }), null);
  assert.equal(parseRolePermissionMatrix({ ...valid, admin: ALL_ROLE_PERMISSIONS }), null);
  assert.equal(parseRolePermissionMatrix({ ...valid, crew: { ...valid.crew, all: true } }), null);
  assert.equal(parseRolePermissionMatrix({ ...valid, crew: { ...valid.crew, useSurvey: "true" } }), null);
  assert.equal(parseRolePermissionMatrix({ ...valid, crew: { ...valid.crew, useSurvey: 1 } }), null);
  assert.equal(parseRolePermissionMatrix({ ...valid, crew: { ...valid.crew, useSurvey: null } }), null);
  assert.equal(Object.hasOwn(valid.crew, "all"), false);
});

test("select all helpers return new objects and never mutate their source", () => {
  const source = { ...DEFAULT_ROLE_PERMISSIONS.client };
  const before = { ...source };
  const selected = setAllRolePermissions(source, true);
  const cleared = setAllRolePermissions(selected, false);
  assert.notEqual(selected, source);
  assert.deepEqual(source, before);
  assert.equal(hasAllRolePermissions(selected), true);
  assert.equal(hasAllRolePermissions(cleared), false);
  assert.deepEqual(cleared, NO_ROLE_PERMISSIONS);
});

test("migration is additive, restricted, and matches TypeScript defaults", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202609030001_role_permissions.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.spc_role_permissions/);
  assert.match(sql, /constraint spc_role_permissions_role_check check \(role in \('crew', 'client', 'sales'\)\)/);
  assert.match(sql, /alter table public\.spc_role_permissions enable row level security/);
  assert.match(sql, /revoke all on table public\.spc_role_permissions from public, anon, authenticated/);
  assert.match(sql, /on conflict \(role\) do nothing/);
  assert.match(sql, /create or replace function public\.spc_current_permissions\(\)/);
  assert.match(sql, /user_role\.user_id = auth\.uid\(\)[\s\S]*user_role\.active[\s\S]*application_status = 'approved'/);
  assert.match(sql, /current_role in \('admin', 'shenyin'\)[\s\S]*select true, true, true, true, true, true, true, true/);
  assert.match(sql, /set search_path = pg_catalog, public/);
  assert.match(sql, /revoke all on function public\.spc_current_permissions\(\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.spc_current_permissions\(\) to authenticated/);
  assert.match(sql, /create or replace function public\.spc_admin_save_role_permissions\(p_permissions jsonb\)/);
  const saveRpc = sql.slice(sql.indexOf("create or replace function public.spc_admin_save_role_permissions"));
  assert.match(saveRpc, /caller\.user_id = auth\.uid\(\)[\s\S]*caller\.role = 'admin'[\s\S]*caller\.active = true[\s\S]*caller\.application_status = 'approved'/);
  assert.match(saveRpc, /jsonb_object_length\(p_permissions\) <> 3[\s\S]*p_permissions \?& allowed_roles/);
  assert.match(saveRpc, /jsonb_object_length\(permission_row\) <> 8[\s\S]*permission_row \?& allowed_keys/);
  assert.match(saveRpc, /jsonb_typeof\(permission_row -> permission_key\) <> 'boolean'/);
  assert.match(saveRpc, /foreach role_name in array allowed_roles[\s\S]*insert into public\.spc_role_permissions[\s\S]*on conflict \(role\) do update/);
  assert.match(saveRpc, /updated_at = now\(\)[\s\S]*updated_by = auth\.uid\(\)/);
  assert.match(saveRpc, /revoke all on function public\.spc_admin_save_role_permissions\(jsonb\) from public, anon, authenticated/);
  assert.match(saveRpc, /grant execute on function public\.spc_admin_save_role_permissions\(jsonb\) to authenticated/);
  assert.doesNotMatch(saveRpc, /delete\s+from|truncate|drop\s+table|update\s+public\.spc_user_roles|storage\.|photo|workspace/i);
  assert.doesNotMatch(sql, /\b(drop table|truncate|delete from|update public\.spc_user_roles|alter table public\.spc_user_roles)\b/i);
  assert.doesNotMatch(sql, /storage\.|bucket|photo|cleanup|spc_load_workspace|spc_merge_workspace|spc_merge_restricted_projects|tombstone/i);
  const seedRows = sql.slice(sql.indexOf("insert into public.spc_role_permissions"), sql.indexOf("on conflict (role) do nothing"));
  assert.doesNotMatch(seedRows, /\('admin'\s*,|\('shenyin'\s*,/);
  assert.doesNotMatch(sql, /\b全部\b/);
  assert.match(sql, /\('crew', true, true, true, true, true, true, false, false\)/);
  assert.match(sql, /\('client', true, false, false, false, false, false, false, false\)/);
  assert.match(sql, /\('sales', true, false, false, false, false, false, false, false\)/);
});
