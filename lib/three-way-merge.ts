export type MergeResult<T> = { value: T; conflicts: string[] };

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isEntityArray = (v: unknown): v is Array<Record<string, unknown> & { id: string }> =>
  Array.isArray(v) && v.every((x) => isRecord(x) && typeof x.id === "string");
const protectedCollections = new Set(["surveys", "works", "defects", "acceptances", "journals", "events", "floorAcceptances"]);
const collectionName = (path: string) => path.split(".").at(-1) || "";
const isDeleted = (value: unknown) => isRecord(value) && value._deleted === true;

export type EntityTombstone = { id: string; _deleted: true; deletedAt: string; deletedBy: string };

export function tombstoneEntity<T extends { id: string }>(entity: T, deletedBy: string, deletedAt = new Date().toISOString()): T & EntityTombstone {
  return { ...entity, _deleted: true, deletedAt, deletedBy };
}

export const isDeletedEntity = (entity: unknown): boolean => isDeleted(entity);
export const liveEntities = <T>(entities: T[]): T[] => entities.filter((entity) => !isDeleted(entity));

function protectedEntityArray(value: unknown): Array<Record<string, unknown> & { id: string }> {
  return isEntityArray(value) ? value : [];
}

function mergeNode(base: unknown, local: unknown, remote: unknown, path: string, conflicts: string[]): unknown {
  if (protectedCollections.has(collectionName(path))) {
    const bItems = protectedEntityArray(base), lItems = protectedEntityArray(local), rItems = protectedEntityArray(remote);
    const b = new Map(bItems.map((x) => [x.id, x])), l = new Map(lItems.map((x) => [x.id, x])), r = new Map(rItems.map((x) => [x.id, x]));
    const order = [...new Set([...lItems.map((x) => x.id), ...rItems.map((x) => x.id), ...bItems.map((x) => x.id)])];
    const result: unknown[] = [];
    for (const id of order) {
      const bv = b.get(id), lv = l.get(id), rv = r.get(id), itemPath = `${path}[${id}]`;
      const tombstone = [bv, lv, rv]
        .filter((value): value is Record<string, unknown> & { id: string } => isDeleted(value))
        .sort((a, z) => String(z.deletedAt || "").localeCompare(String(a.deletedAt || "")))[0];
      if (tombstone) { result.push(tombstone); continue; }
      if (lv && rv) result.push(mergeNode(bv, lv, rv, itemPath, conflicts));
      else if (lv) result.push(lv);
      else if (rv) result.push(rv);
      else if (bv) result.push(bv);
    }
    return result;
  }

  if (isRecord(local) && isRecord(remote) && (base === undefined || isRecord(base))) {
    const b = (base || {}) as Record<string, unknown>, result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(local), ...Object.keys(remote)])) {
      result[key] = mergeNode(b[key], local[key], remote[key], path ? `${path}.${key}` : key, conflicts);
    }
    return result;
  }

  if (isEntityArray(base) && isEntityArray(local) && isEntityArray(remote)) {
    const b = new Map(base.map((x) => [x.id, x])), l = new Map(local.map((x) => [x.id, x])), r = new Map(remote.map((x) => [x.id, x]));
    const order = [...new Set([...local.map((x) => x.id), ...remote.map((x) => x.id)])];
    const result: unknown[] = [];
    for (const id of order) {
      const bv = b.get(id), lv = l.get(id), rv = r.get(id), itemPath = `${path}[${id}]`;
      if (!lv && bv && rv) {
        if (!equal(rv, bv)) { conflicts.push(itemPath); result.push(rv); }
        continue;
      }
      if (!rv && bv && lv) {
        if (!equal(lv, bv)) { conflicts.push(itemPath); result.push(lv); }
        continue;
      }
      if (lv && rv) result.push(mergeNode(bv, lv, rv, itemPath, conflicts));
      else if (lv) result.push(lv);
      else if (rv) result.push(rv);
    }
    return result;
  }

  if (equal(local, remote)) return local;
  if (equal(local, base)) return remote;
  if (equal(remote, base)) return local;

  conflicts.push(path || "workspace");
  return local;
}

export function threeWayMerge<T>(base: T, local: T, remote: T): MergeResult<T> {
  const conflicts: string[] = [];
  return { value: mergeNode(base, local, remote, "", conflicts) as T, conflicts };
}
