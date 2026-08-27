const markerKey = "__spcIndexedDb";

export type StorageLayer = "localStorage" | "IndexedDB";
export type StorageOperation = "read" | "write" | "open" | "transaction" | "delete";
export type StorageErrorDetails = {
  layer: StorageLayer;
  operation: StorageOperation;
  name: string;
  message: string;
  code: number | null;
};

const safeErrorMessage = (value: unknown) => {
  const message = typeof value === "string" ? value : "Storage operation failed";
  return message
    .replace(/data:image\/[^;\s]+;base64,[a-z0-9+/=]+/gi, "[embedded-image-redacted]")
    .replace(/(authorization|token|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 240);
};

export function storageErrorDetails(layer: StorageLayer, operation: StorageOperation, error: unknown): StorageErrorDetails {
  const candidate = error && typeof error === "object" ? error as { name?: unknown; message?: unknown; code?: unknown } : {};
  return {
    layer,
    operation,
    name: typeof candidate.name === "string" ? candidate.name : "Error",
    message: safeErrorMessage(candidate.message),
    code: typeof candidate.code === "number" ? candidate.code : null,
  };
}

export function logStorageException(layer: StorageLayer, operation: StorageOperation, error: unknown): StorageErrorDetails {
  const details = storageErrorDetails(layer, operation, error);
  if (typeof process === "undefined" || process.env.NODE_ENV !== "production") console.warn("SPC storage exception", details);
  return details;
}

export function storageFailureMessage(errors: StorageErrorDetails[]): string {
  const names = new Set(errors.map((error) => error.name));
  if (names.has("QuotaExceededError") || names.has("NS_ERROR_DOM_QUOTA_REACHED")) return "本機儲存空間不足";
  if (names.has("SecurityError")) return "瀏覽器阻止本機儲存";
  if (names.has("InvalidStateError")) return "IndexedDB 尚未可用或資料庫狀態異常";
  if (["VersionError", "AbortError", "UnknownError"].some((name) => names.has(name)))
    return "本機離線儲存初始化失敗，請重新整理或聯絡管理員";
  return "本機離線儲存初始化失敗，請重新整理或聯絡管理員";
}

export const shouldAttemptCloudSave = (changed: boolean, pending: boolean, online: boolean) =>
  online && (changed || pending);

export function containsEmbeddedPhoto(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith("data:image/");
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsEmbeddedPhoto);
  return Object.values(value as Record<string, unknown>).some(containsEmbeddedPhoto);
}

export function localDraftValue(value: unknown, maxBytes = 64 * 1024): string {
  const serialized = JSON.stringify(value);
  if (!containsEmbeddedPhoto(value) && serialized.length * 2 <= maxBytes) return serialized;
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return JSON.stringify({ [markerKey]: true, id: String(record.id || ""), savedAt: new Date().toISOString() });
}

export function isIndexedDbMarker(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as Record<string, unknown>)[markerKey] === true;
}

export function durableStorageState(indexedDb: boolean, local: boolean, errors: StorageErrorDetails[] = []): {
  saved: boolean;
  fallbackOnly: boolean;
  message: string;
} {
  if (indexedDb) return { saved: true, fallbackOnly: !local, message: local ? "已暫存" : "已使用離線儲存保存" };
  if (local) return { saved: true, fallbackOnly: true, message: "已使用本機備援保存" };
  return { saved: false, fallbackOnly: false, message: storageFailureMessage(errors) };
}
