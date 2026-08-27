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
  status: "pending" | "syncing" | "failed" | "conflict";
  error?: string;
};

const databaseName = "spc-offline-v1";
const databaseVersion = 1;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("INDEXED_DB_UNAVAILABLE"));
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
    request.onerror = () => reject(request.error || new Error("INDEXED_DB_OPEN_FAILED"));
  });
}

async function transact<T>(storeName: "drafts" | "outbox", mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("INDEXED_DB_REQUEST_FAILED"));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error("INDEXED_DB_TRANSACTION_FAILED")); };
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

export async function clearOfflineOutbox(owner: string): Promise<void> {
  const entries = await listOfflineOutbox(owner);
  await Promise.all(entries.map((entry) => transact("outbox", "readwrite", (store) => store.delete(entry.id))));
  window.dispatchEvent(new CustomEvent("spc-offline-change"));
}

export async function offlineSummary(owner: string): Promise<{ pending: number; failed: number; conflicts: number; photos: number }> {
  const entries = await listOfflineOutbox(owner);
  return {
    pending: entries.filter((entry) => entry.status === "pending" || entry.status === "syncing").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    conflicts: entries.filter((entry) => entry.status === "conflict").length,
    photos: entries.reduce((sum, entry) => sum + entry.photoCount, 0),
  };
}
