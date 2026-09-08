import { uploadUnresolvedPhotos } from "./photo-persistence.ts";
import { supabase } from "./supabase";
import { readPhotoCleanupQueue, scopedStorageKey, writePhotoCleanupQueue } from "./auth-storage";
import { logStorageException } from "./storage-durability.ts";
import type { ExportProject, ReceivableReportMetadata } from "./acceptance-exports";
import type { ReceivableAcceptanceUpdate, ReceivableSaveResult } from "./finance-persistence.ts";
import { withSupabaseErrorContext, type SupabaseOperationContext } from "./supabase-error.ts";

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
export type FinanceExportProject = ExportProject & { id: string };
export type FinanceExportData = {
  canExportReceivables: boolean;
  canExportShipmentDetails: boolean;
  projects: FinanceExportProject[];
};
export type CreatedProjectResult<T = unknown> = { version: number; project: T };

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

export async function hydratePrivatePhotos<T>(value: T): Promise<T> {
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

export async function loadWorkspace(context: Pick<SupabaseOperationContext, "action" | "phase"> = { action: "workspace-load", phase: "load" }): Promise<WorkspaceSnapshot> {
  const { data, error } = await supabase.rpc("spc_load_workspace");
  if (error) throw withSupabaseErrorContext(error, { ...context, rpc: "spc_load_workspace" });
  const snapshot = (data || { version: 0, projects: [], catalog: [] }) as WorkspaceSnapshot;
  const activityResult = await supabase.rpc("spc_load_entity_activity");
  if (activityResult.error) throw withSupabaseErrorContext(activityResult.error, { ...context, rpc: "spc_load_entity_activity" });
  snapshot.activity = (activityResult.data || []) as EntityActivity[];
  try { return await hydratePrivatePhotos(snapshot); }
  catch (error) { throw withSupabaseErrorContext(error, { ...context, rpc: "storage.createSignedUrls" }); }
}

export async function loadWorkspaceVersion(): Promise<number> {
  const { data, error } = await supabase.rpc("spc_workspace_version");
  if (error) throw error; // Never fall back to downloading the workspace in a poll.
  if (!Number.isSafeInteger(Number(data)) || data === null) throw new Error("SPC_INVALID_WORKSPACE_VERSION");
  return Number(data);
}

export async function loadFinanceExportData(): Promise<FinanceExportData> {
  const { data, error } = await supabase.rpc("spc_load_finance_export_data");
  if (error) throw error;
  return (data || {
    canExportReceivables: false,
    canExportShipmentDetails: false,
    projects: [],
  }) as FinanceExportData;
}

export async function loadLegacyWorkspace() {
  const { data } = await supabase.from("spc_app_state").select("projects,catalog").eq("id", "main").maybeSingle();
  return data ? hydratePrivatePhotos(data as { projects: unknown[]; catalog: unknown[] }) : null;
}

export async function createProject<T>(project: T): Promise<CreatedProjectResult<T>> {
  const { data, error } = await supabase.rpc("spc_create_project", {
    p_project: serializePrivatePhotos(project),
  });
  if (error) throw error;
  return hydratePrivatePhotos(data as CreatedProjectResult<T>);
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
  if (error.code !== "42883" && error.code !== "PGRST202") throw withSupabaseErrorContext(error, { action: "workspace-save", phase: "save", rpc: "spc_merge_workspace" });
  const legacy = await supabase.rpc("spc_save_workspace", {
    p_expected_version: expectedVersion, p_projects: serializePrivatePhotos(projects), p_catalog: catalog,
  });
  if (legacy.error) throw withSupabaseErrorContext(legacy.error, { action: "workspace-save", phase: "save", rpc: "spc_save_workspace" });
  return Number(legacy.data);
}

export async function saveReceivableReport(input: {
  expectedVersion: number;
  projectId: string;
  yearMonth: string;
  report: ReceivableReportMetadata;
  acceptances: ReceivableAcceptanceUpdate[];
}): Promise<ReceivableSaveResult> {
  const { data, error } = await supabase.rpc("spc_save_receivable_report", {
    p_expected_version: input.expectedVersion,
    p_project_id: input.projectId,
    p_year_month: input.yearMonth,
    p_report: input.report,
    p_acceptance_updates: input.acceptances,
  });
  if (error) throw withSupabaseErrorContext(error, { action: "receivable-save", phase: "save", rpc: "spc_save_receivable_report" });
  return data as ReceivableSaveResult;
}

export async function uploadEmbeddedPhotos<T>(value: T, checkpoint?: (value: T) => Promise<void>): Promise<T> {
  return uploadUnresolvedPhotos(value, async (path, blob) => {
    const { error } = await supabase.storage.from("spc-photos").upload(path, blob, { contentType: blob.type, upsert: false });
    if (!error) return;
    if (String((error as { statusCode?: string }).statusCode) !== "409") throw error;
    const existing = await supabase.storage.from("spc-photos").download(path);
    if (existing.error) throw existing.error;
    const digest = async (content: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await content.arrayBuffer()))).join(",");
    if (await digest(existing.data) !== await digest(blob)) throw new Error("SPC_PHOTO_CONTENT_CONFLICT：既有照片不同，已保留來源並停止同步");
  }, checkpoint);
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

export async function cleanupRemovedPhotos(before: unknown, after: unknown, authenticatedUserId: string): Promise<number> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user || session.user.id !== authenticatedUserId) throw new Error("SPC_PHOTO_QUEUE_OWNER_MISMATCH");
  const oldPaths = storagePhotoPaths(before), livePaths = storagePhotoPaths(after);
  const queueKey = scopedStorageKey("spc-photo-cleanup-queue", authenticatedUserId);
  const queue = readPhotoCleanupQueue(localStorage, authenticatedUserId);
  const pending = queue.paths;
  const removed = [...new Set([...pending, ...[...oldPaths].filter((path) => !livePaths.has(path))])].filter((path) => !livePaths.has(path));
  writePhotoCleanupQueue(localStorage, { owner: authenticatedUserId, paths: removed });
  for (let i = 0; i < removed.length; i += 100) {
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    if (currentSession?.user.id !== authenticatedUserId) throw new Error("SPC_PHOTO_QUEUE_OWNER_MISMATCH");
    const { error } = await supabase.storage.from("spc-photos").remove(removed.slice(i, i + 100));
    if (error) throw error;
  }
  try { localStorage.removeItem(queueKey); }
  catch (error) { logStorageException("localStorage", "delete", error); }
  return removed.length;
}
