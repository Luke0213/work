import { journalPhotoPlacement, planJournalPhotoPages, planJournalPhotoRows, type JournalPhotoDisplaySettings } from "./journal-photo-layout.ts";

type Photo = { id: string; data: string; caption?: string };
export function wrapJournalText(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  return text.split(/\r?\n/).flatMap((paragraph) => {
    const lines: string[] = [];
    let line = "";
    for (const character of paragraph) {
      if (line && measure(line + character) > maxWidth) { lines.push(line); line = ""; }
      line += character;
    }
    lines.push(line);
    return lines;
  });
}

export function journalPdfPhotoFrames(count: number, firstPage: boolean) {
  const photos = Array.from({ length: count }, (_, value) => ({ value, width: 4, height: 3 }));
  const frames: Array<{ index: number; x: number; y: number; width: number; height: number }> = [];
  if (firstPage && count) frames.push({ index: 0, x: 362, y: 100, width: 310, height: 280 });
  const rows = planJournalPhotoRows(firstPage ? photos.slice(1) : photos);
  rows.forEach((row, rowIndex) => {
    const cellWidth = 624 / row.length;
    const width = row.length === 1 ? 440 : Math.floor(cellWidth) - 4;
    row.forEach((photo, column) => frames.push({ index: photo.value, x: 48 + column * cellWidth + (cellWidth - width) / 2,
      y: (firstPage ? 400 : 100) + rowIndex * (firstPage ? 270 : 420), width, height: firstPage ? 250 : 400 }));
  });
  return frames;
}

async function imageBitmap(source: string) {
  const response = await fetch(source);
  if (!response.ok) throw new Error("圖片載入失敗，無法產生 PDF");
  return createImageBitmap(await response.blob());
}

export async function createJournalPdf(metadata: string[], photos: readonly Photo[], settings: JournalPhotoDisplaySettings) {
  const { jsPDF } = await import("jspdf");
  await document.fonts.ready;
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const logo = await imageBitmap("/shen-yin-logo.png");
  const pageWidth = 720, pageHeight = pageWidth * 297 / 210, resolution = 2;
  let pageCount = 0;
  const newPage = () => {
    const canvas = document.createElement("canvas");
    canvas.width = pageWidth * resolution;
    canvas.height = Math.ceil(pageHeight * resolution);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("無法建立 PDF 畫布");
    context.scale(resolution, resolution);
    context.fillStyle = "white"; context.fillRect(0, 0, pageWidth, pageHeight);
    context.drawImage(logo, 48, 30, 120, 44);
    context.fillStyle = "#111";
    context.font = 'bold 22px "Microsoft JhengHei", "PingFang TC", "Noto Sans CJK TC", sans-serif';
    context.textAlign = "center"; context.fillText("SPC 工程工作日誌", 390, 58);
    context.textAlign = "left";
    context.font = '15px "Microsoft JhengHei", "PingFang TC", "Noto Sans CJK TC", sans-serif';
    return { canvas, context };
  };
  const append = (canvas: HTMLCanvasElement) => {
    if (pageCount++) pdf.addPage("a4", "portrait");
    pdf.addImage(canvas, "PNG", 0, 0, 210, 297);
    canvas.width = canvas.height = 1;
  };
  try {
    const pages = planJournalPhotoPages(photos);
    if (!pages.length) pages.push([]);
    let overflow: string[] = [];
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const { canvas, context } = newPage();
      if (pageIndex === 0) {
        const lines = metadata.flatMap((text) => wrapJournalText(text, 295, (value) => context.measureText(value).width));
        const visible = photos.length ? 14 : 44;
        lines.slice(0, visible).forEach((line, index) => context.fillText(line, 48, 116 + index * 19));
        overflow = lines.slice(visible);
        if (overflow.length) context.fillText("（文字續見後附頁）", 48, photos.length ? 390 : 968);
      }
      for (const frame of journalPdfPhotoFrames(pages[pageIndex].length, pageIndex === 0)) {
        const photo = pages[pageIndex][frame.index];
        const bitmap = await imageBitmap(photo.data);
        try {
          const placement = journalPhotoPlacement(bitmap.width, bitmap.height, frame.width, frame.height, settings[photo.id]);
          context.save();
          context.beginPath(); context.rect(frame.x, frame.y, frame.width, frame.height); context.clip();
          context.drawImage(bitmap, frame.x + placement.x, frame.y + placement.y, placement.width, placement.height);
          context.restore();
        } finally { bitmap.close(); }
      }
      append(canvas);
    }
    while (overflow.length) {
      const { canvas, context } = newPage();
      context.fillText("日誌文字（續）", 48, 98);
      overflow.splice(0, 44).forEach((line, index) => context.fillText(line, 48, 125 + index * 19));
      append(canvas);
    }
    return pdf.output("blob");
  } finally { logo.close(); }
}
