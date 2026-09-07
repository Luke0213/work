export type JournalPhotoOrientation = "portrait" | "landscape";

export type JournalPhotoLayoutItem<T> = {
  value: T;
  width: number;
  height: number;
};

export function journalPhotoOrientation(width: number, height: number): JournalPhotoOrientation {
  return height > width ? "portrait" : "landscape";
}

export type JournalPhotoDisplay = { mode: "original" | "portrait" | "landscape"; scale: number };
export type JournalPhotoDisplaySettings = Record<string, JournalPhotoDisplay>;

export function journalPhotoDisplaySize(width: number, height: number, maxWidth: number, maxHeight: number, setting?: JournalPhotoDisplay) {
  const scale = Math.min(1, Math.max(0.4, Number.isFinite(setting?.scale) ? setting!.scale : 1));
  let boxWidth = maxWidth, boxHeight = maxHeight;
  if (setting?.mode === "portrait") boxWidth = Math.min(boxWidth, boxHeight * 3 / 4);
  if (setting?.mode === "landscape") boxHeight = Math.min(boxHeight, boxWidth * 3 / 4);
  const safeWidth = width > 0 ? width : 4, safeHeight = height > 0 ? height : 3;
  const fit = Math.min(boxWidth / safeWidth, boxHeight / safeHeight) * scale;
  return { width: Math.max(1, Math.round(safeWidth * fit)), height: Math.max(1, Math.round(safeHeight * fit)) };
}

export function planJournalPhotoPages<T>(items: readonly T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / 6) }, (_, index) => items.slice(index * 6, index * 6 + 6));
}

export function planJournalPhotoRows<T>(items: readonly JournalPhotoLayoutItem<T>[]): JournalPhotoLayoutItem<T>[][] {
  return Array.from({ length: Math.ceil(items.length / 3) }, (_, index) => items.slice(index * 3, index * 3 + 3));
}
