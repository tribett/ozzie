/**
 * Whether Ozzie's window is on screen, for everything that needs a person who can see it (marking a notice as seen,
 * reading calendars for Today, reading lists and notes for Sunday).
 *
 * Ozzie's window is made hidden and shown a moment later, and the page can start in between: it then finds the
 * document "hidden", and the change to "visible" can come before anything listens for it. Asked once at the start and
 * never again, the page went on believing it was hidden until the window was hidden and shown again (found in 0.1.8:
 * lists and notes stayed at "Reading…" after a restart). So this listens from the moment it is made, asks again
 * whenever the window comes forward, is shown or loses its place, and, until the document has once said that its
 * visibility changed, takes a document that has the keyboard as on screen whatever its visibility says.
 *
 * Once the document has said so itself, its word is final: a window that stays in front behind a locked screen or a
 * sleeping display still has the keyboard, and it is hidden (review of the 0.1.9 fix, M1). It errs toward "not on
 * screen", so nothing that waits for a person runs behind a closed window.
 */
export interface VisibleDocument {
  visibilityState: string;
  hasFocus(): boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}
export interface VisibleWindow {
  addEventListener(type: "focus" | "blur" | "pageshow", listener: () => void): void;
  removeEventListener(type: "focus" | "blur" | "pageshow", listener: () => void): void;
}
export interface WindowVisible {
  /** The answer now. */
  visible(): boolean;
  /** Told the answer after every event that can change it. Returns how to stop being told. */
  subscribe(listener: (visible: boolean) => void): () => void;
  /** Stops listening to the document and the window. */
  stop(): void;
}

const WINDOW_EVENTS = ["focus", "blur", "pageshow"] as const;

export function createWindowVisible(doc: VisibleDocument | undefined, win: VisibleWindow | undefined): WindowVisible {
  if (!doc) return { visible: () => true, subscribe: () => () => undefined, stop: () => undefined };
  /** Whether the document has ever reported a change of visibility itself; from then on only its word counts. */
  let told = false;
  const visible = () => doc.visibilityState !== "hidden" || (!told && doc.hasFocus());
  const listeners = new Set<(visible: boolean) => void>();
  const tell = () => { const now = visible(); for (const l of [...listeners]) l(now); };
  const changed = () => { told = true; tell(); };
  doc.addEventListener("visibilitychange", changed);
  for (const type of WINDOW_EVENTS) win?.addEventListener(type, tell);
  return {
    visible,
    subscribe(listener) { listeners.add(listener); listener(visible()); return () => { listeners.delete(listener); }; },
    stop() {
      doc.removeEventListener("visibilitychange", changed);
      for (const type of WINDOW_EVENTS) win?.removeEventListener(type, tell);
      listeners.clear();
    },
  };
}
