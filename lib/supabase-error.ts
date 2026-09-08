export function supabaseErrorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { message: String(error ?? "未知同步錯誤") };
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(error), "name", "message", "code", "details", "hint", "status", "statusCode"])) {
    const value = (error as Record<string, unknown>)[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export type SupabaseOperationContext = { action: string; phase: string; rpc: string };

/** Preserve the structured Supabase error while adding non-sensitive call-site context. */
export function withSupabaseErrorContext(error: unknown, context: SupabaseOperationContext): Record<string, unknown> {
  return { ...supabaseErrorDetails(error), ...context };
}

export function formatSupabaseError(error: unknown): string {
  const detail = supabaseErrorDetails(error);
  const display = (value: unknown): string => {
    if (!value || typeof value !== "object") return String(value);
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, child) => {
      if (typeof child === "bigint") return String(child);
      if (child && typeof child === "object") {
        if (seen.has(child)) return "[circular]";
        seen.add(child);
      }
      return child;
    });
  };
  const parts = [detail.message, ...["code", "details", "hint", "status", "statusCode"].map((key) =>
    detail[key] == null || detail[key] === "" ? null : `${key}: ${display(detail[key])}`)].filter(Boolean);
  return parts.length ? parts.map(display).join("；") : "同步失敗，請查看詳細錯誤紀錄";
}
