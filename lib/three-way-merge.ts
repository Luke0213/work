export type MergeResult<T> = { value: T; conflicts: string[] };

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isEntityArray = (v: unknown): v is Array<Record<string, unknown> & { id: string }> =>
  Array.isArray(v) && v.every((x) => isRecord(x) && typeof x.id === "string");

function mergeNode(base: unknown, local: unknown, remote: unknown, path: string, conflicts: string[]): unknown {
  if (equal(local, remote)) return local;
  if (equal(local, base)) return remote;
  if (equal(remote, base)) return local;

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

  if (isRecord(local) && isRecord(remote) && (base === undefined || isRecord(base))) {
    const b = (base || {}) as Record<string, unknown>, result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(local), ...Object.keys(remote)])) {
      result[key] = mergeNode(b[key], local[key], remote[key], path ? `${path}.${key}` : key, conflicts);
    }
    return result;
  }

  conflicts.push(path || "workspace");
  return local;
}

export function threeWayMerge<T>(base: T, local: T, remote: T): MergeResult<T> {
  const conflicts: string[] = [];
  return { value: mergeNode(base, local, remote, "", conflicts) as T, conflicts };
}
