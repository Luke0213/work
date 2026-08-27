export type OfflineDraft<T = unknown> = {
  key: string;
  owner: string;
  kind: string;
  recordId: string;
  unitId: string;
  payload: T;
  savedAt: string;
  baseVersion: number;
  updatedBy: string;
  photoCount: number;
};

export type OfflineOutboxEntry = {
  id: string;
  owner: string;
  kind: string;
  recordId: string;
  unitId: string;
  operation: "upsert" | "complete" | "delete";
  baseVersion: number;
  updatedAt: string;
  updatedBy: string;
  photoCount: number;
  retries: number;
  status: "pending" | "syncing" | "failed" | "conflict" | "completed";
  error?: string;
};

const databaseName = "spc-offline-v1";
const databaseVersion = 1;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    const error = new DOMException("IndexedDB is unavailable", "InvalidStateError");
    logStorageException("IndexedDB", "open", error);
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "key" });
      if (!db.objectStoreNames.contains("outbox")) {
        const store = db.createObjectStore("outbox", { keyPath: "id" });
        store.createIndex("owner", "owner", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const error = request.error || new Error("INDEXED_DB_OPEN_FAILED");
      logStorageException("IndexedDB", "open", error);
      reject(error);
    };
    request.onblocked = () => {
      const error = new DOMException("IndexedDB upgrade is blocked", "InvalidStateError");
      logStorageException("IndexedDB", "open", error);
      reject(error);
    };
  });
}

async function transact<T>(storeName: "drafts" | "outbox", mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest<T>;
    try {
      transaction = db.transaction(storeName, mode);
      request = action(transaction.objectStore(storeName));
    } catch (error) {
      db.close();
      logStorageException("IndexedDB", "transaction", error);
      reject(error);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const error = request.error || new Error("INDEXED_DB_REQUEST_FAILED");
      logStorageException("IndexedDB", mode === "readonly" ? "read" : "write", error);
      reject(error);
    };
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      const error = transaction.error || new Error("INDEXED_DB_TRANSACTION_FAILED");
      db.close();
      logStorageException("IndexedDB", "transaction", error);
      reject(error);
    };
  });
}

function countPhotos(value: unknown): number {
  let count = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.data === "string" && record.data.startsWith("data:image/")) count += 1;
    Object.values(record).forEach(visit);
  };
  visit(value);
  return count;
}

export async function saveOfflineDraft<T>(draft: Omit<OfflineDraft<T>, "savedAt" | "photoCount">): Promise<OfflineDraft<T>> {
  const saved: OfflineDraft<T> = { ...draft, savedAt: new Date().toISOString(), photoCount: countPhotos(draft.payload) };
  await transact("drafts", "readwrite", (store) => store.put(saved));
  window.dispatchEvent(new CustomEvent("spc-offline-change"));
  return saved;
}

export async function loadOfflineDraft<T>(key: string): Promise<OfflineDraft<T> | null> {
  try { return (await transact("drafts", "readonly", (store) => store.get(key))) as OfflineDraft<T> | null; }
  catch { return null; }
}

export async function removeOfflineDraft(key: string): Promise<void> {
  try { await transact("drafts", "readwrite", (store) => store.delete(key)); window.dispatchEvent(new CustomEvent("spc-offline-change")); }
  catch { /* localStorage fallback remains available */ }
}

export async function queueOfflineWrite(input: Omit<OfflineOutboxEntry, "id" | "updatedAt" | "photoCount" | "retries" | "status"> & { payload?: unknown }): Promise<OfflineOutboxEntry> {
  const entry: OfflineOutboxEntry = {
    ...input,
    id: `${input.owner}:${input.kind}:${input.recordId}:${input.operation}`,
    updatedAt: new Date().toISOString(),
    photoCount: countPhotos(input.payload),
    retries: 0,
    status: "pending",
  };
  await transact("outbox", "readwrite", (store) => store.put(entry));
  window.dispatchEvent(new CustomEvent("spc-offline-change"));
  return entry;
}

export async function listOfflineOutbox(owner: string): Promise<OfflineOutboxEntry[]> {
  try {
    const all = (await transact("outbox", "readonly", (store) => store.getAll())) as OfflineOutboxEntry[];
    return all.filter((entry) => entry.owner === owner).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  } catch { return []; }
}

export async function updateOfflineOutbox(id: string, change: Partial<OfflineOutboxEntry>): Promise<void> {
  const current = (await transact("outbox", "readonly", (store) => store.get(id))) as OfflineOutboxEntry | undefined;
  if (!current) return;
  await transact("outbox", "readwrite", (store) => store.put({ ...current, ...change }));
  window.dispatchEvent(new CustomEvent("spc-offline-change"));
}

export const completedOutboxEntries = (entries: OfflineOutboxEntry[]) =>
  entries.filter((entry) => entry.status === "completed");

export const syncableOutboxEntries = (entries: OfflineOutboxEntry[]) =>
  entries.filter((entry) => entry.status === "pending" || entry.status === "syncing");

export async function clearOfflineOutbox(owner: string): Promise<void> {
  const entries = await listOfflineOutbox(owner);
  const completed = completedOutboxEntries(entries);
  await Promise.all(completed.map((entry) => transact("outbox", "readwrite", (store) => store.delete(entry.id))));
  window.dispatchEvent(new CustomEvent("spc-offline-change"));
}

export async function completeSyncedOutbox(owner: string): Promise<void> {
  const entries = await listOfflineOutbox(owner);
  const synced = syncableOutboxEntries(entries);
  await Promise.all(synced.map((entry) => transact("outbox", "readwrite", (store) => store.put({ ...entry, status: "completed" }))));
  await clearOfflineOutbox(owner);
}

export async function offlineSummary(owner: string): Promise<{ pending: number; failed: number; conflicts: number; photos: number }> {
  const entries = await listOfflineOutbox(owner);
  return {
    pending: entries.filter((entry) => entry.status === "pending" || entry.status === "syncing").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    conflicts: entries.filter((entry) => entry.status === "conflict").length,
    photos: entries.filter((entry) => entry.status !== "completed").reduce((sum, entry) => sum + entry.photoCount, 0),
  };
}

export async function storageDiagnostics(owner: string): Promise<{
  usage: number | null;
  quota: number | null;
  localStorageBytes: number;
  drafts: number;
  outbox: number;
  pendingPhotos: number;
}> {
  const estimate = typeof navigator !== "undefined" && navigator.storage?.estimate
    ? await navigator.storage.estimate().catch((error) => { logStorageException("IndexedDB", "read", error); return {}; })
    : {};
  let localStorageBytes = 0;
  if (typeof localStorage !== "undefined") {
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index) || "";
        if (!key.startsWith("spc-") || (!key.includes(owner) && key.includes(":"))) continue;
        localStorageBytes += (key.length + (localStorage.getItem(key)?.length || 0)) * 2;
      }
    } catch (error) { logStorageException("localStorage", "read", error); }
  }
  let drafts: OfflineDraft[] = [];
  try {
    const all = (await transact("drafts", "readonly", (store) => store.getAll())) as OfflineDraft[];
    drafts = all.filter((entry) => entry.owner === owner);
  } catch { /* diagnostics must not affect saving */ }
  const outbox = await listOfflineOutbox(owner);
  return {
    usage: typeof estimate.usage === "number" ? estimate.usage : null,
    quota: typeof estimate.quota === "number" ? estimate.quota : null,
    localStorageBytes,
    drafts: drafts.length,
    outbox: outbox.filter((entry) => entry.status !== "completed").length,
    pendingPhotos: drafts.reduce((sum, entry) => sum + entry.photoCount, 0)
      + outbox.filter((entry) => entry.status !== "completed").reduce((sum, entry) => sum + entry.photoCount, 0),
  };
}
import { logStorageException } from "./storage-durability.ts";
