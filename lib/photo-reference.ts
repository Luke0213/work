export function photoReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("spc-storage://")) return value.slice("spc-storage://".length);
  for (const marker of ["/storage/v1/object/public/spc-photos/", "/storage/v1/object/sign/spc-photos/"]) {
    const index = value.indexOf(marker);
    if (index >= 0) {
      try { return decodeURIComponent(value.slice(index + marker.length).split("?")[0]); }
      catch { return null; }
    }
  }
  return null;
}
