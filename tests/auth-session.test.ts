import test from "node:test";
import assert from "node:assert/strict";
import { AuthResolveGuard, resolveAuthIdentity } from "../lib/auth-session.ts";

const user = (id: string) => ({ id, email: `${id}@example.com`, user_metadata: {} });

test("stale user A resolution cannot overwrite newer user B", async () => {
  const guard = new AuthResolveGuard();
  let releaseA!: () => void;
  const waitA = new Promise<void>((resolve) => { releaseA = resolve; });
  const generationA = guard.begin();
  const resolvingA = resolveAuthIdentity({
    generation: generationA, guard, sessionUser: user("A"), previous: null,
    validateUser: async () => { await waitA; return user("A"); },
    loadRole: async () => "admin", currentSessionUserId: async () => "A", accountLabel: (value) => value.email || "",
  });
  const generationB = guard.begin();
  const resolvedB = await resolveAuthIdentity({
    generation: generationB, guard, sessionUser: user("B"), previous: null,
    validateUser: async () => user("B"), loadRole: async () => "crew",
    currentSessionUserId: async () => "B", accountLabel: (value) => value.email || "",
  });
  releaseA();
  const resolvedA = await resolvingA;
  assert.equal(resolvedB.kind, "authenticated");
  assert.equal(resolvedB.kind === "authenticated" && resolvedB.identity.userId, "B");
  assert.equal(resolvedA.kind, "stale");
});

test("temporary validation error retains the verified identity for the same session user", async () => {
  const guard = new AuthResolveGuard();
  const previous = { userId: "A", email: "A@example.com", role: "admin" };
  const result = await resolveAuthIdentity({
    generation: guard.begin(), guard, sessionUser: user("A"), previous,
    validateUser: async () => { throw new Error("network"); }, loadRole: async () => "admin",
    currentSessionUserId: async () => "A", accountLabel: (value) => value.email || "",
  });
  assert.equal(result.kind, "temporary-error");
  assert.deepEqual(result.kind === "temporary-error" && result.identity, previous);
});

test("a null authoritative session produces a real signed-out result", async () => {
  const guard = new AuthResolveGuard();
  const result = await resolveAuthIdentity({
    generation: guard.begin(), guard, sessionUser: null, previous: { userId: "A", email: "A@example.com", role: "admin" },
    validateUser: async () => user("A"), loadRole: async () => "admin",
    currentSessionUserId: async () => null, accountLabel: (value) => value.email || "",
  });
  assert.equal(result.kind, "signed-out");
});
