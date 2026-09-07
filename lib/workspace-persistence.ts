import { isProtectedEntityCollection } from "./three-way-merge.ts";

const storageScheme = "spc-storage://";
const storageMarkers = [
  "/storage/v1/object/public/spc-photos/",
  "/storage/v1/object/sign/spc-photos/",
] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const isEntityArray = (value: unknown): value is Array<Record<string, unknown> & { id: string }> =>
  Array.isArray(value) && value.every((item) => record(item) && typeof item.id === "string");
const isNonEmptyEntityArray = (value: unknown): value is Array<Record<string, unknown> & { id: string }> =>
  isEntityArray(value) && value.length > 0;

function photoReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith(storageScheme)) return value.slice(storageScheme.length);
  for (const marker of storageMarkers) {
    const index = value.indexOf(marker);
    if (index >= 0) return decodeURIComponent(value.slice(index + marker.length).split("?")[0]);
  }
  return null;
}

function changedValueIsCommitted(base: unknown, intended: unknown, committed: unknown, path = ""): boolean {
  if (equal(base, intended)) return true;

  // loadWorkspace renews signed URLs. A photo reference is committed when its
  // private Storage path is the same; query tokens and URL form are not data.
  if (path.split(".").at(-1) === "data") {
    const intendedPhoto = photoReference(intended);
    const committedPhoto = photoReference(committed);
    if (intendedPhoto !== null || committedPhoto !== null) {
      return intendedPhoto !== null && intendedPhoto === committedPhoto;
    }
  }

  if (isNonEmptyEntityArray(intended) || (Array.isArray(intended) && intended.length === 0 && isNonEmptyEntityArray(base))) {
    if (!Array.isArray(committed)) return false;
    const baseById = new Map(isEntityArray(base) ? base.map((item) => [item.id, item]) : []);
    const committedById = new Map(isEntityArray(committed) ? committed.map((item) => [item.id, item]) : []);
    const intendedIds = new Set(intended.map((item) => item.id));
    const changedItemsAreCommitted = intended.every((item) => changedValueIsCommitted(
      baseById.get(item.id),
      item,
      committedById.get(item.id),
      `${path}[${item.id}]`,
    ));
    if (!changedItemsAreCommitted || isProtectedEntityCollection(path)) return changedItemsAreCommitted;
    return [...baseById.keys()]
      .filter((id) => !intendedIds.has(id))
      .every((id) => !committedById.has(id));
  }

  if (record(intended)) {
    if (!record(committed) || (committed._deleted === true && intended._deleted !== true)) return false;
    const baseRecord = record(base) ? base : {};
    return [...new Set([...Object.keys(baseRecord), ...Object.keys(intended)])]
      .every((childKey) => changedValueIsCommitted(
        baseRecord[childKey],
        intended[childKey],
        committed[childKey],
        path ? `${path}.${childKey}` : childKey,
      ));
  }

  return equal(intended, committed);
}

/**
 * Verifies only the local delta from base to intended against a post-save reload.
 * Concurrent committed changes outside that delta are deliberately ignored.
 */
export function containsWorkspaceChanges(base: unknown, intended: unknown, committed: unknown): boolean {
  return changedValueIsCommitted(base, intended, committed);
}

export const workspaceSyncError =
  "尚未完成 Supabase 同步／請勿關閉頁面：雲端尚未確認本次修改";
