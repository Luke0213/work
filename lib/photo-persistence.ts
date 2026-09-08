export async function uploadUnresolvedPhotos<T>(value: T, put: (path: string, blob: Blob) => Promise<void>, checkpoint?: (value: T) => Promise<void>): Promise<T> {
  const cloned = structuredClone(value);
  const visit = async (node: unknown): Promise<void> => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) await visit(item); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.data === "string" && record.data.startsWith("data:image/")) {
      const blob = await (await fetch(record.data)).blob();
      if (blob.size > 10 * 1024 * 1024) throw new Error("單張照片不可超過 10MB");
      const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      const path = `spc/${record.id}.${extension}`;
      await put(path, blob);
      record.data = `spc-storage://${path}`;
      await checkpoint?.(cloned);
    }
    for (const child of Object.values(record)) await visit(child);
  };
  await visit(cloned);
  return cloned;
}
