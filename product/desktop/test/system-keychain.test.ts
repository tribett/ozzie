// When macOS asks the person about a key Ozzie keeps for a church system (an item another program saved, or the Mac's
// password for a locked Keychain), a native Keychain call waits until they answer. The page asks native how long its
// Keychain call has waited (church_system_keychain_wait) and, past a few seconds, says what macOS is asking, never a
// silent spinner; a refusal ends the step with what to do. The native side is faked; fictional data only.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ wait: null as number | null, asked: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "church_system_keychain_wait") { native.asked++; return native.wait; }
    return new Promise(() => {});
  }),
}));
import { installFakeDom } from "./fake-dom.js";
import { connectProblem, KEYCHAIN_ASKING_MS, keychainAsking, readProblemText, type SystemConnection } from "../src/church-system.js";
import { SystemConnect, SystemService } from "../src/system-setup.js";
import { SUNDAY_WORDS } from "../../../core/src/service-day.js";

const dom = installFakeDom();
const B1: SystemConnection = { system: "b1", church_id: "CHU0000cedar", church_name: "Cedar Hollow Fellowship", address: "cedarhollow", service_id: null,
  service_day: null, service_name: null, zone: null, result_seen: false };
const never = <T,>() => new Promise<T>(() => {});

async function mount(element: React.ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.root as unknown as Element);
  await act(async () => { root.render(element); });
  const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  return { wait, unmount: () => act(async () => { root.unmount(); }) };
}
afterEach(() => { vi.useRealTimers(); native.wait = null; native.asked = 0; });

describe("macOS asking about a key Ozzie keeps", () => {
  it("is said on the step that waits, once native's Keychain call has waited a few seconds, and not before", async () => {
    vi.useFakeTimers();
    const line = keychainAsking("B1 Church");
    // Finding the services reads the key first; native's list never answers while macOS asks.
    const app = await mount(React.createElement(SystemService, {
      connection: B1, onConnection: () => {}, nowMs: 0, aiOffered: true, onNext: () => {}, list: never, read: never, result: null, day: SUNDAY_WORDS,
    }));
    expect(dom.seen()).toContain("Finding your services in B1 Church…");
    // A Keychain call that has waited only a moment says nothing.
    native.wait = 1_200;
    await app.wait(2_100);
    expect(native.asked).toBeGreaterThan(0);
    expect(dom.seen()).not.toContain(line);
    // Once it has waited past KEYCHAIN_ASKING_MS, the step says what macOS is asking and what to choose.
    native.wait = KEYCHAIN_ASKING_MS + 500;
    await app.wait(1_100);
    expect(dom.seen()).toContain(line);
    expect(line).toContain("Always Allow");
    // macOS answered: the call is over, and the line goes.
    native.wait = null;
    await app.wait(1_100);
    expect(dom.seen()).not.toContain(line);
    await app.unmount();
  });

  it("is said while a key is being kept, and native isn't asked when nothing is under way", async () => {
    vi.useFakeTimers();
    const app = await mount(React.createElement(SystemConnect, { system: "breeze", step: null, connect: never, onConnected: () => {} }));
    await app.wait(3_000);
    // Nothing pressed yet: nothing that reads the Keychain is under way, so native isn't asked.
    expect(native.asked).toBe(0);
    await app.unmount();
  });

  it("ends plainly when the answer was Deny, with what to do", () => {
    expect(readProblemText("b1", "denied")).toBe("Ozzie couldn't read the key it keeps for B1 Church from this Mac's Keychain: macOS didn't allow it. Connect B1 Church again with your key, and Ozzie keeps a fresh copy it can read without asking.");
    expect(readProblemText("breeze", "locked")).toBe("This Mac didn't let Ozzie use the key it keeps. Unlock this Mac (type your Mac password if it asks), then check again.");
    expect(connectProblem("b1", "denied", "cedarhollow")?.text).toBe("B1 Church accepted the key, but macOS didn't let Ozzie replace the key this Mac already keeps for your church, so nothing was saved. Try again, and when macOS asks, choose Allow (type your Mac password if it asks).");
  });

  it("names an older key another program saved, and the exact item to delete, never unlocking (round 4)", () => {
    for (const system of ["b1", "breeze"] as const) {
      const said = connectProblem(system, "in-the-way", "cedarhollow");
      expect(said?.alert).toBe(true);
      expect(said?.text).toContain(`search for church.ozzie.church-system.${system}.v1, delete the item`);
      expect(said?.text).toContain("then press Paste my key again.");
      // Keychain Access isn't in Utilities on current macOS: Spotlight finds it.
      expect(said?.text).toContain("press Command-Space, type Keychain Access, then press Return");
      expect(said?.text).not.toContain("Utilities");
      expect(said?.text).toContain("another program saved");
      expect(said?.text).not.toMatch(/Unlock this Mac/u);
    }
    expect(connectProblem("breeze", "in-the-way", "perlandera")?.text).toBe("Breeze accepted the key, but this Mac already keeps an older Breeze key for your church that another program saved, and macOS won't let Ozzie replace it, so nothing was saved. To clear it, open Keychain Access (press Command-Space, type Keychain Access, then press Return), search for church.ozzie.church-system.breeze.v1, delete the item whose account is [\"local\",\"perlandera\"], then press Paste my key again.");
    expect(connectProblem("b1", "in-the-way", "cedarhollow")?.text).toContain("delete the item for this church, then press Paste my key again.");
    // A locked Mac keeps its own sentence.
    expect(connectProblem("breeze", "locked", "perlandera")?.text).toMatch(/Unlock this Mac/u);
  });
});
