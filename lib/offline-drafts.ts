import { intendedFingerprint } from "./sync-coordinator.ts";
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
  payload?: unknown;
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
    // A successful request can still be rolled back by its transaction.
    request.onerror = () => {
      const error = request.error || new Error("INDEXED_DB_REQUEST_FAILED");
      logStorageException("IndexedDB", mode === "readonly" ? "read" : "write", error);
      reject(error);
    };
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onabort = () => {
      const error = transaction.error || new Error("INDEXED_DB_TRANSACTION_ABORTED");
      db.close();
      logStorageException("IndexedDB", "transaction", error);
      reject(error);
    };
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
    if (typeof record.data === "string" && (record.data.startsWith("data:image/") || record.data.startsWith("spc-storage://") || record.data.includes("/storage/v1/object/"))) count += 1;
    Object.values(record).forEach(visit);
  };
  visit(value);
  return count;
}

const draftWrites = new Map<string, Promise<unknown>>();
export async function saveOfflineDraft<T>(draft: Omit<OfflineDraft<T>, "savedAt" | "photoCount">): Promise<OfflineDraft<T>> {
  const saved: OfflineDraft<T> = structuredClone({ ...draft, savedAt: new Date().toISOString(), photoCount: countPhotos(draft.payload) });
  const pending = (draftWrites.get(draft.key) || Promise.resolve()).catch(() => undefined)
    .then(() => transact("drafts", "readwrite", (store) => store.put(saved)));
  draftWrites.set(draft.key, pending);
  try { await pending; } finally { if (draftWrites.get(draft.key) === pending) draftWrites.delete(draft.key); }
  window.dispatchEvent(new CustomEvent("spc-offline-change"));
  return saved;
}

export async function loadOfflineDraft<T>(key: string, strict = false): Promise<OfflineDraft<T> | null> {
  try { return (await transact("drafts", "readonly", (store) => store.get(key))) as OfflineDraft<T> | null; }
  catch (error) { if (strict) throw error; return null; }
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

export async function completeSyncedOutbox(owner: string, committed: unknown): Promise<void> {
  const db = await openDatabase();
  const verifiedDrafts: Array<{ key: string; payload: unknown }> = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["drafts", "outbox"], "readwrite");
    const store = tx.objectStore("outbox"), drafts = tx.objectStore("drafts");
    const request = store.getAll();
    request.onsuccess = () => {
      const verified: OfflineOutboxEntry[] = [];
      for (const entry of request.result as OfflineOutboxEntry[]) {
        if (entry.owner === owner && outboxIsCommitted(entry, committed)) {
          if (entry.status !== "completed") store.put({ ...entry, status: "completed" });
          verified.push(entry);
        }
      }
      if (!verified.length) return;
      const currentDrafts = drafts.getAll();
      currentDrafts.onsuccess = () => {
        for (const draft of currentDrafts.result as OfflineDraft[]) {
          const entry = verified.find((candidate) => unitJournalDraftMatches(draft, candidate));
          if (entry) {
            drafts.delete(draft.key);
            verifiedDrafts.push({ key: draft.key, payload: entry.payload });
          }
        }
      };
    };
    tx.oncomplete = () => {
      db.close();
      // Small journal drafts may also have an exact localStorage copy. Remove
      // only that same verified payload; IndexedDB marker fallbacks are harmless
      // once their exact active draft is absent and must not race newer writes.
      for (const verified of verifiedDrafts) {
        try {
          const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(verified.key);
          if (raw && intendedFingerprint(JSON.parse(raw)) === intendedFingerprint(verified.payload)) localStorage.removeItem(verified.key);
        } catch (error) { logStorageException("localStorage", "delete", error); }
      }
      resolve();
    };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error("OUTBOX_ACK_FAILED")); };
  });
  // Keep verified outbox entries as recovery evidence. No account-wide purge.
  window.dispatchEvent(new CustomEvent("spc-offline-change"));
}

export function unitJournalDraftMatches(draft: OfflineDraft, entry: OfflineOutboxEntry): boolean {
  if (draft.owner !== entry.owner || draft.kind !== "unit-journal" || entry.kind !== "unit-journal") return false;
  if (draft.unitId !== entry.unitId || draft.recordId !== entry.recordId || !entry.payload) return false;
  const payloadId = (entry.payload as { id?: unknown } | null)?.id;
  return payloadId === entry.recordId && intendedFingerprint(draft.payload) === intendedFingerprint(entry.payload);
}

export function outboxIsCommitted(entry: OfflineOutboxEntry, committed: unknown): boolean {
  if (!entry.payload || !committed || typeof committed !== "object") return false;
  const projects = (committed as { projects?: Array<{ id: string; units?: Array<{ id: string; journals?: unknown[] }> }> }).projects || [];
  if (entry.kind !== "unit-journal") return false; // Unknown legacy entries require explicit reconciliation.
  if ((entry.payload as { id?: unknown } | null)?.id !== entry.recordId) return false;
  for (const project of projects) for (const unit of project.units || []) {
    if (unit.id !== entry.unitId) continue;
    const record = unit.journals?.find((journal) => (journal as { id?: string }).id === entry.recordId);
    if (record && intendedFingerprint(entry.payload) === intendedFingerprint(record)) return true;
  }
  return false;
}

/** Replace only the exact uploaded photo content, retaining newer edits and owner isolation. */
export function promotePhotoReferences<T>(value: T, source: unknown, uploaded: unknown): T {
  const originals = new Map<string, string>();
  const refs = new Map<string, string>();
  const visit = (node: unknown, action: (record: Record<string, unknown>) => void) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((item) => visit(item, action)); return; }
    action(node as Record<string, unknown>);
    Object.values(node).forEach((item) => visit(item, action));
  };
  visit(source, (r) => { if (typeof r.id === "string" && typeof r.data === "string") originals.set(r.id, r.data); });
  visit(uploaded, (r) => { if (typeof r.id === "string" && typeof r.data === "string" && r.data.startsWith("spc-storage://")) refs.set(r.id, r.data); });
  const result = structuredClone(value);
  visit(result, (r) => { if (typeof r.id === "string" && r.data === originals.get(r.id) && refs.has(r.id)) r.data = refs.get(r.id)!; });
  return result;
}

export async function checkpointDraftPhotos(owner: string, source: unknown, uploaded: unknown): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["drafts", "outbox"], "readwrite");
    for (const name of ["drafts", "outbox"]) {
      const store = tx.objectStore(name);
      const request = store.getAll();
      request.onsuccess = () => {
        for (const entry of request.result as Array<OfflineDraft | OfflineOutboxEntry>) {
          if (entry.owner === owner && entry.kind !== "sync-attempt" && entry.payload) {
            store.put({ ...entry, payload: promotePhotoReferences(entry.payload, source, uploaded) });
          }
        }
      };
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error("PHOTO_CHECKPOINT_FAILED")); };
  });
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
