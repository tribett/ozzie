import { CardReviewController, type BrowserImages } from "./controller.js";

/** No remote URL, canvas, full byte read, or recognizer is involved. */
export function browserImages(): BrowserImages {
  return {
    foreground: () => document.visibilityState === "visible" && document.hasFocus(),
    createURL: file => URL.createObjectURL(file),
    revokeURL: url => URL.revokeObjectURL(url),
    decode: (url, signal) => new Promise<boolean>(resolve => {
      const image = new Image();
      let settled = false;
      const end = (ok: boolean) => {
        if (settled) return;
        settled = true;
        image.onload = null; image.onerror = null;
        signal.removeEventListener("abort", abort);
        image.removeAttribute("src");
        resolve(ok);
      };
      const abort = () => end(false);
      image.onload = () => end(image.naturalWidth > 0 && image.naturalHeight > 0);
      image.onerror = () => end(false);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) end(false); else image.src = url;
    }),
  };
}

export function bindForeground(controller: CardReviewController, win: Window, doc: Document): () => void {
  const blur = () => controller.interrupt("blur");
  const focus = () => controller.focus();
  const visibility = () => doc.visibilityState === "visible" ? controller.focus() : controller.interrupt("hidden");
  const pagehide = () => controller.interrupt("pagehide");
  win.addEventListener("blur", blur); win.addEventListener("focus", focus);
  win.addEventListener("pagehide", pagehide); doc.addEventListener("visibilitychange", visibility);
  return () => {
    win.removeEventListener("blur", blur); win.removeEventListener("focus", focus);
    win.removeEventListener("pagehide", pagehide); doc.removeEventListener("visibilitychange", visibility);
    controller.dispose();
  };
}

/** A fresh native picker node per selection binds callbacks to their original ticket.
 * It never coexists with an active private batch; reset removes its FileList and handlers.
 */
export function openCardPicker(controller: CardReviewController, doc: Document): number | null {
  const input = doc.createElement("input");
  input.type = "file"; input.multiple = true; input.accept = "image/png,image/jpeg";
  input.hidden = true;
  const reset = () => { input.value = ""; input.onchange = null; input.oncancel = null; input.remove(); };
  const ticket = controller.choose(reset);
  if (ticket === null) return null;
  input.onchange = () => { void controller.select(ticket, Array.from(input.files ?? [])); };
  input.oncancel = () => { controller.discard(ticket); };
  doc.body.append(input);
  try { input.click(); } catch { controller.discard(ticket); }
  return ticket;
}
