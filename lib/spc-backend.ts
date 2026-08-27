import { supabase } from "./supabase";

export type EntityActivity = {
  entityType: string;
  entityId: string;
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedByEmail: string | null;
  updatedAt: string;
};
export type WorkspaceSnapshot = { version: number; projects: unknown[]; catalog: unknown[]; activity?: EntityActivity[] };

const storageScheme = "spc-storage://";

function photoPath(value: string): string | null {
  if (value.startsWith(storageScheme)) return value.slice(storageScheme.length);
  for (const marker of [
    "/storage/v1/object/public/spc-photos/",
    "/storage/v1/object/sign/spc-photos/",
  ]) {
    const index = value.indexOf(marker);
    if (index >= 0) return decodeURIComponent(value.slice(index + marker.length).split("?")[0]);
  }
  return null;
}

async function hydratePrivatePhotos<T>(value: T): Promise<T> {
  const cloned = structuredClone(value) as unknown;
  const records: Array<Record<string, unknown>> = [];
  const paths = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.data === "string") {
      const path = photoPath(record.data);
      if (path) { records.push(record); paths.add(path); }
    }
    Object.values(record).forEach(visit);
  };
  visit(cloned);
  if (!paths.size) return cloned as T;
  const { data, error } = await supabase.storage.from("spc-photos").createSignedUrls([...paths], 60 * 60);
  if (error) throw error;
  const signed = new Map((data || []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
  for (const record of records) {
    const path = photoPath(String(record.data));
    if (path && signed.has(path)) record.data = signed.get(path)!;
  }
  return cloned as T;
}

function serializePrivatePhotos<T>(value: T): T {
  const cloned = structuredClone(value) as unknown;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.data === "string") {
      const path = photoPath(record.data);
      if (path) record.data = `${storageScheme}${path}`;
    }
    Object.values(record).forEach(visit);
  };
  visit(cloned);
  return cloned as T;
}

export async function loadWorkspace(): Promise<WorkspaceSnapshot> {
  const { data, error } = await supabase.rpc("spc_load_workspace");
  if (error) throw error;
  const snapshot = (data || { version: 0, projects: [], catalog: [] }) as WorkspaceSnapshot;
  const { data: activity } = await supabase.rpc("spc_load_entity_activity");
  snapshot.activity = (activity || []) as EntityActivity[];
  return hydratePrivatePhotos(snapshot);
}

export async function loadLegacyWorkspace() {
  const { data } = await supabase.from("spc_app_state").select("projects,catalog").eq("id", "main").maybeSingle();
  return data ? hydratePrivatePhotos(data as { projects: unknown[]; catalog: unknown[] }) : null;
}

export async function saveWorkspace(
  expectedVersion: number,
  projects: unknown[],
  catalog: unknown[],
  baseProjects: unknown[] = projects,
  baseCatalog: unknown[] = catalog,
) {
  const payload = {
    p_base_version: expectedVersion,
    p_base_projects: serializePrivatePhotos(baseProjects),
    p_projects: serializePrivatePhotos(projects),
    p_base_catalog: baseCatalog,
    p_catalog: catalog,
  };
  const { data, error } = await supabase.rpc("spc_merge_workspace", payload);
  if (!error) return Number((data as { version?: number } | null)?.version ?? data);
  if (!error.message.includes("spc_merge_workspace")) throw error;
  const legacy = await supabase.rpc("spc_save_workspace", {
    p_expected_version: expectedVersion, p_projects: serializePrivatePhotos(projects), p_catalog: catalog,
  });
  if (legacy.error) throw legacy.error;
  return Number(legacy.data);
}

function extension(type: string) {
  return type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
}

export async function uploadEmbeddedPhotos<T>(value: T): Promise<T> {
  const cloned = structuredClone(value) as unknown;
  const visit = async (node: unknown): Promise<void> => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) await visit(item); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.data === "string" && record.data.startsWith("data:image/")) {
      const blob = await (await fetch(record.data)).blob();
      if (blob.size > 10 * 1024 * 1024) throw new Error("單張照片不可超過 10MB");
      const path = `spc/${record.id}.${extension(blob.type)}`;
      const { error } = await supabase.storage.from("spc-photos").upload(path, blob, { contentType: blob.type, upsert: true });
      if (error) throw error;
      const { data: signed, error: signedError } = await supabase.storage.from("spc-photos").createSignedUrl(path, 60 * 60);
      if (signedError) throw signedError;
      record.data = signed.signedUrl;
    }
    for (const child of Object.values(record)) await visit(child);
  };
  await visit(cloned);
  return cloned as T;
}

export function storagePhotoPaths(value: unknown): Set<string> {
  const paths = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.data === "string") {
      const path = photoPath(record.data);
      if (path) paths.add(path);
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return paths;
}

export async function cleanupRemovedPhotos(before: unknown, after: unknown): Promise<number> {
  const oldPaths = storagePhotoPaths(before), livePaths = storagePhotoPaths(after);
  const queueKey = "spc-photo-cleanup-queue";
  let pending: string[] = [];
  try { pending = JSON.parse(localStorage.getItem(queueKey) || "[]") as string[]; } catch { pending = []; }
  const removed = [...new Set([...pending, ...[...oldPaths].filter((path) => !livePaths.has(path))])].filter((path) => !livePaths.has(path));
  localStorage.setItem(queueKey, JSON.stringify(removed));
  for (let i = 0; i < removed.length; i += 100) {
    const { error } = await supabase.storage.from("spc-photos").remove(removed.slice(i, i + 100));
    if (error) throw error;
  }
  localStorage.removeItem(queueKey);
  return removed.length;
}
