export type JournalPhotoOrientation = "portrait" | "landscape";

export type JournalPhotoLayoutItem<T> = {
  value: T;
  width: number;
  height: number;
};

export function journalPhotoOrientation(width: number, height: number): JournalPhotoOrientation {
  return height > width ? "portrait" : "landscape";
}

export function planJournalPhotoRows<T>(items: readonly JournalPhotoLayoutItem<T>[]): JournalPhotoLayoutItem<T>[][] {
  const source = items.slice();
  const rows: JournalPhotoLayoutItem<T>[][] = [];
  for (let offset = 0; offset < source.length;) {
    const nextThree = source.slice(offset, offset + 3);
    const take = nextThree.length === 3 && nextThree.every((item) => journalPhotoOrientation(item.width, item.height) === "portrait")
      ? 3
      : Math.min(2, source.length - offset);
    rows.push(source.slice(offset, offset + take));
    offset += take;
  }
  return rows;
}
