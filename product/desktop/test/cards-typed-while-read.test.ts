// A person types in a card's field while this Mac is still reading that card (seen in 0.9.0): the field keeps their
// words when the reading comes back, what this Mac read for it is offered beside the photo to choose, and the name looked
// up in Planning Center People is always the one the field shows. The whole page over a fake `invoke`: the photo window,
// the card reader (held by an explicit promise, never a timer) and the lookup. Fictional cards only.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";

type Reading = { status: "read"; text: string; unclearLines: number[] };
const invoked: [string, unknown][] = [];
let readAsked: () => void = () => {};
let readBack: (reading: Reading) => void = () => {};
/** The Mac's reply to "Choose card photos" (card_picker.rs): one PNG, as kind, 4-byte length and bytes. */
const photoReply = () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const out = new Uint8Array(5 + png.length);
  out[0] = 1; new DataView(out.buffer).setUint32(1, png.length); out.set(png, 5);
  return out;
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string, args?: unknown) => {
    invoked.push([command, args instanceof Uint8Array ? "photo" : args]);
    if (command === "prepare_card_reader") return Promise.resolve("ready");
    if (command === "choose_card_photos") return Promise.resolve(photoReply());
    // Held until the test gives the reading back.
    if (command === "read_card_text") return new Promise(resolve => { readBack = resolve; readAsked(); });
    if (command === "look_up_card_name") return Promise.resolve({ result: "no-one" });
    return Promise.resolve();
  }),
}));
import { KeptCards } from "../src/cards-page.js";
import type { PeopleAccess } from "../src/people-question.js";

const dom = installFakeDom();
// What the page's photo handling needs of a browser: the window in front, and a picture that opens.
Object.assign(document, { hasFocus: () => true, visibilityState: "visible" });
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 1;
  naturalHeight = 1;
  set src(_url: string) { queueMicrotask(() => this.onload?.()); }
  removeAttribute() {}
}
Object.assign(globalThis, { Image: FakeImage });
const trap = vi.fn(() => { throw new Error("NETWORK_FORBIDDEN"); });
globalThis.fetch = trap as unknown as typeof fetch;

const CHURCH = "1001";
const TYPED = "Jordan Typedname", READ = "Riley Readname";
const CARD = `Name: ${READ}\nPhone: (555) 014-2290\n`;
const noAccess: PeopleAccess = { start: async () => undefined, status: async () => null, cancel: async () => undefined };
const lookedUp = () => invoked.filter(([c]) => c === "look_up_card_name").map(([, a]) => (a as { name: string }).name);
const settle = async () => { const { act } = await import("react"); for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
/** The props React gave the element with `attribute` = `value`, to type into it or choose from it the way a person does. */
function propsOf(attribute: string, value: string) {
  const all = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
  const el = all(dom.root as unknown as { childNodes: unknown[] })
    .find(n => (n as { getAttribute?: (a: string) => string | null }).getAttribute?.(attribute) === value);
  const key = el ? Object.keys(el).find(k => k.startsWith("__reactProps$")) : undefined;
  if (!key) throw new Error(`nothing with ${attribute}="${value}"`);
  return (el as Record<string, { value?: string; onChange: (e: unknown) => void; onBlur?: () => void }>)[key]!;
}
afterEach(() => { invoked.length = 0; readAsked = () => {}; readBack = () => {}; });

describe("typing in a card while this Mac reads it", () => {
  it("keeps the person's words, offers what this Mac read beside the photo, and looks up only the name the field shows", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.root as unknown as Element);
    try {
      await act(async () => {
        root.render(React.createElement(KeptCards, {
          check: null, example: false, inUse: CHURCH, disconnected: false, access: "allowed", shown: true, onScreen: true,
          openPerson: () => {}, peopleAccess: noAccess,
        }));
      });
      // The person chooses a photo; the page opens it and asks this Mac to read it.
      const asked = new Promise<void>(resolve => { readAsked = resolve; });
      await act(async () => { dom.press(dom.button("Choose card photos")!); await asked; });
      await settle();
      expect(dom.seen()).toContain("Reading on this Mac…");
      // While it is read, they type a name and finish typing it: that name is the one looked up.
      await act(async () => { propsOf("id", "card-1-name").onChange({ target: { value: "Jord" } }); });
      await act(async () => { propsOf("id", "card-1-name").onChange({ target: { value: TYPED } }); });
      await act(async () => { propsOf("id", "card-1-name").onBlur!(); });
      await settle();
      expect(lookedUp()).toEqual([TYPED]);
      // The reading comes back with another name.
      await act(async () => { readBack({ status: "read", text: CARD, unclearLines: [] }); });
      await settle();
      expect(dom.seen()).not.toContain("Reading on this Mac…");
      // Their words stay; the field nobody touched is filled.
      expect(propsOf("id", "card-1-name").value).toBe(TYPED);
      expect(propsOf("id", "card-1-phone").value).toBe("(555) 014-2290");
      // What this Mac read for the name is first beside the photo, with why it isn't in the field and a way to use it.
      expect(dom.seen()).toContain(`${READ}This Mac read this as the name. Ozzie kept what you typed there.`);
      expect(propsOf("aria-label", "Use line 1 as").onChange).toBeTypeOf("function");
      // Only the name the field shows went to Planning Center.
      expect(lookedUp()).toEqual([TYPED]);
      // Choosing what this Mac read puts it in the field, and then that is the name looked up.
      await act(async () => { propsOf("aria-label", "Use line 1 as").onChange({ target: { value: "name" } }); });
      await settle();
      expect(propsOf("id", "card-1-name").value).toBe(READ);
      expect(lookedUp()).toEqual([TYPED, READ]);
      // Nothing but the page's own native commands; no network from the page.
      expect([...new Set(invoked.map(([c]) => c))].sort())
        .toEqual(["choose_card_photos", "look_up_card_name", "prepare_card_reader", "read_card_text"]);
      expect(trap).not.toHaveBeenCalled();
    } finally {
      // Whatever happened above, nothing this test mounted is left for the next one.
      await act(async () => { root.unmount(); });
    }
  });
});
