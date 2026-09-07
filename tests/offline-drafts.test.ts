import test from "node:test";
import assert from "node:assert/strict";
import { saveOfflineDraft, queueOfflineWrite } from "../lib/offline-drafts.ts";

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
