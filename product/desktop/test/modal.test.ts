// Questions over the page keep the keyboard inside them (accessibility audit S2): while a sheet or the quit question is
// open, everything else on the page is inert, so Tab and VoiceOver can't reach controls under its shade; when it closes,
// the page comes back and the keyboard returns to the control that opened it (Quit included, which never did). A
// question that removes something and appears in place of its button takes the keyboard, and Keep gives it back to that
// button (S3h, S3j). Mounted on the fake document with focus kept; fixed fictional words only.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { inertOutside } from "../src/modal.js";
import { QuitQuestion } from "../src/quit-question.js";
import { PromisesSheet } from "../src/first-run-screens.js";
import { SentSheet } from "../src/ai-parts.js";
import { PeopleQuestion } from "../src/people-question.js";
import { Confirm, useBackTo } from "../src/church-notes.js";

const dom = installFakeDom({ focus: true });
type El = NonNullable<ReturnType<typeof dom.button>>;
const doc = dom.root.ownerDocument as unknown as { createElement(t: string): El };
const make = (tag: string, parent: El, attrs: Record<string, string> = {}) => { const el = parent.appendChild(doc.createElement(tag)); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
const focus = (el: El) => (el as unknown as { focus(): void }).focus();
const focused = () => dom.focused() as unknown as El | null;
const isEl = (n: unknown): n is El => Boolean(n && (n as El).nodeType === 1);
const all = (n: El): El[] => [n, ...(n.childNodes as unknown[]).filter(isEl).flatMap(all)];

/** A page like the app's: a sidebar with the button that opens the question, the page, Ask, and the app's status line. */
function page() {
  const app = make("div", dom.root, { class: "oz app" });
  const shell = make("div", app, { class: "shell" });
  const side = make("aside", shell);
  const opener = make("button", side);
  const main = make("main", shell);
  const ask = make("aside", shell, { inert: "" });
  const status = make("p", app, { role: "status", "aria-live": "polite" });
  const slot = make("div", shell);
  return { app, shell, side, opener, main, ask, status, slot, gone: () => dom.root.removeChild(app) };
}

async function render(host: El, element: React.ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host as unknown as Element);
  await act(async () => { root.render(element); });
  return { act, unmount: async () => { await act(async () => { root.unmount(); }); } };
}

describe("everything outside a question is inert while it is open", () => {
  it("marks each ancestor's other children, never the question, a status line or what was inert already, and undoes exactly that", () => {
    const p = page();
    const dialog = make("div", p.slot);
    const undo = inertOutside(dialog as unknown as Element);
    for (const el of [p.side, p.main, p.ask]) expect(el.hasAttribute("inert")).toBe(true);
    for (const el of [p.slot, dialog, p.shell, p.app, p.status]) expect(el.hasAttribute("inert")).toBe(false);
    undo();
    expect(p.side.hasAttribute("inert")).toBe(false);
    expect(p.main.hasAttribute("inert")).toBe(false);
    // Ask was inert before the question (its own reason): it stays so.
    expect(p.ask.hasAttribute("inert")).toBe(true);
    p.gone();
  });
});

describe("each question over the page", () => {
  const cases: [string, () => React.ReactElement, (first: El | null) => void][] = [
    ["Quit Ozzie?", () => React.createElement(QuitQuestion, { ask: { cards: 1, checks: true }, onQuit: () => {}, onKeep: () => {} }),
      first => { expect(first?.tagName).toBe("BUTTON"); expect(first?.textContent).toBe("Keep Ozzie running"); }],
    ["first run's sheet", () => React.createElement(PromisesSheet, { onClose: () => {} }), first => expect(first?.tagName).toBe("H2")],
    ["the AI screens' sheet", () => React.createElement(SentSheet, { onClose: () => {} }), first => expect(first?.tagName).toBe("H2")],
    ["Allow People for a note's To line", () => React.createElement(PeopleQuestion, { name: "Riley", onAddressed: () => {}, onWithout: () => {}, onClose: () => {},
      access: { start: () => new Promise(() => {}), status: async () => null, cancel: async () => null } }), first => expect(first?.tagName).toBe("H2")],
  ];
  for (const [what, element, first] of cases) {
    it(`${what}: the keyboard starts in it, the page is inert, and closing gives the page and the keyboard back`, async () => {
      const p = page();
      focus(p.opener);
      const shown = await render(p.slot, element());
      first(focused());
      expect(p.slot.contains(focused() as never)).toBe(true);
      expect(p.side.hasAttribute("inert")).toBe(true);
      expect(p.main.hasAttribute("inert")).toBe(true);
      expect(p.status.hasAttribute("inert")).toBe(false);
      await shown.unmount();
      expect(p.side.hasAttribute("inert")).toBe(false);
      expect(p.main.hasAttribute("inert")).toBe(false);
      expect(focused() === p.opener).toBe(true);
      p.gone();
    });
  }
});

describe("a question in place of the button that asked it", () => {
  it("takes the keyboard as it appears, and Keep gives it back to the button", async () => {
    function Remove() {
      const [asking, setAsking] = React.useState(false);
      const [button, back] = useBackTo();
      return asking
        ? React.createElement(Confirm, { question: "Remove this list from Ozzie?", yes: "Yes, remove it", no: "Keep it", onYes: () => setAsking(false), onNo: () => { setAsking(false); back(); } })
        : React.createElement("button", { type: "button", ref: button, onClick: () => setAsking(true) }, "Remove this list");
    }
    const host = make("div", dom.root);
    const shown = await render(host, React.createElement(Remove));
    const remove = dom.button("Remove this list")!;
    focus(remove);
    await shown.act(async () => { dom.press(remove); });
    const ask = all(host).find(n => n.tagName === "P")!;
    expect(focused() === ask).toBe(true);
    expect(ask.getAttribute("tabIndex") ?? ask.getAttribute("tabindex")).toBe("-1");
    await shown.act(async () => { dom.press(dom.button("Keep it")!); });
    expect(focused() === dom.button("Remove this list")).toBe(true);
    await shown.unmount();
    dom.root.removeChild(host);
  });

  it("Church lists has one such question for both its pages; visitor cards' discard question takes the keyboard too", async () => {
    const { readFileSync } = await import("node:fs");
    const lists = readFileSync(new URL("../src/church-lists-page.tsx", import.meta.url), "utf8");
    expect(lists).not.toMatch(/function Confirm\(/u);
    expect(lists.match(/onNo=\{\(\) => \{ set\w+\(false\); backTo\w+\(\); \}\}/gu)).toHaveLength(3);
    const cards = readFileSync(new URL("../src/cards-page.tsx", import.meta.url), "utf8");
    expect(cards).toContain('<p id="cards-discard-q" className="find-body" tabIndex={-1} ref={discardAsk}>');
    expect(cards).toContain("onClick={() => { setDiscarding(false); setBackToDiscard(true); }}");
    expect(cards).toContain("useEffect(() => { if (discarding) discardAsk.current?.focus(); }, [discarding]);");
  });
});
