import { afterEach, describe, expect, it, vi } from "vitest";
import { bindForeground, browserImages, openCardPicker } from "../../src/card-review/browser.js";
import { CardReviewController } from "../../src/card-review/controller.js";

const file = () => new File([new Uint8Array([137,80,78,71,13,10,26,10])], "FICTIONAL_FILE_CANARY.png", {type: "image/png"});
const makeController = () => new CardReviewController("a", {foreground: () => true, createURL: () => "blob:local", revokeURL() {}, decode: async () => true});
afterEach(() => vi.unstubAllGlobals());
describe("browser handles simulated at the system seam", () => {
  it.each(["load", "error", "abort"] as const)("settles local image decode once and clears browser image references on %s", async mode => {
    const images: Array<{src: string; naturalWidth: number; naturalHeight: number; onload: (() => void) | null; onerror: (() => void) | null; removeAttribute(name: string): void}> = [];
    vi.stubGlobal("Image", class {
      src = ""; naturalWidth = 1; naturalHeight = 1;
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor() { images.push(this); }
      removeAttribute() { this.src = ""; }
    });
    const abort = new AbortController();
    const result = browserImages().decode("blob:local", abort.signal);
    const image = images[0]!;
    expect(image.src).toBe("blob:local");
    const late = image.onload;
    if (mode === "abort") abort.abort(); else if (mode === "error") image.onerror!(); else image.onload!();
    expect(await result).toBe(mode === "load");
    expect(image.src).toBe(""); expect(image.onload).toBe(null); expect(image.onerror).toBe(null);
    late!();
    expect(image.src).toBe("");
  });
  it.each(["blur", "pagehide", "hidden", "unmount"] as const)("binds actual lifecycle listeners and tears them down on %s", async mode => {
    const controller = makeController();
    const ticket = controller.choose(() => {})!;
    await controller.select(ticket, [file()]);
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), {visibilityState: "visible"});
    const unbind = bindForeground(controller, win as Window, doc as Document);
    if (mode === "hidden") { doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); }
    else if (mode === "unmount") unbind();
    else win.dispatchEvent(new Event(mode));
    expect(controller.source(ticket, 1)).toBe("");
    controller.render(view => expect(view.cards).toEqual([]));
    unbind();
    win.dispatchEvent(new Event("focus"));
    expect(controller.choose(() => {})).toBe(null);
  });
  it("uses a fresh native picker, clears its FileList, and ignores callbacks from a previous context", async () => {
    class Picker {
      type = ""; multiple = false; accept = ""; hidden = false;
      files: File[] = []; onchange: (() => void) | null = null; oncancel: (() => void) | null = null;
      removed = false; clicked = false;
      set value(value: string) { if (value === "") this.files = []; }
      click() { this.clicked = true; }
      remove() { this.removed = true; }
    }
    const inputs: Picker[] = [];
    const doc = {createElement: () => { const input = new Picker(); inputs.push(input); return input; }, body: {append() {}}};
    const controller = makeController();
    const old = openCardPicker(controller, doc as unknown as Document)!;
    const first = inputs[0]!;
    expect(first.clicked).toBe(true);
    const late = first.onchange!;
    first.files = [file()];
    controller.context("b");
    expect(first.files).toEqual([]); expect(first.onchange).toBe(null); expect(first.removed).toBe(true);
    const fresh = openCardPicker(controller, doc as unknown as Document)!;
    late();
    expect(controller.status).toBe("choosing");
    expect(controller.discard(old)).toBe("closed");
    const second = inputs[1]!;
    const active = new Promise<void>(resolve => controller.subscribe(() => { if (controller.status === "active") resolve(); }));
    second.files = [file()]; second.onchange!();
    await active;
    expect(second.files).toEqual([]); expect(second.onchange).toBe(null); expect(second.removed).toBe(true);
    expect(controller.source(fresh, 1)).toBe("blob:local");
    controller.discard(fresh);
  });
  it("resets a cancelled picker so a later selection cannot reappear", () => {
    const input = {value: "", files: [], onchange: null as (() => void) | null, oncancel: null as (() => void) | null, remove() {}, click() {}};
    const controller = makeController();
    openCardPicker(controller, {createElement: () => input, body: {append() {}}} as unknown as Document);
    input.oncancel!();
    expect(input.onchange).toBe(null); expect(input.oncancel).toBe(null);
    expect(controller.status).toBe("closed");
  });
});
