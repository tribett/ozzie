// Ask keeps the keyboard (accessibility audit S3a–d): a pressed suggestion, the Ask button and Cancel go away while a
// question runs or when it ends, and WebKit drops the focus of a control that is removed or disabled to the page's body,
// where Escape no longer closes Ask. Mounted on a fake document with focus kept: the question box stays focusable while
// busy (marked unavailable and read-only, never disabled), the keyboard waits there and is there when the answer or a
// failure arrives, the answer is said by the panel's one status line, and a reopened earlier question takes the focus
// on its own question. Fictional data only; nothing is sent.
import React from "react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { installFakeDom } from "./fake-dom.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { AskPanel, type Turn } from "../src/ask-panel.js";
import type { AskTurn } from "../src/harness-bridge.js";
import type { Voice } from "../src/voice.js";

const dom = installFakeDom({ focus: true });
type El = { tagName: string; childNodes: El[]; parentNode: El | null; textContent: string; getAttribute(n: string): string | null; hasAttribute(n: string): boolean; tabIndex?: number };
const all = (n: El): El[] => [n, ...n.childNodes.flatMap(all)];
const classes = (n: El) => (n.getAttribute?.("class") ?? "").split(" ");
const box = () => all(dom.root as unknown as El).find(n => n.tagName === "TEXTAREA")!;
// A browser lowercases attribute names; the fake document keeps React's spelling.
const readOnly = () => box().hasAttribute("readOnly") || box().hasAttribute("readonly");
const status = () => all(dom.root as unknown as El).filter(n => n.tagName === "P" && n.getAttribute?.("role") === "status" && classes(n).includes("sr-only")).map(n => n.textContent);
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const voice: Voice = { status: async () => ({ status: "not-available" }), listen: async () => ({ status: "stopped" }), stop: async () => {}, cancel: async () => {} };
const capture = nov22Capture();
const brief = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true);

async function mount(ask: (typed: string, signal: AbortSignal) => Promise<AskTurn>, initialTurns?: Turn[]) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(React.createElement(AskPanel, { open: true, onClose: () => {}, ask, brief, modelReady: true, onOpen: () => {}, voice, ...(initialTurns ? { initialTurns } : {}) })); });
  await act(flush);
  return { act, root, press: async (label: string) => {
    const b = dom.button(label);
    expect(b, label).not.toBeNull();
    // A click focuses the button first, as a Mac does for a keyboard press of it.
    (b as unknown as { focus(): void }).focus();
    await act(async () => { dom.press(b!); });
    await act(flush);
  } };
}

describe("Ask keeps the keyboard", () => {
  it("a suggested question: the box stays focusable while it runs, and the keyboard is there when the answer comes", async () => {
    let answer!: (t: AskTurn) => void;
    const { act, root, press } = await mount(() => new Promise<AskTurn>(r => { answer = r; }));
    // Opening Ask puts the keyboard in the question box.
    expect(dom.focused()).toBe(box());
    await press("Who could cover Greeter?");
    // The suggestions are gone while it runs; the keyboard waits in the box, which takes nothing but isn't disabled.
    expect(dom.button("Who could cover Greeter?")).toBeNull();
    expect(dom.focused()).toBe(box());
    expect(box().getAttribute("aria-disabled")).toBe("true");
    expect(box().hasAttribute("disabled")).toBe(false);
    expect(readOnly()).toBe(true);
    expect(status()).toEqual(["Reading what Ozzie already has…"]);
    await act(async () => { answer({ state: "refused", text: "Ozzie answers questions about your services only. Nothing was sent." }); });
    await act(flush);
    expect(dom.focused()).toBe(box());
    expect(box().hasAttribute("aria-disabled")).toBe(false);
    expect(readOnly()).toBe(false);
    // The answer is said once, by the status line.
    expect(status()).toEqual(["Ozzie answers questions about your services only. Nothing was sent."]);
    await act(async () => { root.unmount(); });
  });

  it("a question that fails, and Cancel, which goes away: the keyboard is back in the box", async () => {
    let fail!: (e: unknown) => void;
    const first = await mount(() => new Promise<AskTurn>((_, reject) => { fail = reject; }));
    await first.press("Who could cover Greeter?");
    await first.act(async () => { fail(new Error("offline")); });
    await first.act(flush);
    expect(dom.focused()).toBe(box());
    expect(status()[0]).toMatch(/\S/u);
    await first.act(async () => { first.root.unmount(); });

    const second = await mount((_typed, signal) => new Promise<AskTurn>(r => signal.addEventListener("abort", () => r({ state: "cancelled", text: "You stopped this question. Nothing was sent." }))));
    await second.press("Who could cover Greeter?");
    await second.press("Cancel this question");
    expect(dom.button("Cancel this question")).toBeNull();
    expect(dom.focused()).toBe(box());
    expect(status()).toEqual(["You stopped this question. Nothing was sent."]);
    await second.act(async () => { second.root.unmount(); });
  });

  it("an earlier question reopened: its button leaves the list, and the keyboard goes to that card's question", async () => {
    const turns: Turn[] = [
      { id: 1, question: "What can you do?", state: "help", checked: true },
      { id: 2, question: "Read these visitor cards", state: "cards" },
    ];
    const { act, root, press } = await mount(() => new Promise<AskTurn>(() => {}), turns);
    await press("What can you do?");
    const at = dom.focused() as unknown as El;
    expect(at.tagName).toBe("H3");
    expect(at.textContent).toBe("What can you do?");
    expect(at.tabIndex).toBe(-1);
    await act(async () => { root.unmount(); });
  });

  it("never takes the keyboard from the page: an answer arriving while focus is elsewhere leaves it there", async () => {
    let answer!: (t: AskTurn) => void;
    const { act, root, press } = await mount(() => new Promise<AskTurn>(r => { answer = r; }));
    await press("Who could cover Greeter?");
    const elsewhere = dom.root.appendChild(document.createElement("button") as unknown as typeof dom.root);
    (elsewhere as unknown as { focus(): void }).focus();
    await act(async () => { answer({ state: "refused", text: "Nothing was sent." }); });
    await act(flush);
    expect(dom.focused()).toBe(elsewhere);
    await act(async () => { root.unmount(); });
    dom.root.removeChild(elsewhere);
  });
});
