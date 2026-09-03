import test from "node:test";
import assert from "node:assert/strict";
import { AuthResolveGuard, normalizeAccountProfile, resolveAuthIdentity, type AuthIdentity } from "../lib/auth-session.ts";
import { ALL_ROLE_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, NO_ROLE_PERMISSIONS } from "../lib/role-permissions.ts";

type Role = "admin" | "shenyin" | "client" | "crew" | "sales";
const roles: Role[] = ["admin", "shenyin", "client", "crew", "sales"];
const user = (id: string) => ({ id, email: `${id}@example.com`, user_metadata: {} });
const profile = (role: Role | null = "admin", active = true, applicationStatus: "pending" | "approved" | "rejected" | "unknown" = "approved", displayName = "王小明") => ({ role, active, applicationStatus, displayName });
const permissionRow = (value = DEFAULT_ROLE_PERMISSIONS.crew) => ({
  edit_unit_master: value.editUnitMaster, use_survey: value.useSurvey, use_work: value.useWork,
  use_acceptance: value.useAcceptance, use_acceptance_journal: value.useAcceptanceJournal,
  use_defects: value.useDefects, export_receivables: value.exportReceivables,
  export_shipment_details: value.exportShipmentDetails,
});
const identity = (id = "A"): AuthIdentity<Role> => ({ userId: id, email: `${id}@example.com`, ...profile(), permissions: { ...ALL_ROLE_PERMISSIONS } });

test("stale user A resolution cannot overwrite newer user B", async () => {
  const guard = new AuthResolveGuard();
  let releaseA!: () => void;
  const waitA = new Promise<void>((resolve) => { releaseA = resolve; });
  const resolvingA = resolveAuthIdentity<Role>({ generation: guard.begin(), guard, sessionUser: user("A"), previous: null,
    validateUser: async () => { await waitA; return user("A"); }, loadProfile: async () => profile("admin"), loadPermissions: async () => [permissionRow()], currentSessionUserId: async () => "A", accountLabel: (value) => value.email || "" });
  const resolvedB = await resolveAuthIdentity<Role>({ generation: guard.begin(), guard, sessionUser: user("B"), previous: null,
    validateUser: async () => user("B"), loadProfile: async () => profile("crew"), loadPermissions: async () => [permissionRow()], currentSessionUserId: async () => "B", accountLabel: (value) => value.email || "" });
  releaseA();
  const resolvedA = await resolvingA;
  assert.equal(resolvedB.kind, "authenticated");
  assert.equal(resolvedB.kind === "authenticated" && resolvedB.identity.userId, "B");
  assert.equal(resolvedA.kind, "stale");
});

test("approved active legal profile creates an authorized identity with display name", async () => {
  const guard = new AuthResolveGuard();
  const result = await resolveAuthIdentity<Role>({ generation: guard.begin(), guard, sessionUser: user("A"), previous: null,
    validateUser: async () => user("A"), loadProfile: async () => profile("crew", true, "approved", "林工務"), loadPermissions: async () => [permissionRow()], currentSessionUserId: async () => "A", accountLabel: (value) => value.email || "" });
  assert.equal(result.kind, "authenticated");
  assert.deepEqual(result.kind === "authenticated" && result.identity, { userId: "A", email: "A@example.com", displayName: "林工務", role: "crew", active: true, applicationStatus: "approved", permissions: DEFAULT_ROLE_PERMISSIONS.crew });
});

test("pending rejected and inactive profiles remain explicit and never become client", async () => {
  for (const account of [profile("crew", false, "pending"), profile("sales", false, "rejected"), profile("client", false, "approved")]) {
    const guard = new AuthResolveGuard();
    const result = await resolveAuthIdentity<Role>({ generation: guard.begin(), guard, sessionUser: user("A"), previous: null,
      validateUser: async () => user("A"), loadProfile: async () => account, loadPermissions: async () => { throw new Error("inactive profiles must not load permissions"); }, currentSessionUserId: async () => "A", accountLabel: (value) => value.email || "" });
    assert.equal(result.kind, "authenticated");
    assert.deepEqual(result.kind === "authenticated" && result.identity.applicationStatus, account.applicationStatus);
    assert.equal(result.kind === "authenticated" && result.identity.active, account.active);
    assert.equal(result.kind === "authenticated" && result.identity.role, account.role);
    assert.deepEqual(result.kind === "authenticated" && result.identity.permissions, NO_ROLE_PERMISSIONS);
  }
});

test("unknown null and malformed profiles fail closed", () => {
  for (const value of [null, undefined, {}, { role: "owner", active: true, application_status: "approved" }, { role: "admin", active: "yes", application_status: "approved" }]) {
    const result = normalizeAccountProfile<Role>(value, roles);
    assert.equal(result.active && result.applicationStatus === "approved" && result.role !== null, false);
  }
});

test("temporary validation error retains the verified identity for the same session user", async () => {
  const guard = new AuthResolveGuard(); const previous = identity();
  const result = await resolveAuthIdentity<Role>({ generation: guard.begin(), guard, sessionUser: user("A"), previous,
    validateUser: async () => { throw new Error("network"); }, loadProfile: async () => profile(), loadPermissions: async () => [permissionRow()], currentSessionUserId: async () => "A", accountLabel: (value) => value.email || "" });
  assert.equal(result.kind, "temporary-error"); assert.deepEqual(result.kind === "temporary-error" && result.identity, previous);
});

test("a null authoritative session produces a real signed-out result", async () => {
  const guard = new AuthResolveGuard();
  const result = await resolveAuthIdentity<Role>({ generation: guard.begin(), guard, sessionUser: null, previous: identity(),
    validateUser: async () => user("A"), loadProfile: async () => profile(), loadPermissions: async () => [permissionRow()], currentSessionUserId: async () => null, accountLabel: (value) => value.email || "" });
  assert.equal(result.kind, "signed-out");
});

test("rejected validation is a temporary error and never signed-out", async () => {
  const guard = new AuthResolveGuard();
  const result = await resolveAuthIdentity<Role>({ generation: guard.begin(), guard, sessionUser: user("A"), previous: null,
    validateUser: async () => { throw new Error("network"); }, loadProfile: async () => profile(), loadPermissions: async () => [permissionRow()], currentSessionUserId: async () => "A", accountLabel: (value) => value.email || "" });
  assert.equal(result.kind, "temporary-error"); assert.notEqual(result.kind, "signed-out");
});

test("validation profile permissions and session timeouts remain temporary errors", async () => {
  for (const pendingStep of ["validation", "profile", "permissions", "session"] as const) {
    const guard = new AuthResolveGuard(); const previous = identity();
    const result = await resolveAuthIdentity<Role>({ generation: guard.begin(), guard, sessionUser: user("A"), previous,
      validateUser: pendingStep === "validation" ? () => new Promise(() => {}) : async () => user("A"),
      loadProfile: pendingStep === "profile" ? () => new Promise(() => {}) : async () => profile(),
      loadPermissions: pendingStep === "permissions" ? () => new Promise(() => {}) : async () => [permissionRow()],
      currentSessionUserId: pendingStep === "session" ? () => new Promise(() => {}) : async () => "A", accountLabel: (value) => value.email || "", timeoutMs: 5 });
    assert.equal(result.kind, "temporary-error"); assert.deepEqual(result.kind === "temporary-error" && result.identity, previous);
    assert.equal(result.kind === "temporary-error" && (result.error as Error).message,
      pendingStep === "validation" ? "AUTH_VALIDATE_TIMEOUT" : pendingStep === "profile" ? "AUTH_ROLE_TIMEOUT" : pendingStep === "permissions" ? "AUTH_PERMISSIONS_TIMEOUT" : "AUTH_SESSION_CHECK_TIMEOUT");
  }
});

test("admin and shenyin permissions stay all true while malformed configurable permissions fail closed", async () => {
  for (const role of ["admin", "shenyin", "crew"] as const) {
    const guard = new AuthResolveGuard();
    const result = await resolveAuthIdentity<Role>({ generation: guard.begin(), guard, sessionUser: user("A"), previous: null,
      validateUser: async () => user("A"), loadProfile: async () => profile(role), loadPermissions: async () => [{ use_survey: "true" }],
      currentSessionUserId: async () => "A", accountLabel: (value) => value.email || "" });
    assert.equal(result.kind, "authenticated");
    assert.deepEqual(result.kind === "authenticated" && result.identity.permissions, role === "crew" ? NO_ROLE_PERMISSIONS : ALL_ROLE_PERMISSIONS);
  }
});

test("user mismatch and changed session remain temporary errors", async () => {
  for (const scenario of ["mismatch", "changed"] as const) {
    const guard = new AuthResolveGuard();
    const result = await resolveAuthIdentity<Role>({ generation: guard.begin(), guard, sessionUser: user("A"), previous: null,
      validateUser: async () => user(scenario === "mismatch" ? "B" : "A"), loadProfile: async () => profile(),
      loadPermissions: async () => [permissionRow()],
      currentSessionUserId: async () => scenario === "changed" ? "B" : "A", accountLabel: (value) => value.email || "" });
    assert.equal(result.kind, "temporary-error");
    assert.equal(result.kind === "temporary-error" && (result.error as Error).message, scenario === "mismatch" ? "AUTH_USER_MISMATCH" : "AUTH_SESSION_CHANGED");
  }
});
