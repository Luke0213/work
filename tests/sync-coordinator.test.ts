import test from "node:test";
import assert from "node:assert/strict";
import { SyncCoordinator, intendedFingerprint, type SyncAttempt } from "../lib/sync-coordinator.ts";
import { formatSupabaseError, supabaseErrorDetails, withSupabaseErrorContext } from "../lib/supabase-error.ts";
import { uploadUnresolvedPhotos } from "../lib/photo-persistence.ts";
import { promotePhotoReferences, outboxIsCommitted, type OfflineOutboxEntry } from "../lib/offline-drafts.ts";

type Value = { journals: Array<{ id: string; content: string; photos?: Array<{ id: string; data: string }> }> };
const base: Value = { journals: [] };
const intended: Value = { journals: [{ id: "j", content: "驗收" }] };
const setup = () => {
  let time = 0, saves = 0, loads = 0;
  let remote = { version: 1, value: base };
  let durable: SyncAttempt<Value> | null = null;
  const coordinator = new SyncCoordinator<Value, typeof remote>("owner", () => time);
  const ports = {
    durable: async (attempt: SyncAttempt<Value>) => { durable = structuredClone(attempt); },
    upload: async (value: Value) => value,
    save: async (attempt: SyncAttempt<Value>) => { saves++; remote = { version: remote.version + 1, value: structuredClone(attempt.intended) }; return remote.version; },
    load: async () => { loads++; return remote; },
    value: (snapshot: typeof remote) => snapshot.value,
  };
  return { coordinator, ports, stats: () => ({ saves, loads }), durable: () => durable, tick: (ms: number) => { time += ms; }, setRemote: (value: Value) => { remote = { version: remote.version + 1, value }; } };
};

test("overlapping identical payloads and subsequent replay create exactly one SAVE", async () => {
  const h = setup();
  await Promise.all([h.coordinator.run(base, intended, 1, h.ports), h.coordinator.run(base, structuredClone(intended), 1, h.ports)]);
  h.coordinator.acknowledge();
  await h.coordinator.run(base, intended, 1, h.ports);
  assert.equal(h.stats().saves, 1);
});

test("commit succeeded but verification failed: exponential bounded verification-only retries", async () => {
  const h = setup();
  const ports = { ...h.ports, load: async () => { throw new Error("reload unavailable"); } };
  await assert.rejects(h.coordinator.run(base, intended, 1, ports));
  assert.equal(h.durable()?.submitted, true);
  for (const delay of [15_000, 30_000, 60_000, 120_000]) {
    await assert.rejects(h.coordinator.run(base, intended, 1, ports));
    assert.equal(h.stats().saves, 1);
    h.tick(delay);
    await assert.rejects(h.coordinator.run(base, intended, 1, ports));
  }
  h.tick(999_999);
  assert.equal(h.coordinator.canRetry(), false);
  assert.equal(h.stats().saves, 1);
  assert.ok(h.durable());
});

test("lost SAVE response survives restart without creating another version", async () => {
  const h = setup();
  await assert.rejects(h.coordinator.run(base, intended, 1, { ...h.ports, save: async (attempt) => { await h.ports.save(attempt); throw new Error("lost response"); } }));
  const restarted = new SyncCoordinator<Value, { version: number; value: Value }>("owner", () => 20_000);
  restarted.restore(h.durable());
  await restarted.run(base, intended, 1, h.ports);
  assert.equal(h.stats().saves, 1);
});

test("durable write failure never sends cloud SAVE and preserves intended snapshot", async () => {
  const h = setup();
  await assert.rejects(h.coordinator.run(base, intended, 1, { ...h.ports, durable: async () => { throw new Error("quota"); } }));
  assert.equal(h.stats().saves, 0);
  assert.deepEqual(h.coordinator.attempt?.intended, intended);
});

test("unchanged remote version does not download; changed version only reloads clean clients", async () => {
  const h = setup(); let applied = 0, checks = 0, clean = true;
  const refresh = (version: number) => h.coordinator.refresh(1, () => clean, async () => { checks++; return version; }, h.ports.load, () => { applied++; });
  await refresh(1); assert.equal(h.stats().loads, 0);
  clean = false; await refresh(2); assert.equal(checks, 1); assert.equal(h.stats().loads, 0);
  clean = true; await refresh(2); assert.equal(applied, 1);
  await h.coordinator.refresh(1, () => clean, async () => { clean = false; return 2; }, h.ports.load, () => { applied++; });
  assert.equal(applied, 1); assert.equal(h.stats().loads, 1);
});

test("local edits that arrive during full remote reload cannot be overwritten", async () => {
  const h = setup(); let clean = true, applied = false;
  await h.coordinator.refresh(1, () => clean, async () => 2, async () => { clean = false; return h.ports.load(); }, () => { applied = true; });
  assert.equal(applied, false);
});

test("pending and in-flight attempts block shared refresh", async () => {
  const h = setup();
  await assert.rejects(h.coordinator.run(base, intended, 1, { ...h.ports, save: async () => { throw new Error("offline"); } }));
  await h.coordinator.refresh(1, () => true, async () => { throw new Error("must not poll"); }, h.ports.load, () => assert.fail());
  assert.equal(h.stats().loads, 0);
});

test("account-scoped coordinator cannot recover a different owner's attempt", async () => {
  const h = setup(); await h.coordinator.run(base, intended, 1, h.ports);
  const other = new SyncCoordinator<Value, { version: number }>("other");
  other.restore(h.durable()); assert.equal(other.attempt, null);
});

test("photo checkpoint survives partial upload and retries reuse immutable paths", async () => {
  const input = [{ id: "a", data: "data:image/png;base64,YQ==" }, { id: "b", data: "data:image/png;base64,Yg==" }];
  let checkpoint = input; const paths: string[] = [];
  await assert.rejects(uploadUnresolvedPhotos(input, async (path) => { paths.push(path); if (path.includes("b.png")) throw new Error("network"); }, async (value) => { checkpoint = structuredClone(value); }));
  const retried = await uploadUnresolvedPhotos(checkpoint, async (path) => { paths.push(path); });
  assert.deepEqual(paths, ["spc/a.png", "spc/b.png", "spc/b.png"]);
  assert.equal(retried[0].data, "spc-storage://spc/a.png");
  assert.equal(input[0].data, "data:image/png;base64,YQ==");
  assert.deepEqual(promotePhotoReferences(input, input, retried), retried);
  const newer = [{ id: "a", data: "data:image/png;base64,bmV3" }];
  assert.deepEqual(promotePhotoReferences(newer, input, retried), newer);
});

test("signed URL renewal and property order do not change intended fingerprint", () => {
  assert.equal(intendedFingerprint({ id: "p", data: "spc-storage://spc/p.jpg" }), intendedFingerprint({ data: "https://x/storage/v1/object/sign/spc-photos/spc/p.jpg?token=new", id: "p" }));
});

test("Supabase object errors retain all structured diagnostics and display readable text", () => {
  const error = { message: "permission denied", code: "42501", details: "journal", hint: "check policy", status: 403, statusCode: "403" };
  assert.deepEqual(supabaseErrorDetails(error), error);
  for (const value of Object.values(error)) assert.ok(formatSupabaseError(error).includes(String(value)));
  assert.doesNotMatch(formatSupabaseError(error), /\[object Object\]/);
  assert.equal(formatSupabaseError(new Error("RPC failed")), "RPC failed");
  assert.deepEqual(withSupabaseErrorContext(error, { action: "receivable-save", phase: "save", rpc: "spc_save_receivable_report" }), {
    ...error, action: "receivable-save", phase: "save", rpc: "spc_save_receivable_report",
  });
});

test("outbox verification requires the complete journal, photos, matching unit and payload", () => {
  const payload = { id: "j", content: "驗收", photos: [{ id: "p", data: "spc-storage://spc/p.jpg" }] };
  const entry: OfflineOutboxEntry = { id: "o", owner: "owner", kind: "unit-journal", recordId: "j", unitId: "u", operation: "complete", baseVersion: 1, updatedAt: "now", updatedBy: "owner", photoCount: 1, retries: 0, status: "pending", payload };
  const cloud = (record: unknown) => ({ projects: [{ id: "project", units: [{ id: "u", journals: [record] }] }] });
  assert.equal(outboxIsCommitted(entry, cloud({ ...payload, photos: [] })), false);
  assert.equal(outboxIsCommitted(entry, cloud(payload)), true);
  assert.equal(outboxIsCommitted({ ...entry, unitId: "other" }, cloud(payload)), false);
  assert.equal(outboxIsCommitted({ ...entry, payload: undefined }, cloud(payload)), false);
});

test("stale pending snapshot that already matches the loaded baseline never submits a SAVE", async () => {
  const h = setup(); h.setRemote(intended);
  await h.coordinator.run(intended, intended, 2, h.ports);
  assert.equal(h.stats().saves, 0);
});

test("40001 reloads and three-way rebases before retrying with the latest version", async () => {
  let time = 0, saves = 0;
  const original: Value = { journals: [{ id: "local", content: "old" }, { id: "remote", content: "old" }] };
  const local: Value = { journals: [{ id: "local", content: "local edit" }, { id: "remote", content: "old" }] };
  let remote = { version: 2, value: { journals: [{ id: "local", content: "old" }, { id: "remote", content: "remote edit" }] } };
  let durable: SyncAttempt<Value> | null = null;
  const versions: number[] = [];
  const coordinator = new SyncCoordinator<Value, typeof remote>("owner", () => time);
  const ports = {
    durable: async (attempt: SyncAttempt<Value>) => { durable = structuredClone(attempt); },
    upload: async (value: Value) => value,
    save: async (attempt: SyncAttempt<Value>) => {
      versions.push(attempt.version);
      if (++saves === 1) throw { code: "40001", message: "SPC_VERSION_CONFLICT" };
      remote = { version: 3, value: structuredClone(attempt.intended) };
      return 3;
    },
    load: async () => remote,
    value: (snapshot: typeof remote) => snapshot.value,
  };
  await assert.rejects(coordinator.run(original, local, 1, ports));
  assert.equal(coordinator.attempt?.version, 2);
  assert.equal(coordinator.attempt?.rebaseRequired, false);
  assert.deepEqual(coordinator.attempt?.intended, { journals: [{ id: "local", content: "local edit" }, { id: "remote", content: "remote edit" }] });
  assert.deepEqual((durable as SyncAttempt<Value> | null)?.base, remote.value);
  time = 15_000;
  await coordinator.run(original, local, 1, ports);
  assert.deepEqual(versions, [1, 2]);
  assert.equal(remote.version, 3);
});

test("40001 same-field conflict fails closed with the durable local attempt", async () => {
  let time = 0, saves = 0, conflictPaths: string[] = [];
  const original: Value = { journals: [{ id: "j", content: "old" }] };
  const local: Value = { journals: [{ id: "j", content: "local edit" }] };
  const remote = { version: 2, value: { journals: [{ id: "j", content: "remote edit" }] } };
  let durable: SyncAttempt<Value> | null = null;
  const coordinator = new SyncCoordinator<Value, typeof remote>("owner", () => time);
  const ports = {
    durable: async (attempt: SyncAttempt<Value>) => { durable = structuredClone(attempt); },
    upload: async (value: Value) => value,
    save: async () => { saves++; throw { code: "40001", message: "SPC_VERSION_CONFLICT" }; },
    load: async () => remote,
    value: (snapshot: typeof remote) => snapshot.value,
    conflict: (paths: string[]) => { conflictPaths = paths; },
  };
  await assert.rejects(coordinator.run(original, local, 1, ports), /同步衝突/);
  assert.equal(coordinator.state, "conflict");
  assert.equal(saves, 1);
  assert.deepEqual(coordinator.attempt?.base, original);
  assert.deepEqual(coordinator.attempt?.intended, local);
  assert.deepEqual((durable as SyncAttempt<Value> | null)?.intended, local);
  assert.deepEqual(conflictPaths, ["journals[j].content"]);
  time = 999_999;
  assert.equal(coordinator.canRetry(), false);
  await assert.rejects(coordinator.run(original, local, 1, ports));
  assert.equal(saves, 1);
});

test("57014 SAVE timeout is rollback-safe, durable, and never automatically retried", async () => {
  const h = setup();
  let attempts = 0;
  const ports = { ...h.ports, save: async (attempt: SyncAttempt<Value>) => {
    attempts++;
    if (attempts === 1) throw { code: "57014", message: "canceling statement due to statement timeout" };
    return h.ports.save(attempt);
  } };
  await assert.rejects(h.coordinator.run(base, intended, 1, ports));
  assert.equal(attempts, 1);
  assert.equal(h.coordinator.state, "timeout");
  assert.equal(h.coordinator.attempt?.submitted, false);
  assert.equal(h.coordinator.attempt?.rebaseRequired, false);
  assert.equal(h.coordinator.attempt?.manualRetryRequired, true);
  assert.deepEqual(h.durable()?.intended, intended);
  h.tick(999_999);
  assert.equal(h.coordinator.canRetry(), false);
  await assert.rejects(h.coordinator.run(base, intended, 1, ports));
  assert.equal(attempts, 1);
  h.coordinator.requestVerification();
  await h.coordinator.run(base, intended, 1, ports);
  assert.equal(attempts, 2);
});

test("57014 during committed verification stays submitted and retries verification only", async () => {
  const h = setup();
  let firstLoad = true;
  const ports = { ...h.ports, load: async () => {
    if (firstLoad) {
      firstLoad = false;
      throw { code: "57014", message: "canceling statement due to statement timeout" };
    }
    return h.ports.load();
  } };
  await assert.rejects(h.coordinator.run(base, intended, 1, ports));
  assert.equal(h.stats().saves, 1);
  assert.equal(h.coordinator.attempt?.submitted, true);
  assert.equal(h.coordinator.attempt?.manualRetryRequired, true);
  h.coordinator.requestVerification();
  await h.coordinator.run(base, intended, 1, ports);
  assert.equal(h.stats().saves, 1);
});
