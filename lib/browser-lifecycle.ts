type PrintWindow = Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout" | "print">;
type PrintDocument = Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState" | "body">;

export function revokeObjectUrlLater(url: string, delayMs = 30_000): void {
  window.setTimeout(() => URL.revokeObjectURL(url), delayMs);
}

export function printWithLifecycleCleanup(className?: string, win: PrintWindow = window, doc: PrintDocument = document, timeoutMs = 60_000): void {
  let timer: number | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (className) doc.body.classList.remove(className);
    win.removeEventListener("afterprint", cleanup);
    win.removeEventListener("pageshow", cleanup);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    if (timer !== undefined) win.clearTimeout(timer);
  };
  const onVisibilityChange = () => { if (doc.visibilityState === "visible") cleanup(); };
  if (className) doc.body.classList.add(className);
  win.addEventListener("afterprint", cleanup);
  win.addEventListener("pageshow", cleanup);
  doc.addEventListener("visibilitychange", onVisibilityChange);
  timer = win.setTimeout(cleanup, timeoutMs);
  try { win.print(); } catch (error) { cleanup(); throw error; }
}
