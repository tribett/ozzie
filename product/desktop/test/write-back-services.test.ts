// The one change a leader confirms, inside 0.5.x (owner decision 2026-11-21): with several services watched it works on any
// watched Planning Center service's cards, names that service and its day on the confirmation and goes to that plan only;
// and a church on B1 Church, Breeze or Genesis gets no switch, no button and no change line, and its words stay "reads
// only". Fictional data only; native code is a stand-in that answers as the contract says (native refuses on its own too:
// src-tauri changes_tests.rs, core change_tests.rs).
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
type Answer = (command: string, args: Record<string, unknown> | undefined) => unknown;
const native = vi.hoisted(() => ({ calls: [] as { command: string; args: Record<string, unknown> | undefined }[],
  answer: (() => Promise.reject("unavailable")) as Answer }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string, args?: Record<string, unknown>) => { native.calls.push({ command, args }); return native.answer(command, args); }),
}));
import { installFakeDom } from "./fake-dom.js";
import { text } from "./harness-fakes.js";
import { addButton, confirmTitle, historyLine, RECHECK_FAILED, refusalSentence, REFUSALS, switchProblem, takeOff, yesAdd, type ChangeRecord, type Proposed } from "../src/planning-center-changes.js";
import { ChangeHistory, sundayChanges, useChanges } from "../src/change-card.js";
import { SundayPage } from "../src/sunday-page.js";
import { ActivityPage } from "../src/activity-page.js";
import { helpFor } from "../src/ask-panel.js";
import { HELP } from "../src/harness-words.js";
import { SystemWordsContext, systemWords } from "../src/church-system.js";
import { promise, systemPromise } from "../src/promises.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import { nov22Capture, PEOPLE, TEAMS } from "../../../core/src/fictional-sunday.js";
import { b1Capture, breezeCapture, NOW } from "../../../core/test/church-systems/fixtures.js";
import { source } from "../../../core/test/stays-on-this-mac-imports.js";

const dom = installFakeDom();
const capture = nov22Capture();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
/** The first service watched, and a second one on a Wednesday (the fictional Youth Night in the test organization). */
const FIRST = { plan: capture.plan_id, service: "Sunday Morning", day: "2026-11-22" };
const SECOND = { plan: "93506032", service: "Youth Night", day: "2026-11-25" };
const brief = buildSundayBrief(capture, rules, capture.completed_at);
const secondBrief = buildSundayBrief({ ...capture, plan_id: SECOND.plan, service_type_id: "1700001" }, rules, capture.completed_at);
const pageProps = {
  names: capture.names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true, canReword: false,
  decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
};
const proposalFor = (plan: string): Proposed => ({
  change: plan === SECOND.plan ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", plan, team: TEAMS.greeter, person: PEOPLE.riley,
  position: "Greeter", sunday: plan === SECOND.plan ? SECOND.day : FIRST.day,
  times: [{ starts_at: plan === SECOND.plan ? "2026-11-26T00:00:00Z" : "2026-11-22T14:30:00Z", ends_at: plan === SECOND.plan ? "2026-11-26T01:30:00Z" : "2026-11-22T15:30:00Z" }],
  still_needed: 1, kids_team: false, advised_against: false, checked_at: "2026-11-20T15:14:00.000Z", expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
});
const recordFor = (plan: string): ChangeRecord => ({
  action: "added-unconfirmed", organization: "1001", service_type: plan === SECOND.plan ? "1700001" : "1500", plan, team: TEAMS.greeter, role: "Greeter",
  sunday: plan === SECOND.plan ? SECOND.day : FIRST.day, person: PEOPLE.riley, row: plan === SECOND.plan ? "88002" : "88001", confirmed_at: "2026-11-20T15:15:00.000Z",
  sent_at: "2026-11-20T15:15:01.000Z", status: 201, came_back: "made", read_back: "as-expected", confirmation: "on-screen",
});

type El = { tagName: string; childNodes: El[]; getAttribute(n: string): string | null; textContent: string };
const all = (n: El): El[] => [n, ...n.childNodes.flatMap(all)];
const part = (cls: string) => all(dom.root as unknown as El).find(n => n.getAttribute?.("class") === cls) ?? null;
const buttonIn = (cls: string, label: string) => {
  const box = part(cls);
  return box ? all(box).find(n => n.tagName === "BUTTON" && n.textContent === label) ?? null : null;
};
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** The control the two parts last drew with. */
const shown: { c: ReturnType<typeof useChanges> | null } = { c: null };
/** Two services' parts of the Services page, as App draws them: each with its own plan, name and day. */
function TwoServices({ afterWrite, checked }: { afterWrite: (plan: string) => Promise<boolean>; checked: Record<string, string> }) {
  const c = useChanges({ organization: "1001", connected: true, kidsTeamIds: [], afterWrite, checked });
  shown.c = c;
  const slot = (plan: string, service: string, main: boolean) => c.on ? sundayChanges({ control: c, zone: "America/New_York", openPc: async () => true, people: true,
    plan, service, resultsHere: p => p === plan || (main && ![FIRST.plan, SECOND.plan].includes(p)) }) : null;
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "part-first" }, React.createElement(SundayPage, { ...pageProps, brief, changes: slot(FIRST.plan, FIRST.service, true) })),
    React.createElement("div", { className: "part-second" }, React.createElement(SundayPage, { ...pageProps, brief: secondBrief, changes: slot(SECOND.plan, SECOND.service, false) })));
}

describe("several services watched: the change works on any watched Planning Center service, on its own plan", () => {
  beforeEach(() => { native.calls.length = 0; });

  it("each service's Add asks for its own plan, its confirmation names that service and its day, and the yes goes to that change only", async () => {
    native.answer = (command, args) => Promise.resolve().then(() => command === "changes_status" ? { organization: "1001", on: true }
      : command === "change_prepare" ? proposalFor(args!.plan as string)
        : command === "change_confirm" ? { result: "made", record: recordFor(args!.change === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ? SECOND.plan : FIRST.plan) }
          : Promise.reject("unavailable"));
    const wrote: string[] = [];
    // The fresh round never ends in this test: the second service's part keeps waiting for its own new check.
    const afterWrite = vi.fn((plan: string) => { wrote.push(plan); return new Promise<boolean>(() => {}); });
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const box = dom.root.appendChild((document as unknown as { createElement(t: string): typeof dom.root }).createElement("div"));
    const root = createRoot(box as unknown as Element);
    const checked = { [FIRST.plan]: "check-1", [SECOND.plan]: "check-1" };
    await act(async () => { root.render(React.createElement(TwoServices, { afterWrite, checked })); });
    await act(flush);
    const add = addButton("Riley", "Greeter");
    expect(buttonIn("part-first", add)).not.toBeNull();
    expect(buttonIn("part-second", add)).not.toBeNull();

    // The second service: its own plan goes to native code, and the confirmation names it and its Wednesday.
    await act(async () => { dom.press(buttonIn("part-second", add) as never); });
    await act(flush);
    const prepare = native.calls.filter(c => c.command === "change_prepare");
    expect(prepare.map(c => c.args?.plan)).toEqual([SECOND.plan]);
    const title = confirmTitle("Riley Thornbury", SECOND.service, "Wednesday, Nov 25");
    expect(title).toBe("Add Riley Thornbury to the Youth Night plan for Wednesday, Nov 25?");
    expect(dom.seen(part("part-second") as never)).toContain(title);
    expect(dom.seen(part("part-second") as never)).toContain("Greeter · Youth Night · Wednesday, Nov 25");
    expect(dom.seen(part("part-first") as never)).not.toContain(title);
    // The first service's part doesn't open that change on its own Riley row.
    expect(buttonIn("part-first", add)).not.toBeNull();
    expect(dom.seen(part("part-first") as never)).not.toContain("Add Riley Thornbury to the");

    await act(async () => { dom.press(buttonIn("part-second", yesAdd("Riley", false)) as never); });
    await act(flush);
    expect(native.calls.filter(c => c.command === "change_confirm").map(c => c.args)).toEqual([{ change: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }]);
    // What came back shows on that service's part only, naming its plan; its new check is what Ozzie waits for.
    const said = "Riley is on the Youth Night plan for Wednesday, Nov 25 as Greeter, unconfirmed.";
    expect(dom.seen(part("part-second") as never)).toContain(said);
    expect(dom.seen(part("part-first") as never)).not.toContain(said);
    expect(buttonIn("part-second", takeOff("Riley"))).not.toBeNull();
    expect(buttonIn("part-first", takeOff("Riley"))).toBeNull();
    expect(wrote).toEqual([SECOND.plan]);

    // While the second service's check is taken again its Add buttons wait; the first service's stay (its check stands).
    expect(buttonIn("part-second", add)).toBeNull();
    expect(dom.seen(part("part-second") as never)).toContain("Checking Planning Center again…");
    expect(buttonIn("part-first", add)).not.toBeNull();
    expect(dom.seen(part("part-first") as never)).not.toContain("Checking Planning Center again…");

    // A change on the first service's own plan goes there.
    await act(async () => { dom.press(buttonIn("part-first", add) as never); });
    await act(flush);
    expect(native.calls.filter(c => c.command === "change_prepare").map(c => c.args?.plan)).toEqual([SECOND.plan, FIRST.plan]);
    expect(dom.seen(part("part-first") as never)).toContain(confirmTitle("Riley Thornbury", FIRST.service, "Sunday, Nov 22"));
    await act(async () => { root.unmount(); });
    dom.root.removeChild(box);
  });

  it("each service waits for its own new check: a change on one never ends another's wait or its 'didn't come' (review L4)", async () => {
    native.answer = (command, args) => Promise.resolve().then(() => command === "changes_status" ? { organization: "1001", on: true }
      : command === "change_prepare" ? proposalFor(args!.plan as string)
        : command === "change_confirm" ? { result: "made", record: recordFor(args!.change === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ? SECOND.plan : FIRST.plan) }
          : Promise.reject("unavailable"));
    // The first service's new check doesn't come; the second one's round never ends.
    const afterWrite = (plan: string) => plan === FIRST.plan ? Promise.resolve(false) : new Promise<boolean>(() => {});
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const box = dom.root.appendChild((document as unknown as { createElement(t: string): typeof dom.root }).createElement("div"));
    const root = createRoot(box as unknown as Element);
    const checked = { [FIRST.plan]: "check-1", [SECOND.plan]: "check-1" };
    await act(async () => { root.render(React.createElement(TwoServices, { afterWrite, checked })); });
    await act(flush);
    const add = addButton("Riley", "Greeter");
    await act(async () => { dom.press(buttonIn("part-first", add) as never); });
    await act(flush);
    await act(async () => { dom.press(buttonIn("part-first", yesAdd("Riley", false)) as never); });
    await act(flush);
    expect(dom.seen(part("part-first") as never)).toContain(RECHECK_FAILED);
    // A change on the second service: its own wait starts; the first service's "didn't come" stays, with no Add.
    await act(async () => { dom.press(buttonIn("part-second", add) as never); });
    await act(flush);
    await act(async () => { dom.press(buttonIn("part-second", yesAdd("Riley", false)) as never); });
    await act(flush);
    expect(Object.keys(shown.c!.rechecks).sort()).toEqual([FIRST.plan, SECOND.plan].sort());
    expect(shown.c!.rechecks[FIRST.plan]!.failed).toBe(true);
    expect(dom.seen(part("part-first") as never)).toContain(RECHECK_FAILED);
    expect(buttonIn("part-first", add)).toBeNull();
    expect(dom.seen(part("part-second") as never)).toContain("Checking Planning Center again…");
    // The first service's new check comes: only its wait ends.
    await act(async () => { root.render(React.createElement(TwoServices, { afterWrite, checked: { ...checked, [FIRST.plan]: "check-2" } })); });
    await act(flush);
    expect(Object.keys(shown.c!.rechecks)).toEqual([SECOND.plan]);
    expect(buttonIn("part-first", add)).not.toBeNull();
    await act(async () => { root.unmount(); });
    dom.root.removeChild(box);
  });

  it("What happened names the service of each change, and keeps listing them with the switch off (review L2, L6)", async () => {
    const record = recordFor(SECOND.plan);
    expect(historyLine(record, "Riley Thornbury", SECOND.service))
      .toBe("You added Riley Thornbury to Greeter on the Youth Night plan for Wednesday, Nov 25 as unconfirmed, with the request waiting. Planning Center accepted it, and Ozzie saw it on the plan afterwards.");
    expect(historyLine(record, "Riley Thornbury")).toContain("to Greeter on Wednesday, Nov 25 as unconfirmed");
    const t = text(renderToStaticMarkup(React.createElement(ChangeHistory, { records: [record], names: capture.names, services: { "1700001": SECOND.service } })));
    expect(t).toContain("on the Youth Night plan for Wednesday, Nov 25");
    // The switch off (after turning it off, or Disconnect's sign-in kept for another church): the list is still read.
    native.calls.length = 0;
    native.answer = command => Promise.resolve().then(() => command === "changes_status" ? { organization: "1001", on: false }
      : command === "change_history" ? [record] : Promise.reject("unavailable"));
    function History() {
      const c = useChanges({ organization: "1001", connected: true, kidsTeamIds: [], afterWrite: () => Promise.resolve(true), showingHistory: true });
      shown.c = c;
      return null;
    }
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const box = dom.root.appendChild((document as unknown as { createElement(t: string): typeof dom.root }).createElement("div"));
    const root = createRoot(box as unknown as Element);
    await act(async () => { root.render(React.createElement(History)); });
    await act(flush);
    expect(shown.c!.on).toBe(false);
    expect(native.calls.map(c => c.command)).toContain("change_history");
    expect(shown.c!.history).toEqual([record]);
    await act(async () => { root.unmount(); });
    dom.root.removeChild(box);
    const app = source("product/desktop/src/App.tsx");
    expect(app).toContain("changes={!offPc && (changesOn || (changes.history?.length ?? 0) > 0)");
  });

  it("Church rules see every watched service's teams, so a kids team of any service can be marked (review M1); a result whose plan has no live part shows above the parts (review L5) (App.tsx)", () => {
    const app = source("product/desktop/src/App.tsx");
    expect(app).toContain("const all = [capture, ...alsoShownCaptures.map(p => p.capture)].filter((c): c is SundayCapture => Boolean(c))");
    expect(app).toContain("<RulesPage rules={rules} onChange={setRules} positions={positions}");
    expect(app).toContain("const resultsElsewhere = changesOn && changes.results.some(r => !liveSlotPlans.includes(r.plan))");
    expect(app).toContain("{page === \"sunday\" && !onGenesis && resultsElsewhere}");
  });

  it("App gives each watched service's part its own slot: its plan, its name, its zone, and its own wait after a change (App.tsx)", () => {
    const app = source("product/desktop/src/App.tsx");
    expect(app).toContain("? changeSlot(liveBrief.plan.id, liveBrief.time_zone, mainName) : null;");
    expect(app).toContain("changes={p && alsoLive(p) ? changeSlot(p.capture.plan_id, p.brief.time_zone, s.name) : null} />");
    expect(app).toContain("const alsoLive = (p: (typeof alsoParts)[number] | undefined) => Boolean(p && p.capture.kind === \"live\" && p.brief.mode === \"live\");");
    // After a write the fresh round is checked for that plan's own new check (another service's arrives during the round).
    expect(app).toContain("if (!alsoNow.current.also.some(x => x.planId === plan)) return check();");
    expect(app).toContain("return ok && Boolean(after) && after !== before;");
  });
});

describe("B1 Church, Breeze and Genesis: no switch, no button, no change line, and their words stay reads only", () => {
  const systemPage = (system: "b1" | "breeze", built: ReturnType<typeof buildSystemBrief>, names: Record<string, string>, withSlot: boolean) => {
    if (!built.ok) throw new Error(built.reason);
    const c = { status: { organization: "1001", on: true }, on: true, connected: true, working: false, problem: null, set: () => undefined, open: null, results: [],
      rechecks: {}, undoable: [], ask: () => undefined, confirm: () => undefined, close: () => undefined, undo: () => undefined, hide: () => undefined,
      history: [], loadHistory: () => undefined, writes: 0 };
    return text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords(system) }, React.createElement(SundayPage, {
      ...pageProps, brief: built.brief, names, openInPlanningCenter: null,
      changes: withSlot ? sundayChanges({ control: c, zone: "America/Chicago", openPc: null, people: true, plan: "PLA0000nov22", service: null }) : null,
    }))));
  };

  it("the service's page never shows an Add button there, even if a slot were passed by mistake", () => {
    const b1 = b1Capture();
    const b1Built = buildSystemBrief(b1, { confirmedZone: "America/Chicago" }, NOW);
    const breeze = breezeCapture();
    const breezeBuilt = buildSystemBrief(breeze, { confirmedZone: "America/Chicago" }, NOW);
    for (const [system, built, names] of [["b1", b1Built, b1.names], ["breeze", breezeBuilt, breeze.names]] as const) {
      const withSlot = systemPage(system, built, names, true);
      expect(withSlot, system).not.toMatch(/in Planning Center…/u);
      expect(withSlot, system).toBe(systemPage(system, built, names, false));
    }
  });

  it("App hands nothing about changes to a church off Planning Center: no church for the hook, no switch, no page slot (App.tsx)", () => {
    const app = source("product/desktop/src/App.tsx");
    expect(app).toContain("const changes = useChanges({ organization: offPc ? \"\" : org, connected: connected && !offPc,");
    expect(app).toContain("const changesOn = !offPc && changes.on;");
    expect(app).toContain("const mainLive = Boolean(liveBrief && capture?.kind === \"live\" && capture.organization === org && !offPc);");
    expect(app).toContain("changes={connected && !offPc ? { section: <ChangesSwitch");
    // The page's own guard: never for another system's brief, whatever App passes (sunday-page.tsx).
    expect(source("product/desktop/src/sunday-page.tsx"))
      .toContain("const changes = brief?.mode === \"live\" && w.system === \"planning-center\" && !brief.source ? props.changes ?? null : null;");
  });

  it("their words say Ozzie only reads them: Ask's help, What happened, the sidebar and Keeping watch", () => {
    for (const system of ["b1", "breeze", "genesis"] as const) {
      const w = systemWords(system);
      const help = helpFor(w);
      expect(help.never, system).toBe(`Ozzie never sends messages, never changes anything in ${w.name}, and never writes prayers, sermons or scripture. People decide and people go.`);
      expect(help.never, system).not.toContain("unless you confirm");
    }
    // Planning Center keeps its own line, true with adding people off as well as on.
    expect(helpFor(systemWords("planning-center")).never).toBe(HELP.never);
    const t = text(renderToStaticMarkup(React.createElement(ActivityPage, { capture: null, tasks: [], system: { name: "B1 Church", check: null } })));
    expect(t).toContain(`${systemPromise("reads", "B1 Church")} ${promise("sends", "A")}`);
    expect(t).not.toContain(promise("reads"));
    const app = source("product/desktop/src/App.tsx");
    expect(app).toContain("promise(\"readsShort\", offPc ? \"A\" : BUILD_FORM)");
    expect(source("product/desktop/src/proactive-page.tsx")).toContain("promise(\"connectAnd\", w.system === \"planning-center\" ? BUILD_FORM : \"A\")");
  });

  it("native code's own refusal there is said plainly, and the switch can't be turned on", () => {
    expect(REFUSALS).toContain("other-system");
    expect(refusalSentence("other-system", { name: "Riley", role: "Greeter" }))
      .toBe("Nothing changed. This Mac keeps a key for B1 Church or Breeze, and Ozzie only reads while it does: it doesn't change Planning Center from here.");
    expect(switchProblem("other-system")).toBe("This Mac keeps a key for B1 Church or Breeze, so Ozzie only reads and this can't be turned on.");
  });
});
