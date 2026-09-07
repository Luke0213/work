export type JournalPhotoOrientation = "portrait" | "landscape";

export type JournalPhotoLayoutItem<T> = {
  value: T;
  width: number;
  height: number;
};

export function journalPhotoOrientation(width: number, height: number): JournalPhotoOrientation {
  return height > width ? "portrait" : "landscape";
}

export type JournalPhotoDisplay = { mode: "original" | "portrait" | "landscape"; scale: number; offsetX?: number; offsetY?: number };
export type JournalPhotoDisplaySettings = Record<string, JournalPhotoDisplay>;

export function positionJournalPhoto(setting: JournalPhotoDisplay, offsetX = 0, offsetY = 0): JournalPhotoDisplay {
  const clamp = (value: number) => Number.isFinite(value) ? Math.max(-0.5, Math.min(0.5, value)) : 0;
  return { ...setting, offsetX: clamp(offsetX), offsetY: clamp(offsetY) };
}

export function journalPhotoPlacement(width: number, height: number, frameWidth: number, frameHeight: number, setting?: JournalPhotoDisplay) {
  const size = journalPhotoDisplaySize(width, height, frameWidth, frameHeight, setting);
  const position = positionJournalPhoto(setting || { mode: "original", scale: 1 }, setting?.offsetX, setting?.offsetY);
  return { ...size, x: (frameWidth - size.width) / 2 + position.offsetX! * frameWidth, y: (frameHeight - size.height) / 2 + position.offsetY! * frameHeight };
}

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
