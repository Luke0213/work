export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const scopedStorageKey = (base: string, userId: string) => `${base}:${userId}`;
export const scopedDraftKey = (userId: string, kind: string, recordId: string) =>
  `spc-draft-${userId}-${kind}-${recordId}`;

export function migrateLegacyStorageValue(storage: StorageLike, legacyKey: string, userId: string): string | null {
  const target = scopedStorageKey(legacyKey, userId);
  const existing = storage.getItem(target);
  if (existing !== null) return existing;
  const legacy = storage.getItem(legacyKey);
  if (legacy === null) return null;
  storage.setItem(target, legacy);
  storage.removeItem(legacyKey);
  return legacy;
}

export type PhotoCleanupQueue = { owner: string; paths: string[] };

export function readPhotoCleanupQueue(storage: StorageLike, userId: string): PhotoCleanupQueue {
  try {
    const raw = storage.getItem(scopedStorageKey("spc-photo-cleanup-queue", userId));
    if (!raw) return { owner: userId, paths: [] };
    const parsed = JSON.parse(raw) as Partial<PhotoCleanupQueue>;
    if (parsed.owner !== userId || !Array.isArray(parsed.paths)) return { owner: userId, paths: [] };
    return { owner: userId, paths: parsed.paths.filter((path): path is string => typeof path === "string") };
  } catch {
    return { owner: userId, paths: [] };
  }
}

export function writePhotoCleanupQueue(storage: StorageLike, queue: PhotoCleanupQueue): void {
  storage.setItem(scopedStorageKey("spc-photo-cleanup-queue", queue.owner), JSON.stringify(queue));
}
