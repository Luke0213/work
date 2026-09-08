import test from "node:test";
import assert from "node:assert/strict";
import { saveOfflineDraft, queueOfflineWrite, loadOfflineDraft, listOfflineOutbox, completeSyncedOutbox, checkpointDraftPhotos } from "../lib/offline-drafts.ts";

test("IndexedDB request success is not durable success; complete resolves, abort rejects", async (t) => {
  const original = ["indexedDB", "window"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  t.after(() => { for (const [name, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  for (const operation of ["draft", "queue"]) for (const abort of [false, true]) {
    const request: any = { result: "ok" };
    const transaction: any = { objectStore: () => ({ put: () => request }) };
    const db = { transaction: () => transaction, close: () => {} };
    t.mock.method(console, "warn", () => {});
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open: () => {
      const opened: any = { result: db };
      queueMicrotask(() => opened.onsuccess());
      return opened;
    } } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: () => true } });
    let settled = false;
    const pending = operation === "draft"
      ? saveOfflineDraft({ key: "k", owner: "o", kind: "unit-journal", recordId: "j", unitId: "u", payload: {}, baseVersion: 0, updatedBy: "o" })
      : queueOfflineWrite({ owner: "o", kind: "unit-journal", recordId: "j", unitId: "u", operation: "upsert", baseVersion: 0, updatedBy: "o" });
    const observed = pending.then(() => { settled = true; return "ok"; }, () => { settled = true; return "failed"; });
    await new Promise((resolve) => setImmediate(resolve));
    request.onsuccess?.();
    await Promise.resolve();
    assert.equal(settled, false);
    if (abort) transaction.onabort(); else transaction.oncomplete();
    assert.equal(await observed, abort ? "failed" : "ok");
    t.mock.restoreAll();
  }
});

test("cloud acknowledgement removes only the exact verified active journal draft", async (t) => {
  const original = ["indexedDB", "window", "localStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  t.after(() => { for (const [name, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  const stores = { drafts: new Map<string, any>(), outbox: new Map<string, any>() };
  const db = {
    close: () => {},
    transaction: () => {
      let pending = 0;
      const tx: any = { objectStore: (name: "drafts" | "outbox") => {
        const request = (action: () => unknown) => {
          pending++;
          const req: any = {};
          queueMicrotask(() => {
            req.result = structuredClone(action()); req.onsuccess?.(); pending--;
            setImmediate(() => { if (pending === 0) tx.oncomplete?.(); });
          });
          return req;
        };
        return {
          put: (value: any) => request(() => { stores[name].set(value.key || value.id, structuredClone(value)); return value.key || value.id; }),
          get: (key: string) => request(() => stores[name].get(key)),
          getAll: () => request(() => [...stores[name].values()]),
          delete: (key: string) => request(() => stores[name].delete(key)),
        };
      } };
      return tx;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open: () => {
    const req: any = { result: db }; queueMicrotask(() => req.onsuccess()); return req;
  } } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: () => true } });
  const local = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  } });
  const source = { id: "journal", content: "驗收", photos: [{ id: "photo", data: "data:image/png;base64,YQ==" }] };
  const uploaded = { ...source, photos: [{ id: "photo", data: "spc-storage://spc/photo.png" }] };
  for (const owner of ["a", "b"]) {
    await saveOfflineDraft({ owner, key: `spc-draft-${owner}-unit-journal-unit`, kind: "unit-journal", recordId: "journal", unitId: "unit", payload: source, baseVersion: 1, updatedBy: owner });
    await queueOfflineWrite({ owner, kind: "unit-journal", recordId: "journal", unitId: "unit", operation: "complete", payload: source, baseVersion: 1, updatedBy: owner });
  }
  await checkpointDraftPhotos("a", source, uploaded);
  local.set("spc-draft-a-unit-journal-unit", JSON.stringify(uploaded));
  assert.deepEqual((await loadOfflineDraft("spc-draft-a-unit-journal-unit"))?.payload, uploaded);
  assert.deepEqual((await loadOfflineDraft("spc-draft-b-unit-journal-unit"))?.payload, source);
  const cloud = (record: unknown) => ({ projects: [{ id: "project", units: [{ id: "unit", journals: [record] }] }] });
  await completeSyncedOutbox("a", { projects: [] });
  assert.equal((await listOfflineOutbox("a"))[0].status, "pending");
  assert.ok(await loadOfflineDraft("spc-draft-a-unit-journal-unit"));
  await completeSyncedOutbox("a", { projects: [{ id: "project", units: [{ id: "unit", journals: [{ ...uploaded, photos: [{ id: "photo", data: "https://example.test/storage/v1/object/sign/spc-photos/spc/photo.png?token=renewed" }] }] }] }] });
  assert.equal((await listOfflineOutbox("a"))[0].status, "completed");
  assert.equal((await listOfflineOutbox("b"))[0].status, "pending");
  assert.equal(await loadOfflineDraft("spc-draft-a-unit-journal-unit"), undefined);
  assert.equal(local.has("spc-draft-a-unit-journal-unit"), false);
  assert.ok(await loadOfflineDraft("spc-draft-b-unit-journal-unit"));

  const older = { ...uploaded, id: "journal-newer" };
  const newer = { ...older, content: "newer unsaved edit" };
  await saveOfflineDraft({ owner: "a", key: "newer", kind: "unit-journal", recordId: older.id, unitId: "unit", payload: newer, baseVersion: 1, updatedBy: "a" });
  local.set("newer", JSON.stringify(newer));
  await queueOfflineWrite({ owner: "a", kind: "unit-journal", recordId: older.id, unitId: "unit", operation: "complete", payload: older, baseVersion: 1, updatedBy: "a" });
  await completeSyncedOutbox("a", cloud(older));
  assert.deepEqual((await loadOfflineDraft<typeof newer>("newer"))?.payload, newer);
  assert.deepEqual(JSON.parse(local.get("newer") || "null"), newer);

  const otherRecord = { ...uploaded, id: "other-record" };
  await saveOfflineDraft({ owner: "a", key: "other", kind: "unit-journal", recordId: otherRecord.id, unitId: "other-unit", payload: otherRecord, baseVersion: 1, updatedBy: "a" });
  await queueOfflineWrite({ owner: "a", kind: "unit-journal", recordId: "journal-verified", unitId: "unit", operation: "complete", payload: { ...uploaded, id: "journal-verified" }, baseVersion: 1, updatedBy: "a" });
  await completeSyncedOutbox("a", cloud({ ...uploaded, id: "journal-verified" }));
  assert.ok(await loadOfflineDraft("other"));

  const legacyCompleted = { ...uploaded, id: "legacy-completed" };
  await saveOfflineDraft({ owner: "a", key: "legacy-completed", kind: "unit-journal", recordId: legacyCompleted.id, unitId: "unit", payload: legacyCompleted, baseVersion: 1, updatedBy: "a" });
  const legacyEntry = await queueOfflineWrite({ owner: "a", kind: "unit-journal", recordId: legacyCompleted.id, unitId: "unit", operation: "complete", payload: legacyCompleted, baseVersion: 1, updatedBy: "a" });
  stores.outbox.set(legacyEntry.id, { ...stores.outbox.get(legacyEntry.id), status: "completed" });
  await completeSyncedOutbox("a", cloud(legacyCompleted));
  assert.equal(await loadOfflineDraft("legacy-completed"), undefined);
});
