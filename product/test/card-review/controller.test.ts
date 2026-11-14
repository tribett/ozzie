import { describe, expect, it, vi } from "vitest";
import { CardReviewController, type BrowserImages } from "../../src/card-review/controller.js";

// Generated inert header fixture: browser decoding is a separately simulated system seam.
const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0];
const file = () => new File([new Uint8Array(png)], "PRIVATE_FILENAME_CANARY.png", { type: "image/png" });
const setup = (overrides: Partial<BrowserImages> = {}) => {
  let serial = 0;
  const revoked: string[] = [];
  const browser: BrowserImages = {
    foreground: () => true,
    createURL: () => `blob:local-${++serial}`,
    revokeURL: url => { revoked.push(url); },
    decode: async () => true,
    ...overrides,
  };
  const controller = new CardReviewController("a", browser);
  const reset = vi.fn();
  return { controller, browser, revoked, reset };
};
describe("foreground browser review", () => {
  it("loads supported images for manual entry, releases one source, then discards all references", async () => {
    const {controller, revoked, reset} = setup();
    const ticket = controller.choose(reset)!;
    expect(await controller.select(ticket, [file(), file()])).toBe("ok");
    expect(controller.status).toBe("active");
    expect(controller.choose(reset)).toBe(null);
    controller.render(view => expect(view.cards.map(c => c.label)).toEqual(["Card 1", "Card 2"]));
    expect(controller.source(ticket, 1)).toBe("blob:local-1");
    controller.edit(ticket, {card: 1, field: "request", text: "FICTIONAL_RAW_CANARY", state: "typed"});
    expect(controller.remove(ticket, 1)).toBe("ok");
    expect(revoked).toEqual(["blob:local-1"]);
    controller.discard(ticket);
    expect(new Set(revoked)).toEqual(new Set(["blob:local-1", "blob:local-2"]));
    expect(controller.source(ticket, 2)).toBe("");
    controller.render(view => expect(view.cards).toEqual([]));
    expect(reset).toHaveBeenCalled();
    expect(JSON.stringify(controller)).toBe("{}");
  });
});

it("refuses a duplicate selection without closing current review", async () => {
  const {controller, reset, revoked} = setup();
  const ticket = controller.choose(reset)!;
  await controller.select(ticket, [file()]);
  expect(await controller.select(ticket, [file()])).toBe("closed");
  expect(controller.status).toBe("active");
  expect(revoked).toEqual([]);
});
it("releases current handles even if focus is lost before choosing is attempted", async () => {
  let foreground = true;
  const {controller, reset, revoked} = setup({ foreground: () => foreground });
  await controller.select(controller.choose(reset)!, [file()]);
  foreground = false;
  expect(controller.choose(reset)).toBe(null);
  expect(revoked).toEqual(["blob:local-1"]);
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
it.each(["blur", "hidden", "pagehide", "unmount", "workspace", "signout", "revoke"] as const)("releases active sources on %s", async cause => {
  const {controller, reset, revoked} = setup();
  const ticket = controller.choose(reset)!;
  await controller.select(ticket, [file(), file()]);
  controller.edit(ticket, {card: 1, field: "request", text: "FICTIONAL_RAW_CANARY", state: "typed"});
  if (cause === "unmount") controller.dispose();
  else if (cause === "workspace" || cause === "signout" || cause === "revoke") controller.context(cause !== "workspace" ? null : "b");
  else controller.interrupt(cause);
  expect(new Set(revoked)).toEqual(new Set(["blob:local-1", "blob:local-2"]));
  expect(controller.source(ticket, 1)).toBe("");
  controller.render(view => expect(view.cards).toEqual([]));
  expect(controller.edit(ticket, {card: 1, field: "request", text: "late", state: "typed"})).toBe("closed");
  if (cause === "signout" || cause === "revoke" || cause === "unmount") expect(controller.choose(reset)).toBe(null);
});
it.each(["close", "workspace", "new-batch"] as const)("refuses late abort-ignoring decode after %s", async mode => {
  const decode = deferred<boolean>();
  const entered = deferred<void>();
  const {controller, reset, revoked} = setup({decode: () => { entered.resolve(); return decode.promise; }});
  const old = controller.choose(reset)!;
  const pending = controller.select(old, [file()]);
  await entered.promise;
  if (mode === "workspace") controller.context("b"); else controller.discard(old);
  let fresh: number | null = null;
  if (mode === "new-batch") fresh = controller.choose(reset);
  decode.resolve(true);
  expect(await pending).toBe("closed");
  controller.render(view => expect(view.cards).toEqual([]));
  expect(controller.status).toBe(mode === "new-batch" ? "choosing" : "closed");
  expect(revoked).toEqual(["blob:local-1"]);
  if (fresh !== null) controller.discard(fresh);
});
it.each(["close", "workspace", "new-batch"] as const)("drops late signature bytes after %s without creating a URL", async mode => {
  const bytes = deferred<ArrayBuffer>();
  const held = file();
  const slice = vi.spyOn(held, "slice").mockReturnValue({ arrayBuffer: () => bytes.promise } as Blob);
  const createURL = vi.fn(() => "blob:unexpected");
  const {controller, reset} = setup({createURL});
  const old = controller.choose(reset)!;
  const pending = controller.select(old, [held]);
  if (mode === "workspace") controller.context("b"); else controller.discard(old);
  const fresh = mode === "new-batch" ? controller.choose(reset)! : null;
  bytes.resolve(new Uint8Array(png).buffer);
  expect(await pending).toBe("closed");
  expect(createURL).not.toHaveBeenCalled();
  expect(slice).toHaveBeenCalledWith(0, 12);
  expect(controller.status).toBe(mode === "new-batch" ? "choosing" : "closed");
  if (fresh !== null) controller.discard(fresh);
});
it.each([
  {type: "image/png", bytes: [255,216,255], decode: true},
  {type: "image/jpeg", bytes: png, decode: true},
  {type: "image/gif", bytes: png, decode: true},
  {type: "image/png", bytes: [], decode: true},
  {type: "image/png", bytes: png, decode: false},
])("rejects mismatch, unsupported, truncated or corrupt image ($#)", async fixture => {
  const {controller, reset, revoked} = setup({decode: async () => fixture.decode});
  const result = await controller.select(controller.choose(reset)!, [new File([new Uint8Array(fixture.bytes)], "INERT_CANARY", {type: fixture.type})]);
  expect(["closed", "invalid"]).toContain(result);
  expect(controller.status).toBe("error");
  controller.render(view => expect(view.cards).toEqual([]));
  expect(revoked.length).toBe(fixture.decode ? 0 : 1);
});
it("admits JPEG signatures, finishes reviewed blank fields and clears the input and source", async () => {
  const {controller, reset, revoked} = setup();
  const ticket = controller.choose(reset)!;
  expect(await controller.select(ticket, [new File([new Uint8Array([255,216,255,224])], "INERT.jpg", {type: "image/jpeg"})])).toBe("ok");
  for (const field of ["name", "phone", "email", "request"]) controller.edit(ticket, {card: 1, field, text: "", state: "blank"});
  controller.review(ticket, {card: 1, acknowledge: false});
  expect(controller.finish(ticket)).toBe("finished");
  expect(controller.status).toBe("finished");
  expect(controller.source(ticket, 1)).toBe("");
  expect(revoked).toEqual(["blob:local-1"]);
  expect(reset.mock.calls.length).toBeGreaterThanOrEqual(3);
});
it("keeps initial picker blur content-free, rejects background acceptance, and invalidates cancelled selection", async () => {
  let foreground = true;
  const {controller, reset} = setup({foreground: () => foreground});
  const ticket = controller.choose(reset)!;
  foreground = false; controller.interrupt("blur");
  expect(controller.status).toBe("choosing");
  expect(await controller.select(ticket, [file()])).toBe("closed");
  foreground = true; controller.focus();
  const cancelled = controller.choose(reset)!;
  controller.discard(cancelled);
  expect(await controller.select(cancelled, [file()])).toBe("closed");
});
it("closes the whole rejected batch and never echoes decode errors", async () => {
  const {controller, reset, revoked} = setup({decode: async () => { throw Error("FICTIONAL_RAW_CANARY"); }});
  await controller.select(controller.choose(reset)!, [file(), file()]);
  expect(controller.status).toBe("error");
  expect(JSON.stringify(controller)).toBe("{}");
  expect(new Set(revoked).size).toBe(revoked.length);
  controller.render(view => expect(view.cards).toEqual([]));
});
it("makes no storage, network, clipboard, console or model calls during review", async () => {
  const forbidden = vi.fn(() => { throw new Error("Forbidden side effect"); });
  const forbiddenAPIs = {getItem: forbidden, setItem: forbidden, removeItem: forbidden, clear: forbidden,
    open: forbidden, deleteDatabase: forbidden, match: forbidden, put: forbidden, add: forbidden, delete: forbidden, keys: forbidden};
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "localStorage", "sessionStorage", "indexedDB", "caches", "navigator"]) {
    vi.stubGlobal(name, name === "navigator" ? {sendBeacon: forbidden, clipboard: {writeText: forbidden, readText: forbidden}, serviceWorker: {register: forbidden}} :
      ["localStorage", "sessionStorage", "indexedDB", "caches"].includes(name) ? forbiddenAPIs : forbidden);
  }
  const consoleSpies = ["log", "error", "warn", "debug", "info"].map(method => vi.spyOn(console, method as "log").mockImplementation(forbidden));
  try {
    const {controller, reset} = setup();
    const ticket = controller.choose(reset)!;
    expect(await controller.select(ticket, [file()])).toBe("ok");
    expect(controller.edit(ticket, {card: 1, field: "request", text: "FICTIONAL_RAW_CANARY", state: "typed"})).toBe("ok");
    controller.discard(ticket);
    expect(forbidden).not.toHaveBeenCalled();
  } finally { consoleSpies.forEach(spy => spy.mockRestore()); vi.unstubAllGlobals(); }
});
it("rejects accessor file-selection arrays before observing their elements", async () => {
  let observed = false;
  const files: File[] = [];
  Object.defineProperty(files, 0, {enumerable: true, get() { observed = true; throw Error("SELECTION_CANARY"); }});
  const {controller, reset} = setup();
  await controller.select(controller.choose(reset)!, files);
  expect(observed).toBe(false);
  expect(controller.status).toBe("error");
});
it.each(["blur", "hidden", "pagehide", "unmount", "workspace", "signout", "revoke"] as const)("refuses late validation/decode on loading interruption: %s", async cause => {
  const decode = deferred<boolean>(), entered = deferred<void>();
  let signal!: AbortSignal;
  const {controller, reset, revoked} = setup({decode: (_url, abort) => { signal = abort; entered.resolve(); return decode.promise; }});
  const ticket = controller.choose(reset)!;
  const pending = controller.select(ticket, [file()]);
  await entered.promise;
  if (cause === "unmount") controller.dispose();
  else if (cause === "workspace" || cause === "signout" || cause === "revoke") controller.context(cause !== "workspace" ? null : "b");
  else controller.interrupt(cause);
  expect(signal.aborted).toBe(true);
  decode.resolve(true);
  expect(await pending).toBe("closed");
  expect(revoked).toEqual(["blob:local-1"]);
  controller.render(view => expect(view.cards).toEqual([]));
});
it("keeps deliberately repeated attachments separate and does not deduplicate people or images", async () => {
  const {controller, reset, revoked} = setup();
  const sameFile = file();
  const ticket = controller.choose(reset)!;
  expect(await controller.select(ticket, [sameFile, sameFile])).toBe("ok");
  controller.render(view => expect(view.cards.map(card => card.label)).toEqual(["Card 1", "Card 2"]));
  controller.discard(ticket);
  expect(revoked).toHaveLength(2);
});

it("accepts the initial picker result only after foreground focus is confirmed", async () => {
  let foreground = true;
  const {controller, reset} = setup({foreground: () => foreground});
  const ticket = controller.choose(reset)!;
  foreground = false; controller.interrupt("blur");
  foreground = true; controller.focus();
  expect(await controller.select(ticket, [file()])).toBe("ok");
  controller.discard(ticket);
});
