import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canConfirmUnit, canCreateUnit, canDeleteUnit, canEditUnitMaster, canUsePermissionUnitTab, canUsePermissionView, canViewCustomerDetails, financeUiMode } from "../lib/ui-permissions.ts";
import { NO_ROLE_PERMISSIONS, type RolePermissions } from "../lib/role-permissions.ts";

const withPermission = (key?: keyof RolePermissions): RolePermissions => ({
  ...NO_ROLE_PERMISSIONS,
  ...(key ? { [key]: true } : {}),
});

test("admin and shenyin keep business access while only admin can open accounts", () => {
  for (const role of ["admin", "shenyin"] as const) {
    for (const view of ["dashboard", "units", "daily-acceptance", "journal", "billing", "project"])
      assert.equal(canUsePermissionView(role, NO_ROLE_PERMISSIONS, view), true);
  }
  assert.equal(canUsePermissionView("admin", NO_ROLE_PERMISSIONS, "accounts"), true);
  assert.equal(canUsePermissionView("shenyin", NO_ROLE_PERMISSIONS, "accounts"), false);
});

test("crew customer privacy is independent from unit editing permission", () => {
  assert.equal(canViewCustomerDetails("crew"), false);
  assert.equal(canViewCustomerDetails("admin"), true);
  assert.equal(canViewCustomerDetails("shenyin"), true);
  assert.equal(canViewCustomerDetails("client"), true);
  assert.equal(canViewCustomerDetails("sales"), true);
  assert.equal(canEditUnitMaster("crew", withPermission("editUnitMaster")), true);
  assert.equal(canViewCustomerDetails("crew"), false);
  assert.equal(canEditUnitMaster("client", NO_ROLE_PERMISSIONS), false);
});

test("unit creation deletion and confirmation stay restricted to project managers", () => {
  for (const role of ["crew", "client", "sales"] as const) {
    const permissions = withPermission("editUnitMaster");
    assert.equal(canEditUnitMaster(role, permissions), true);
    assert.equal(canCreateUnit(role), false);
    assert.equal(canDeleteUnit(role), false);
    assert.equal(canConfirmUnit(role), false);
  }
  for (const role of ["admin", "shenyin"] as const) {
    assert.equal(canEditUnitMaster(role, NO_ROLE_PERMISSIONS), true);
    assert.equal(canCreateUnit(role), true);
    assert.equal(canDeleteUnit(role), true);
    assert.equal(canConfirmUnit(role), true);
  }
  assert.equal(canViewCustomerDetails("crew"), false);
});

test("unit confirmation UI guards both Next navigation and the Master handler", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const next = page.slice(page.indexOf("function Next("), page.indexOf("function Master("));
  const master = page.slice(page.indexOf("function Master("), page.indexOf("function SurveyTab("));

  assert.match(next, /unit\.status === "待確認" && !canConfirmUnit\(role\)/);
  assert.match(master, /onClick=\{\(\) => \{\s*if \(!canConfirm\) return;\s*patch\(\{/);
});

test("unit tabs use independent permission flags and always retain master", () => {
  const mappings = [
    ["survey", "useSurvey"], ["work", "useWork"], ["accept", "useAcceptance"],
    ["sheet", "useAcceptance"], ["journal", "useAcceptanceJournal"], ["defect", "useDefects"],
  ] as const;
  assert.equal(canUsePermissionUnitTab("client", NO_ROLE_PERMISSIONS, "master"), true);
  for (const [tab, key] of mappings) {
    assert.equal(canUsePermissionUnitTab("client", NO_ROLE_PERMISSIONS, tab), false);
    assert.equal(canUsePermissionUnitTab("client", withPermission(key), tab), true);
  }
});

test("configurable finance modes cover all four export combinations without management", () => {
  const combinations = [
    [false, false], [true, false], [false, true], [true, true],
  ] as const;
  for (const [receivables, shipment] of combinations) {
    const permissions = { ...NO_ROLE_PERMISSIONS, exportReceivables: receivables, exportShipmentDetails: shipment };
    const before = structuredClone(permissions);
    for (const role of ["crew", "client", "sales"] as const) {
      const mode = financeUiMode(role, permissions);
      assert.deepEqual(mode, {
        canEnter: receivables || shipment,
        canExportReceivables: receivables,
        canExportShipment: shipment,
        canManageFinance: false,
      });
      assert.equal(canUsePermissionView(role, permissions, "billing"), receivables || shipment);
    }
    assert.deepEqual(permissions, before);
  }
});

test("admin and shenyin finance modes are fully enabled without mutating permissions", () => {
  const permissions = withPermission();
  const before = structuredClone(permissions);
  for (const role of ["admin", "shenyin"] as const) assert.deepEqual(financeUiMode(role, permissions), {
    canEnter: true,
    canExportReceivables: true,
    canExportShipment: true,
    canManageFinance: true,
  });
  assert.deepEqual(permissions, before);
});
