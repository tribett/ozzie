// The test copy of Ozzie (native src-tauri/src/test_copy.rs; owner decision 2026-11-24): the page is the same in both
// copies, and differs only when native's marker says this is the test copy. In the real app (no marker, as in these
// tests) nothing changes: the real Keychain names, Planning Center offered, no banner, no test key button. In the test
// copy: a "TEST COPY" banner, the test copy's own Keychain names, no Planning Center sign-in, and "Use the test key on
// this Mac". Native code is faked; fictional data only.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { installFakeDom } from "./fake-dom.js";
import {
  buildVariant, keychainName, REAL_APP, TEST_COPY, TEST_COPY_BANNER, TEST_COPY_KEYCHAIN_PREFIX, TEST_COPY_MARKER,
  TEST_COPY_NO_PLANNING_CENTER, TEST_COPY_USE_KEY, variantOf,
} from "../src/build-variant.js";
import { connectProblem, keychainItem, type Connected, type KeyWay } from "../src/church-system.js";
import { disconnectNote } from "../src/connection.js";
import { ChooseSystem, SystemConnect } from "../src/system-setup.js";

const dom = installFakeDom();
const SRC = new URL("../src/", import.meta.url);
const TAURI = new URL("../src-tauri/", import.meta.url);
const NATIVE_AUTH = new URL("../../../core/native-auth/src/", import.meta.url);
const read = (base: URL, file: string) => readFileSync(new URL(file, base), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/&quot;/gu, "\"").replace(/\s+/gu, " ");
const none = () => {};
const tick = () => new Promise(r => setTimeout(r, 0));

const everything = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => everything(c as { childNodes: unknown[] }))];
const buttonStarting = (label: string) => everything(dom.root as unknown as { childNodes: unknown[] })
  .find(n => (n as { tagName?: string }).tagName === "BUTTON" && ((n as { textContent: string }).textContent ?? "").startsWith(label)) as Parameters<typeof dom.press>[0] | undefined;
const reactProps = (el: unknown) => { const o = el as Record<string, Record<string, unknown>>; return o[Object.keys(o).find(k => k.startsWith("__reactProps$"))!]; };

async function mount(element: React.ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(element); });
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await tick(); }); };
  await settle();
  return {
    unmount: () => act(async () => { root.unmount(); }),
    /** The button whose words are `label`, or start with it (a system's name, then its line). */
    button: (label: string) => buttonStarting(label),
    press: async (label: string) => {
      const b = dom.button(label) ?? buttonStarting(label);
      if (!b) throw new Error(`no button ${label}`);
      await act(async () => { dom.press(b); await tick(); });
      await settle();
    },
    type: async (id: string, value: string) => {
      const all = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
      const el = all(dom.root as unknown as { childNodes: unknown[] }).find(n => (n as { getAttribute?: (a: string) => string | null }).getAttribute?.("id") === id);
      const props = el as Record<string, { onChange?: (e: unknown) => void }>;
      await act(async () => { props[Object.keys(props).find(k => k.startsWith("__reactProps$"))!]?.onChange?.({ target: { value } }); await tick(); });
      await settle();
    },
  };
}

describe("which copy the page runs in", () => {
  it("is the real app unless native's marker is there", () => {
    expect(buildVariant).toEqual(REAL_APP);
    expect((globalThis as Record<string, unknown>)[TEST_COPY_MARKER]).toBeUndefined();
    for (const marker of [undefined, null, "", "test", 1, true]) expect(variantOf(marker)).toEqual(REAL_APP);
    expect(variantOf(Object.freeze({ keychainPrefix: TEST_COPY_KEYCHAIN_PREFIX }))).toEqual(TEST_COPY);
    expect(TEST_COPY).toEqual({ testCopy: true, keychainPrefix: "church.ozzie.desktop.test/" });
  });

  it("agrees with native on the marker's name and the Keychain prefix", () => {
    expect(read(TAURI, "src/test_copy.rs")).toContain(`pub const PAGE_MARKER: &str = "${TEST_COPY_MARKER}";`);
    expect(read(NATIVE_AUTH, "variant.rs")).toContain(`"${TEST_COPY_KEYCHAIN_PREFIX}"`);
    expect(read(NATIVE_AUTH, "variant.rs")).toContain(`pub const TEST_COPY_APP_IDENTIFIER: &str = "${TEST_COPY_KEYCHAIN_PREFIX.slice(0, -1)}";`);
    const overlay = JSON.parse(read(TAURI, "tauri.test-copy.conf.json")) as { identifier: string };
    expect(`${overlay.identifier}/`).toBe(TEST_COPY_KEYCHAIN_PREFIX);
  });
});

describe("the Keychain items the page names", () => {
  it("are the real app's own in the real app, and the test copy's own in the test copy", () => {
    expect(keychainItem("b1")).toBe("church.ozzie.church-system.b1.v1");
    expect(keychainItem("breeze")).toBe("church.ozzie.church-system.breeze.v1");
    expect(keychainItem("b1", TEST_COPY)).toBe("church.ozzie.desktop.test/church.ozzie.church-system.b1.v1");
    expect(keychainItem("breeze", TEST_COPY)).toBe("church.ozzie.desktop.test/church.ozzie.church-system.breeze.v1");
    expect(keychainName("church.ozzie.planning-center.v1")).toBe("church.ozzie.planning-center.v1");
    expect(keychainName("church.ozzie.planning-center.v1", TEST_COPY)).toBe("church.ozzie.desktop.test/church.ozzie.planning-center.v1");
    // The real app's words are as they were.
    expect(connectProblem("b1", "in-the-way", "cedarhollow")?.text).toContain("search for church.ozzie.church-system.b1.v1, delete the item");
    expect(disconnectNote({ state: "disconnected", problem: { store: "denied" } } as unknown as Parameters<typeof disconnectNote>[0]))
      .toContain("search for church.ozzie.planning-center.v1.");
  });

  it("says plainly when the test copy has no test key for the church", () => {
    expect(connectProblem("b1", "no-test-key", "cedarhollow")).toEqual({ alert: true,
      text: "The test copy has no B1 Church test key for cedarhollow.b1.church. Copy one into it with the developer tool (copy-to-test), then try again." });
    expect(connectProblem("breeze", "no-test-key", "juniperstreet")?.text).toContain("Breeze test key for juniperstreet.breezechms.com");
  });
});

describe("what does your church use?", () => {
  it("offers Planning Center in the real app", () => {
    const t = text(renderToStaticMarkup(React.createElement(ChooseSystem, { onChoose: none, onExample: none })));
    expect(t).not.toContain(TEST_COPY_NO_PLANNING_CENTER);
    expect(renderToStaticMarkup(React.createElement(ChooseSystem, { onChoose: none, onExample: none }))).not.toContain("disabled");
  });

  it("never lets the test copy choose Planning Center, and says why", async () => {
    const html = renderToStaticMarkup(React.createElement(ChooseSystem, { onChoose: none, onExample: none, testCopy: true }));
    expect(text(html)).toContain(`Planning Center ${TEST_COPY_NO_PLANNING_CENTER}`);
    expect(html.match(/disabled=""/gu)).toHaveLength(1);
    const chosen: string[] = [];
    const app = await mount(React.createElement(ChooseSystem, { onChoose: (s: string) => chosen.push(s), onExample: none, testCopy: true }));
    // Planning Center's button is disabled and has nothing to do; the others still choose.
    const planningCenter = reactProps(app.button("Planning Center"));
    expect(planningCenter?.disabled).toBe(true);
    expect(planningCenter?.onClick).toBeUndefined();
    await app.press("B1 Church");
    await app.press("Breeze");
    expect(chosen).toEqual(["b1", "breeze"]);
    await app.unmount();
  });
});

describe("connecting B1 Church or Breeze", () => {
  it("has no test key button in the real app", () => {
    const html = renderToStaticMarkup(React.createElement(SystemConnect, {
      system: "b1", step: "Step 1 of 2", connect: () => new Promise<Connected>(() => {}), onConnected: none,
    }));
    expect(text(html)).not.toContain(TEST_COPY_USE_KEY);
  });

  it("in the test copy, uses the test key on this Mac through native, with the church's address", async () => {
    const asked: [string | null, KeyWay][] = [];
    const connected: string[] = [];
    const app = await mount(React.createElement(SystemConnect, {
      system: "b1", step: "Step 1 of 2", testCopy: true,
      connect: async (address: string | null, how: KeyWay) => { asked.push([address, how]); return { outcome: "works", church: { id: "CHU0000cedar", name: "Cedar Hollow Fellowship" } }; },
      onConnected: (church: { id: string }, address: string) => connected.push(`${church.id} ${address}`),
    }));
    expect(dom.seen()).toContain(TEST_COPY_USE_KEY);
    await app.type("fr-system-address", "cedarhollow.b1.church");
    await app.press(TEST_COPY_USE_KEY);
    expect(asked).toEqual([["cedarhollow", "saved"]]);
    expect(connected).toEqual(["CHU0000cedar cedarhollow"]);
    await app.unmount();
  });
});

describe("the banner", () => {
  it("is on every page of the test copy only: in the sidebar, beside the logo, from the marker", () => {
    const app = read(SRC, "App.tsx");
    expect(app).toContain(`<div className="brand"><img className="logo" src="/ozzie.svg" alt="Ozzie by FlockConnect" />`);
    expect(app).toContain(`{buildVariant.testCopy && <p className="test-copy-banner" role="note" title={TEST_COPY_NOTE} aria-label={TEST_COPY_NOTE}>{TEST_COPY_BANNER}</p>}</div>`);
    expect(app.match(/test-copy-banner/gu)).toHaveLength(1);
    expect(TEST_COPY_BANNER).toBe("TEST COPY");
    expect(read(SRC, "styles.css")).toMatch(/\.oz \.test-copy-banner \{[^}]*background: #C62828; color: #FFFFFF;/u);
  });
});
