import test from "node:test";
import assert from "node:assert/strict";
import { completedOutboxEntries, syncableOutboxEntries, type OfflineOutboxEntry } from "../lib/offline-drafts.ts";
import { containsEmbeddedPhoto, durableStorageState, isIndexedDbMarker, localDraftValue, shouldAttemptCloudSave, shouldRestoreIndexedDbDraft, storageErrorDetails } from "../lib/storage-durability.ts";

const entry = (status: OfflineOutboxEntry["status"]): OfflineOutboxEntry => ({
  id: status,
  owner: "user-1",
  kind: "acceptance",
  recordId: status,
  unitId: "unit-1",
  operation: "upsert",
  baseVersion: 1,
  updatedAt: "2026-08-28T00:00:00.000Z",
  updatedBy: "user-1",
  photoCount: 1,
  retries: 0,
  status,
});

test("localStorage quota error is safe when IndexedDB succeeds", () => {
  assert.deepEqual(durableStorageState(true, false), {
    saved: true,
    fallbackOnly: true,
    message: "已使用離線儲存保存",
  });
  assert.equal(durableStorageState(false, false).message, "本機離線儲存初始化失敗，請重新整理或聯絡管理員");
});

test("storage failures are classified by their real DOMException name", () => {
  const failure = (name: string) => storageErrorDetails("localStorage", "write", new DOMException(name, name));
  assert.equal(durableStorageState(false, false, [failure("QuotaExceededError")]).message, "本機儲存空間不足");
  assert.equal(durableStorageState(false, false, [failure("SecurityError")]).message, "瀏覽器阻止本機儲存");
  assert.equal(durableStorageState(false, false, [failure("InvalidStateError")]).message, "IndexedDB 尚未可用或資料庫狀態異常");
  for (const name of ["VersionError", "AbortError", "UnknownError"])
    assert.equal(durableStorageState(false, false, [failure(name)]).message, "本機離線儲存初始化失敗，請重新整理或聯絡管理員");
});

test("local cache failure never blocks an online cloud save", () => {
  assert.equal(durableStorageState(false, false).saved, false);
  assert.equal(shouldAttemptCloudSave(true, false, true), true);
  assert.equal(shouldAttemptCloudSave(false, false, true), false);
  assert.equal(shouldAttemptCloudSave(true, false, false), false);
});

test("storage diagnostics redact payloads and credentials", () => {
  const details = storageErrorDetails("IndexedDB", "write", new DOMException(
    "token=secret Authorization:Bearer-secret data:image/jpeg;base64,ABCDEF password=hunter2",
    "UnknownError",
  ));
  const logged = JSON.stringify(details);
  assert.doesNotMatch(logged, /ABCDEF|Bearer-secret|hunter2|token=secret/);
  assert.match(logged, /embedded-image-redacted|redacted/);
});

test("embedded photos stay out of localStorage while pending IndexedDB data is retained", () => {
  const pending = { id: "draft-1", photos: [{ id: "photo-1", data: "data:image/jpeg;base64,large-payload" }] };
  assert.equal(containsEmbeddedPhoto(pending), true);
  const fallback = localDraftValue(pending);
  assert.equal(fallback.includes("large-payload"), false);
  assert.equal(isIndexedDbMarker(JSON.parse(fallback)), true);
  assert.equal(shouldRestoreIndexedDbDraft(fallback), true);
  const restored = shouldRestoreIndexedDbDraft(fallback) ? pending : null;
  assert.equal(restored?.photos[0]?.data, "data:image/jpeg;base64,large-payload");
});

test("small text drafts retain a local compatibility fallback", () => {
  const fallback = localDraftValue({ id: "draft-2", note: "尚未同步文字" });
  assert.equal(isIndexedDbMarker(JSON.parse(fallback)), false);
  assert.equal(shouldRestoreIndexedDbDraft(fallback), false);
  assert.match(fallback, /尚未同步文字/);
});

test("missing or malformed local draft safely falls back to IndexedDB", () => {
  assert.equal(shouldRestoreIndexedDbDraft(""), true);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try { assert.equal(shouldRestoreIndexedDbDraft("{invalid-json"), true); }
  finally { console.warn = originalWarn; }
});

test("only completed outbox records are cleaned and unsynced records remain", () => {
  const entries = [entry("completed"), entry("pending"), entry("failed"), entry("conflict")];
  assert.deepEqual(completedOutboxEntries(entries).map((item) => item.status), ["completed"]);
  assert.deepEqual(syncableOutboxEntries(entries).map((item) => item.status), ["pending"]);
  assert.deepEqual(entries.filter((item) => !completedOutboxEntries(entries).includes(item)).map((item) => item.status), ["pending", "failed", "conflict"]);
});
