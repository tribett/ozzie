// Text size (accessibility audit B1, WCAG 1.4.4): View › Bigger Text (⌘=), Smaller Text (⌘−) and Actual Size (⌘0) are
// native menu items that zoom the page (src-tauri/src/text_size.rs, whose Rust tests pin the steps, the 80–200% range
// and the kept file; tests/app_menu.rs pins the menu AppKit holds). Here: the page's own ⌘+, which asks native for one
// step and nothing else; Settings says where it is; the page keeps no zoom grant; and the narrow layout's rules that
// zoom now reaches.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
import { installFakeDom } from "./fake-dom.js";
import { isBiggerKey, TEXT_SIZE_NOTE, useBiggerTextKey } from "../src/text-size.js";
import { ConnectionPage } from "../src/connection-page.js";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const keys = (key: string, over: Partial<{ metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }> = {}) =>
  ({ key, metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, ...over });

describe("⌘+ on the page", () => {
  it("is Command with the + character; plain ⌘= is the menu's own key, so it is never taken twice", () => {
    expect(isBiggerKey(keys("+"))).toBe(true);
    expect(isBiggerKey(keys("+", { shiftKey: true }))).toBe(true);
    expect(isBiggerKey(keys("=", { shiftKey: true }))).toBe(true);
    expect(isBiggerKey(keys("="))).toBe(false);
    expect(isBiggerKey(keys("-"))).toBe(false);
    expect(isBiggerKey(keys("0"))).toBe(false);
    expect(isBiggerKey(keys("+", { metaKey: false }))).toBe(false);
    expect(isBiggerKey(keys("+", { ctrlKey: true }))).toBe(false);
    expect(isBiggerKey(keys("+", { altKey: true }))).toBe(false);
  });

  it("asks native for one step bigger, stops the key there, and lets every other key go by", async () => {
    installFakeDom();
    const heard: ((e: unknown) => void)[] = [];
    const doc = document as unknown as { addEventListener(t: string, l: (e: unknown) => void): void; removeEventListener(t: string, l: (e: unknown) => void): void };
    doc.addEventListener = (type, listener) => { if (type === "keydown") heard.push(listener); };
    doc.removeEventListener = (type, listener) => { if (type === "keydown") heard.splice(heard.indexOf(listener), 1); };
    const step = vi.fn(() => Promise.resolve());
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.body as unknown as Element);
    function Holder() { useBiggerTextKey(step); return null; }
    await act(async () => { root.render(React.createElement(Holder)); });
    expect(heard).toHaveLength(1);
    const press = (k: ReturnType<typeof keys>) => { const e = { ...k, prevented: false, preventDefault() { e.prevented = true; } }; heard[0]!(e); return e.prevented; };
    expect(press(keys("+"))).toBe(true);
    expect(step).toHaveBeenCalledTimes(1);
    expect(press(keys("="))).toBe(false);
    expect(press(keys("l", { shiftKey: true }))).toBe(false);
    expect(step).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
    expect(heard).toHaveLength(0);
    // In the app, the step is native's: one step by name, never a size.
    const page = src("src/text-size.ts");
    expect(page).toContain('invoke("text_size_step", { step: "bigger" })');
    expect(src("src/App.tsx")).toContain("  useBiggerTextKey();\n");
  });
});

describe("Settings says where it is", () => {
  it("in plain words under the page's first line", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPage, {
      status: null, settings: { clientId: "x", organization: "1001", serviceTypeId: "1500", planId: "1" }, onSettings: () => {}, onStatus: () => {}, phone: null }));
    expect(TEXT_SIZE_NOTE).toBe("To make everything bigger, press ⌘ and + (Command and plus). ⌘ and − makes it smaller, and ⌘ and 0 puts it back. "
      + "They are also in the View menu, and Ozzie keeps your choice.");
    const lede = html.indexOf('<p class="lede">');
    const note = html.indexOf('<p class="small text-size-note">');
    expect(lede).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(lede);
    expect(html.indexOf('<nav class="settings-index"')).toBeGreaterThan(note);
    expect(html).toContain(TEXT_SIZE_NOTE);
  });
});

describe("native holds the size", () => {
  it("the menu's three items and the page's one command; the page keeps no zoom grant and no zoom keys of the framework's", () => {
    const menu = src("src-tauri/src/app_menu.rs");
    for (const line of ['pub const BIGGER_TEXT: &str = "Bigger Text";', 'pub const BIGGER_KEYS: &str = "CmdOrCtrl+Equal";',
      'pub const SMALLER_TEXT: &str = "Smaller Text";', 'pub const SMALLER_KEYS: &str = "CmdOrCtrl+Minus";',
      'pub const ACTUAL_TEXT: &str = "Actual Size";', 'pub const ACTUAL_KEYS: &str = "CmdOrCtrl+0";']) expect(menu).toContain(line);
    expect(src("src-tauri/src/text_size.rs")).toContain("pub const STEPS: [f64; 8] = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];");
    expect(src("src-tauri/src/main.rs")).toContain("text_size::text_size_step");
    const conf = JSON.parse(src("src-tauri/tauri.conf.json")) as { app: { windows: Record<string, unknown>[] } };
    expect(conf.app.windows[0]!.zoomHotkeysEnabled).toBeUndefined();
    expect(src("src-tauri/capabilities/main.json")).not.toMatch(/zoom/iu);
  });
});

describe("the narrow layout zoom now reaches (audit M10)", () => {
  it("stacks label-beside-value rows under 760px instead of squeezing the words into a narrow column", () => {
    const styles = src("src/styles.css").replace(/\/\*[\s\S]*?\*\//gu, "");
    const narrow = styles.slice(styles.search(/@media \(max-width: 760px\) \{\s*\.oz \.shell, /u));
    const block = narrow.slice(0, narrow.indexOf("\n}\n"));
    expect(block).toContain(".oz .log li, .oz .runs-list .log li, .oz .runs-list .log > li, .oz .runs-list .log li li, .oz .sp-row, .oz .sp-row.sp-2 { grid-template-columns: minmax(0, 1fr); }");
    expect(block).toContain(".oz .rule-note { margin-left: 0; }");
    expect(block).toContain(".oz .rule-row label, .oz .rule-row input:not([type=number]) { min-width: 0; }");
  });
});
