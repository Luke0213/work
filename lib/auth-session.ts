import { NO_ROLE_PERMISSIONS, getEffectiveRolePermissions, rolePermissionsFromDatabaseRow, type RolePermissions } from "./role-permissions.ts";

export type AuthIdentity<Role extends string = string> = {
  userId: string;
  email: string;
  displayName: string;
  role: Role | null;
  active: boolean;
  applicationStatus: AccountApplicationStatus;
  permissions: RolePermissions;
};

export type AccountApplicationStatus = "pending" | "approved" | "rejected" | "unknown";

export type AccountProfile<Role extends string = string> = {
  displayName: string;
  role: Role | null;
  active: boolean;
  applicationStatus: AccountApplicationStatus;
};

export function normalizeAccountProfile<Role extends string>(value: unknown, validRoles: readonly Role[]): AccountProfile<Role> {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object") return { displayName: "", role: null, active: false, applicationStatus: "unknown" };
  const row = candidate as Record<string, unknown>;
  const role = validRoles.includes(row.role as Role) ? row.role as Role : null;
  const status = ["pending", "approved", "rejected"].includes(String(row.application_status))
    ? row.application_status as AccountApplicationStatus
    : "unknown";
  return {
    displayName: typeof row.display_name === "string" ? row.display_name.trim() : "",
    role,
    active: row.active === true,
    applicationStatus: status,
  };
}

export class AuthResolveGuard {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}

export type AuthResolution<Role extends string> =
  | { kind: "authenticated"; identity: AuthIdentity<Role> }
  | { kind: "signed-out" }
  | { kind: "temporary-error"; identity: AuthIdentity<Role> | null; error: unknown }
  | { kind: "stale" };

type SessionUser = {
  id: string;
  email?: string | null;
  phone?: string | null;
  user_metadata?: Record<string, unknown>;
};

export const AUTH_TIMEOUT_MS = 10_000;

export function withAuthTimeout<T>(promise: Promise<T>, timeoutMs: number, errorCode: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function resolveAuthIdentity<Role extends string>(input: {
  generation: number;
  guard: AuthResolveGuard;
  sessionUser: SessionUser | null;
  previous: AuthIdentity<Role> | null;
  validateUser: () => Promise<SessionUser>;
  loadProfile: () => Promise<AccountProfile<Role>>;
  loadPermissions: () => Promise<unknown>;
  currentSessionUserId: () => Promise<string | null>;
  accountLabel: (user: SessionUser) => string;
  timeoutMs?: number;
}): Promise<AuthResolution<Role>> {
  const { generation, guard, sessionUser } = input;
  const timeoutMs = input.timeoutMs ?? AUTH_TIMEOUT_MS;
  if (!guard.isCurrent(generation)) return { kind: "stale" };
  if (!sessionUser) return { kind: "signed-out" };

  try {
    const validated = await withAuthTimeout(input.validateUser(), timeoutMs, "AUTH_VALIDATE_TIMEOUT");
    if (!guard.isCurrent(generation)) return { kind: "stale" };
    if (validated.id !== sessionUser.id) throw new Error("AUTH_USER_MISMATCH");

    const profile = await withAuthTimeout(input.loadProfile(), timeoutMs, "AUTH_ROLE_TIMEOUT");
    if (!guard.isCurrent(generation)) return { kind: "stale" };
    let permissions = { ...NO_ROLE_PERMISSIONS };
    if (profile.active && profile.applicationStatus === "approved" && profile.role) {
      const permissionPayload = await withAuthTimeout(input.loadPermissions(), timeoutMs, "AUTH_PERMISSIONS_TIMEOUT");
      if (!guard.isCurrent(generation)) return { kind: "stale" };
      permissions = getEffectiveRolePermissions(profile.role, rolePermissionsFromDatabaseRow(Array.isArray(permissionPayload) ? permissionPayload[0] : permissionPayload));
    }
    const currentUserId = await withAuthTimeout(input.currentSessionUserId(), timeoutMs, "AUTH_SESSION_CHECK_TIMEOUT");
    if (!guard.isCurrent(generation)) return { kind: "stale" };
    if (currentUserId !== sessionUser.id) throw new Error("AUTH_SESSION_CHANGED");

    return {
      kind: "authenticated",
      identity: { userId: validated.id, email: input.accountLabel(validated), ...profile, permissions },
    };
  } catch (error) {
    if (!guard.isCurrent(generation)) return { kind: "stale" };
    return {
      kind: "temporary-error",
      identity: input.previous?.userId === sessionUser.id ? input.previous : null,
      error,
    };
  }
}
