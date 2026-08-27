import test from "node:test";
import assert from "node:assert/strict";
import { migrateLegacyStorageValue, readPhotoCleanupQueue, scopedDraftKey, scopedStorageKey, writePhotoCleanupQueue } from "../lib/auth-storage.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("workspace and draft keys are isolated by verified user id", () => {
  assert.notEqual(scopedStorageKey("spc-workflow-v2", "A"), scopedStorageKey("spc-workflow-v2", "B"));
  assert.notEqual(scopedDraftKey("A", "survey", "unit-1"), scopedDraftKey("B", "survey", "unit-1"));
});

test("legacy person cache migrates once and cannot be copied to a second user", () => {
  const storage = new MemoryStorage();
  for (const key of ["spc-last-survey-person", "spc-last-crew", "spc-last-acceptance-person"]) {
    storage.setItem(key, `legacy:${key}`);
    assert.equal(migrateLegacyStorageValue(storage, key, "A"), `legacy:${key}`);
    assert.equal(migrateLegacyStorageValue(storage, key, "B"), null);
    assert.equal(storage.getItem(scopedStorageKey(key, "B")), null);
  }
});

test("user B cannot read or execute user A photo cleanup queue", () => {
  const storage = new MemoryStorage();
  writePhotoCleanupQueue(storage, { owner: "A", paths: ["spc/a.jpg"] });
  assert.deepEqual(readPhotoCleanupQueue(storage, "A").paths, ["spc/a.jpg"]);
  assert.deepEqual(readPhotoCleanupQueue(storage, "B").paths, []);
  assert.equal(storage.getItem("spc-photo-cleanup-queue"), null);
});
