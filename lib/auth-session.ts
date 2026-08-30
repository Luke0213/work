export type AuthIdentity<Role extends string = string> = {
  userId: string;
  email: string;
  role: Role;
};

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
  loadRole: () => Promise<Role>;
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

    const role = await withAuthTimeout(input.loadRole(), timeoutMs, "AUTH_ROLE_TIMEOUT");
    if (!guard.isCurrent(generation)) return { kind: "stale" };
    const currentUserId = await withAuthTimeout(input.currentSessionUserId(), timeoutMs, "AUTH_SESSION_CHECK_TIMEOUT");
    if (!guard.isCurrent(generation)) return { kind: "stale" };
    if (currentUserId !== sessionUser.id) throw new Error("AUTH_SESSION_CHANGED");

    return {
      kind: "authenticated",
      identity: { userId: validated.id, email: input.accountLabel(validated), role },
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
