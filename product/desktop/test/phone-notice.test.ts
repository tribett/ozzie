// Settings → A notice on your phone: the words a leader reads say exactly what goes to the phone, who else sees it and
// what never goes, in plain words; the page passes nothing to native but each command's name; native's codes are said
// plainly, the last phone notice among them; the channel is never kept by the page; the phone notice rides on the two
// notice commands the page already holds back for quiet hours and the person's Church rules on notices; and a notice
// only about a background check stays on this Mac. Fixed fictional data only; nothing reaches a network.
import { readdirSync, readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  BACKGROUND_CHECK, COPY_BUTTON, KEEP_BUTTON, LAST_NONE, LAST_RESULTS, lastLine, NEW_BUTTON, NEW_CONFIRM, NEW_DONE, PHONE_BACKGROUND, PHONE_BODY,
  PHONE_COMMANDS, PHONE_EXAMPLE, PHONE_FORGET_PROBLEM, PHONE_HOW, PHONE_NEW_PROBLEM, PHONE_OFF_NOTE, PHONE_OFF_PROBLEM, PHONE_ON_PROBLEM,
  PHONE_QUIET, PHONE_RISK, PHONE_SEEN, PHONE_STEPS, PHONE_SWITCH, PHONE_TITLE, PHONE_UNREADABLE, PHONE_WHAT, PhoneControl, TEST_BUTTON,
  TEST_RESULTS, testResult, THIS_MAC_ONLY, heldMacOnly, thisMacOnly, type Invoke, type LastNotice, type NoticeOptions, type PhoneState,
} from "../src/phone-notice.js";
import { PhoneNoticeSection } from "../src/phone-notice-section.js";
import { ConnectionPage } from "../src/connection-page.js";
import { background } from "../src/background.js";
import { createProactive, type KeyValueStore, type ProactiveDeps, notifySundayAttention } from "../src/proactive.js";
import { createRunner, type NoticeKind, type ResponsibilityNative, type RunnerContext } from "../src/responsibility-runner.js";
import { sundayProblem, type Settings } from "../src/sunday-source.js";
import type { ConnectionStatus } from "../src/connection.js";
import { nov22Capture, PEOPLE, TEAMS } from "../../../core/src/fictional-sunday.js";
import { BACKGROUND_CHECKS } from "../../../core/src/kids-rules.js";
import { DEFAULT_QUIET_HOURS } from "../../../core/src/schedule.js";
import { defaultPlan, TEMPLATES, type Responsibility, type RunRow } from "../../../core/src/harness/responsibilities.js";
import type { FeedbackEntry } from "../../../core/src/finding-feedback.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** The closed set of phone lines, read from native (core/native-auth phone_notice.rs `Line::text`). */
function nativeLines(): Record<string, string> {
  const rust = source("../../../core/native-auth/src/phone_notice.rs");
  const body = rust.split("pub fn text(self)")[1]!.split("pub fn for_notice")[0]!;
  return Object.fromEntries([...body.matchAll(/Line::(\w+) => \{?\s*"([^"]+)"/gu)].map(m => [m[1]!, m[2]!]));
}
const CHANNEL = "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz";
const OTHER = "ozzie-zzzz-yyyy-xxxx-wwww-vvvv-tttt-ssss-rrrr";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const render = (props: Parameters<typeof PhoneNoticeSection>[0]) => renderToStaticMarkup(React.createElement(PhoneNoticeSection, props));
/** What a person reads, without the channel name itself. */
const prose = (html: string) => text(html.replace(/<pre[^]*?<\/pre>/gu, " "));
const TECHNICAL = /\b(?:skills?|sessions?|agents?|logs?|connectors?|harness|MCP|servers?|JSON|protocol|HTTPS?|POST|API|tokens?|endpoints?|URL|webhooks?|push|payload)\b/iu;

describe("the words in Settings", () => {
  it("say what goes to the phone, through whom, and what never does", () => {
    expect(PHONE_TITLE).toBe("A notice on your phone");
    // Every notice Ozzie sends, whether or not this Mac shows it (review N, L1).
    expect(PHONE_BODY).toBe("Each time Ozzie sends a notice, it can send the same short line to your phone too, even if this Mac's own notifications are turned off for Ozzie.");
    expect(PHONE_BODY).not.toMatch(/shows a notice on this Mac/u);
    expect(PHONE_WHAT).toContain("goes through ntfy.sh, a free service Ozzie doesn't run");
    expect(PHONE_WHAT).toContain(`It holds only a fixed line, such as "${PHONE_EXAMPLE}"`);
    expect(PHONE_WHAT).toContain("never a name, a number or a link");
    expect(PHONE_QUIET).toContain("Quiet hours apply");
    expect(PHONE_OFF_NOTE).toBe("Off unless you turn it on. Turning it off stops sending and forgets the channel.");
    // The example is one of native's lines, word for word, and no line holds a digit or a link.
    const lines = Object.values(nativeLines());
    // Four kinds, a test, and the coverage line for each weekday, a weekend and "the service" (onboarding spec §5.2, contract N8).
    expect(lines).toHaveLength(14);
    for (const day of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "This weekend's", "Service"]) {
      expect(lines).toContain(`${day} coverage needs attention. Open Ozzie to see details.`);
    }
    expect(lines).toContain(PHONE_EXAMPLE);
    for (const line of lines) expect(line).not.toMatch(/\d|https?|www\.|\.(?:com|sh|org)\b/u);
    // "At most 12 an hour" and the 10 seconds are native's own numbers; the 12 hold while Ozzie runs (review N, L4).
    const rust = source("../../../core/native-auth/src/phone_notice.rs");
    expect(rust).toContain("pub const PER_HOUR: usize = 12;");
    expect(rust).toContain("pub const SEND_LIMIT: Duration = Duration::from_secs(10);");
    expect(PHONE_HOW).toContain("Phone notices: at most 12 an hour while Ozzie is running, test notices included.");
    expect(PHONE_HOW.join(" ")).toContain("within 10 seconds");
  });

  it("say that anyone with the channel name could also send a notice that looks like Ozzie's (review N, M1)", () => {
    expect(PHONE_RISK).toBe("Anyone who learned your channel name could read those lines too, and could send your phone a notice that looks like Ozzie's. "
      + "Ozzie's own notices are only these fixed lines and never hold a link. That's why Ozzie makes a long, random channel name, and why you can make a new one at any time.");
  });

  it("say who else sees each line and for how long, hedged where it isn't known (review N, M2)", () => {
    expect(PHONE_SEEN).toBe("ntfy.sh, and the phone makers' services it uses to reach your phone (Google's, and Apple's for an iPhone), can see which line was sent and when; "
      + "ntfy.sh also sees this Mac's internet address and keeps each line for a while (about half a day by its usual setting).");
    // ntfy.sh's own setting isn't known: no number of hours is stated as fact.
    for (const line of [PHONE_SEEN, ...PHONE_HOW]) expect(line).not.toMatch(/\b\d+ hours?\b|for some hours/u);
  });

  it("say where the channel name can be seen, and that a notice only about a background check stays on this Mac (review N, L5, L6)", () => {
    expect(PHONE_HOW).toContain("The channel name is kept in this Mac's Keychain. It isn't in the copies Ozzie saves of its checks or in Ozzie's record of what happened.");
    expect(PHONE_HOW).toContain("The channel name is shown on this screen and put on the clipboard when you copy it. If either was shared, in a screen recording or a screenshot for example, make a new one.");
    expect(PHONE_HOW.join(" ")).not.toMatch(/isn't in saved recordings/u);
    expect(PHONE_BACKGROUND).toBe("A notice that is only about a background check stays on this Mac: nothing goes to your phone for it.");
    expect(PHONE_HOW).toContain(PHONE_BACKGROUND);
    expect(PHONE_HOW.join(" ")).toContain("the notice on this Mac is sent either way");
    // A notice already on its way at that moment may still arrive (review N re-check, N3).
    expect(PHONE_HOW).toContain("Making a new channel or turning this off means the old channel gets nothing more from Ozzie, except a notice that was already on its way at that moment.");
  });

  it("say what became of the last phone notice, and when, in this Mac's time (review N, M4)", () => {
    const zone = "America/Chicago";
    const now = Date.parse("2026-11-16T18:00:00Z"); // noon in Chicago
    const at = (iso: string, outcome: string): LastNotice => ({ outcome, at_ms: Date.parse(iso) });
    expect(lastLine(null, now, zone)).toBe(LAST_NONE);
    expect(lastLine(at("2026-11-16T15:02:00Z", "accepted"), now, zone)).toBe("Last notice to your phone: today at 9:02 AM, sent.");
    expect(lastLine(at("2026-11-16T15:02:00Z", "unreachable"), now, zone)).toBe("Last notice to your phone: today at 9:02 AM, not sent: ntfy.sh couldn't be reached.");
    expect(lastLine(at("2026-11-15T21:40:00Z", "too-many"), now, zone)).toBe("Last notice to your phone: yesterday at 3:40 PM, not sent: Ozzie had already sent 12 in the last hour.");
    expect(lastLine(at("2026-11-13T15:02:00Z", "refused"), now, zone)).toBe("Last notice to your phone: Friday, November 13 at 9:02 AM, not sent: ntfy.sh didn't accept it.");
    expect(lastLine(at("2026-11-16T15:02:00Z", "unavailable"), now, zone)).toBe("Last notice to your phone: today at 9:02 AM, not sent: Ozzie couldn't read the channel name.");
    expect(lastLine(at("2026-11-16T15:02:00Z", "off"), now, zone)).toBe("Last notice to your phone: today at 9:02 AM, not sent: this was turned off.");
    // Every one of native's codes has its words.
    expect(Object.keys(LAST_RESULTS).sort()).toEqual(Object.keys(TEST_RESULTS).sort());
  });

  it("give the phone's steps in order: install ntfy, Subscribe to topic, the channel name, then the test notice", () => {
    expect(PHONE_STEPS[0]).toMatch(/install the free ntfy app/u);
    expect(PHONE_STEPS[1]).toContain("Subscribe to topic");
    expect(PHONE_STEPS[2]).toMatch(/^Type or paste the channel name/u);
    expect(PHONE_STEPS[3]).toBe(`Then press ${TEST_BUTTON} here.`);
    expect(TEST_BUTTON).toBe("Send a test notice");
  });

  it("off: the switch and what it would send, no steps and no channel", () => {
    const html = render({ initial: { on: false, channel: null }, invoke: vi.fn() as unknown as Invoke });
    const words = prose(html);
    // A card under "What Ozzie runs and notices" in Settings (audit item 27).
    expect(html).toContain(`<h3 id="phone-title" class="settings-t">${PHONE_TITLE}</h3>`);
    expect(html).not.toMatch(/<input type="checkbox" checked/u);
    for (const line of [PHONE_BODY, PHONE_SWITCH, PHONE_OFF_NOTE, PHONE_WHAT, PHONE_SEEN, PHONE_RISK, PHONE_QUIET, ...PHONE_HOW]) expect(words).toContain(line);
    expect(words).not.toContain(PHONE_STEPS[0]);
    expect(html).not.toContain("<pre");
    expect(html).not.toContain(TEST_BUTTON);
    expect(html).not.toContain("ozzie-");
    expect(words).not.toContain("Last notice to your phone");
    expect(words).not.toContain(LAST_NONE);
  });

  it("on: the steps, the channel with its Copy button, a test notice, the last phone notice and a new channel", () => {
    const html = render({ initial: { on: true, channel: CHANNEL }, invoke: vi.fn() as unknown as Invoke });
    expect(html).toMatch(/<input type="checkbox" checked=""/u);
    expect(html.match(/<li>/gu)).toHaveLength(PHONE_STEPS.length + PHONE_HOW.length);
    for (const step of PHONE_STEPS) expect(prose(html)).toContain(step);
    expect(html).toContain(`<code>${CHANNEL}</code>`);
    for (const button of [COPY_BUTTON, TEST_BUTTON, NEW_BUTTON]) expect(html).toContain(`>${button}</button>`);
    expect(html).not.toContain(KEEP_BUTTON);
    // Under the test button: nothing sent yet, or what became of the last one and when.
    expect(prose(html)).toContain(LAST_NONE);
    expect(html.indexOf(LAST_NONE)).toBeGreaterThan(html.indexOf(`>${TEST_BUTTON}</button>`));
    const now = Date.parse("2026-11-16T18:00:00Z");
    const last = { outcome: "unreachable", at_ms: now - 3 * 60_000 };
    const sent = prose(render({ initial: { on: true, channel: CHANNEL, last }, now: () => now }));
    expect(sent).toContain(lastLine(last, now));
    expect(sent).toMatch(/Last notice to your phone: today at \d{1,2}:\d{2} [AP]M, not sent: ntfy\.sh couldn't be reached\./u);
    // On, but the channel couldn't be read: said plainly, with no test button, and a new channel offered.
    const unread = render({ initial: { on: true, channel: null }, invoke: vi.fn() as unknown as Invoke });
    expect(prose(unread)).toContain(PHONE_UNREADABLE);
    expect(unread).not.toContain(`>${TEST_BUTTON}</button>`);
    expect(unread).toContain(`>${NEW_BUTTON}</button>`);
  });

  it("use plain words, and buttons that name what they do", () => {
    const words = [PHONE_TITLE, PHONE_BODY, PHONE_SWITCH, PHONE_OFF_NOTE, PHONE_WHAT, PHONE_SEEN, PHONE_RISK, PHONE_QUIET, ...PHONE_STEPS, ...PHONE_HOW, NEW_CONFIRM,
      NEW_DONE, PHONE_ON_PROBLEM, PHONE_OFF_PROBLEM, PHONE_FORGET_PROBLEM, PHONE_NEW_PROBLEM, PHONE_UNREADABLE, ...Object.values(TEST_RESULTS),
      LAST_NONE, ...Object.keys(LAST_RESULTS).map(outcome => lastLine({ outcome, at_ms: 0 }, 0)),
      prose(render({ initial: { on: true, channel: CHANNEL } })), prose(render({ initial: { on: false, channel: null } }))];
    for (const line of words) expect(line, line).not.toMatch(TECHNICAL);
    for (const button of [TEST_BUTTON, NEW_BUTTON, KEEP_BUTTON, COPY_BUTTON]) expect(button).not.toMatch(/^(?:Approve|Block|OK|Submit|Yes|No)$/u);
    // The tool is never a person: it prepares and sends a fixed line; no "I".
    for (const line of words) expect(line).not.toMatch(/\bI(?:'m|'ll)?\b/u);
  });

  it("sits in Settings after the closed window, before updates", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPage, {
      status: null, settings: { clientId: "", organization: "", serviceTypeId: "", planId: "" }, onSettings: () => {}, onStatus: () => {}, oneClick: true,
      autostart: { get: async () => false, set: async () => false }, updates: React.createElement("p", null, "UPDATES-HERE"),
      nameStore: { get: () => "", set: () => {} },
    }));
    expect(html.indexOf(PHONE_TITLE)).toBeGreaterThan(html.indexOf("When the window is closed"));
    expect(html.indexOf("UPDATES-HERE")).toBeGreaterThan(html.indexOf(PHONE_TITLE));
  });
});

describe("what the page asks native", () => {
  /** A recording stand-in for native, answering by command. */
  function native(answers: Partial<Record<(typeof PHONE_COMMANDS)[number], unknown>>, fail: string[] = []) {
    const calls: unknown[][] = [];
    const call = (async (...args: unknown[]) => {
      calls.push(args);
      const command = args[0] as string;
      if (fail.includes(command)) throw "unavailable";
      return answers[command as (typeof PHONE_COMMANDS)[number]] ?? null;
    }) as unknown as Invoke;
    return { calls, call };
  }
  const control = (call: Invoke) => { const seen: PhoneState[] = []; return { c: new PhoneControl(call, s => seen.push(s)), seen }; };

  it("passes only each command's name: no text, channel, host or address", async () => {
    const n = native({ phone_notice_status: { on: true, channel: CHANNEL }, phone_notice_on: { on: true, channel: CHANNEL },
      phone_notice_new_channel: { on: true, channel: OTHER }, phone_notice_test: { outcome: "accepted", at_ms: 1 } });
    const { c } = control(n.call);
    await c.load();
    await c.change(true);
    await c.test();
    c.askNew(true);
    await c.newChannel();
    await c.change(false);
    expect(n.calls.map(a => a[0])).toEqual(["phone_notice_status", "phone_notice_on", "phone_notice_test", "phone_notice_new_channel", "phone_notice_off"]);
    for (const args of n.calls) expect(args).toHaveLength(1);
    for (const args of n.calls) expect(PHONE_COMMANDS).toContain(args[0]);
    // The real bridge calls Tauri the same way.
    invoke.mockReset();
    invoke.mockResolvedValue({ on: false, channel: null });
    const real = new PhoneControl((await import("../src/phone-notice.js")).phoneInvoke, () => {});
    await real.load();
    expect(invoke.mock.calls).toEqual([["phone_notice_status"]]);
  });

  it("holds each command's signature in native to the app alone (src-tauri phone_notice.rs)", () => {
    const rust = source("../src-tauri/src/phone_notice.rs").split("#[cfg(test)]")[0]!;
    const commands = [...rust.matchAll(/#\[tauri::command\]\npub async fn (\w+)\(([^)]*)\)/gu)].map(m => [m[1], m[2]!.trim()]);
    expect(commands).toEqual(PHONE_COMMANDS.map(name => [name, "app: tauri::AppHandle"]));
    const main = source("../src-tauri/src/main.rs");
    for (const name of PHONE_COMMANDS) expect(main).toContain(`phone_notice::${name},`);
  });

  it("says each of native's test codes plainly, and anything else as not sent", () => {
    const rust = source("../../../core/native-auth/src/phone_notice.rs");
    const body = /pub enum Outcome \{([^}]*)\}/u.exec(rust)![1]!;
    const codes = [...body.matchAll(/^\s{4}([A-Z][A-Za-z]+),$/gmu)].map(m => m[1]!.replace(/[A-Z]/gu, (ch, i: number) => (i ? "-" : "") + ch.toLowerCase()));
    expect(codes.sort()).toEqual(Object.keys(TEST_RESULTS).sort());
    expect(codes.sort()).toEqual(Object.keys(LAST_RESULTS).sort());
    expect(rust).toContain("#[serde(rename_all = \"kebab-case\")]\npub enum Outcome");
    // The last notice native keeps: a code and a time, by these field names.
    expect(rust).toMatch(/pub struct LastNotice \{\s*pub outcome: Outcome,\s*pub at_ms: u64,\s*\}/u);
    expect(testResult("accepted")).toMatch(/^ntfy\.sh accepted the test notice/u);
    for (const other of ["constructor", "", undefined, { code: "accepted" }, 7, "sent"]) expect(testResult(other)).toBe(TEST_RESULTS["unavailable"]);
  });

  it("turns on and shows the channel native made; a failure says so and leaves it as native has it", async () => {
    const ok = control(native({ phone_notice_on: { on: true, channel: CHANNEL } }).call);
    await ok.c.change(true);
    expect(ok.c.state).toMatchObject({ on: true, channel: CHANNEL, busy: false, problem: null });
    const failed = control(native({ phone_notice_status: { on: false, channel: null } }, ["phone_notice_on"]).call);
    await failed.c.change(true);
    expect(failed.c.state).toMatchObject({ on: false, channel: null, problem: PHONE_ON_PROBLEM, busy: false });
    // Something native didn't send as a view is off, never a channel.
    for (const odd of ["ozzie-x", { on: "yes", channel: CHANNEL }, { on: false, channel: CHANNEL }, { on: true, channel: 7 }, null]) {
      const c = control(native({ phone_notice_status: odd }).call).c;
      await c.load();
      expect(c.state.channel, JSON.stringify(odd)).toBeNull();
    }
  });

  it("turning off: forgotten, or still on and said so, or stopped but not yet forgotten", async () => {
    const ok = control(native({}).call);
    await ok.c.change(false);
    expect(ok.c.state).toMatchObject({ on: false, channel: null, problem: null });
    const stillOn = control(native({ phone_notice_status: { on: true, channel: CHANNEL } }, ["phone_notice_off"]).call);
    await stillOn.c.change(false);
    expect(stillOn.c.state).toMatchObject({ on: true, channel: CHANNEL, problem: PHONE_OFF_PROBLEM });
    const notForgotten = control(native({ phone_notice_status: { on: false, channel: null } }, ["phone_notice_off"]).call);
    await notForgotten.c.change(false);
    expect(notForgotten.c.state).toMatchObject({ on: false, channel: null, problem: PHONE_FORGET_PROBLEM });
  });

  it("asks before making a new channel, and keeps the old one when it couldn't", async () => {
    const n = native({ phone_notice_new_channel: { on: true, channel: OTHER }, phone_notice_status: { on: true, channel: CHANNEL } });
    const { c } = control(n.call);
    c.askNew(true);
    expect(c.state.confirmingNew).toBe(true);
    c.askNew(false);
    expect(n.calls).toEqual([]);
    await c.newChannel();
    expect(c.state).toMatchObject({ channel: OTHER, note: NEW_DONE, confirmingNew: false });
    const failed = control(native({ phone_notice_status: { on: true, channel: CHANNEL } }, ["phone_notice_new_channel"]).call);
    await failed.c.newChannel();
    expect(failed.c.state).toMatchObject({ channel: CHANNEL, problem: PHONE_NEW_PROBLEM });
    const html = renderToStaticMarkup(React.createElement(PhoneNoticeSection, { initial: { on: true, channel: CHANNEL } }));
    expect(html).not.toContain(NEW_CONFIRM);
  });

  it("reports the test notice in plain words, whatever native answers, and shows it as the last phone notice", async () => {
    for (const outcome of ["accepted", "too-many", "refused", "unreachable"] as const) {
      const { c } = control(native({ phone_notice_test: { outcome, at_ms: 5_000 } }).call);
      await c.test();
      expect(c.state.note).toBe(TEST_RESULTS[outcome]);
      expect(c.state.last).toEqual({ outcome, at_ms: 5_000 });
    }
    // Anything else: not sent, and the last notice shown stays as it was.
    const before = { outcome: "accepted", at_ms: 1_000 };
    for (const odd of ["accepted", { outcome: "sent", at_ms: 1 }, { outcome: "accepted", at_ms: "now" }, { outcome: "accepted" }, null]) {
      const c = new PhoneControl(native({ phone_notice_test: odd }).call, () => {}, { on: true, channel: CHANNEL, last: before });
      await c.test();
      expect(c.state.note, JSON.stringify(odd)).toBe(TEST_RESULTS["unavailable"]);
      expect(c.state.last).toEqual(before);
    }
    const failed = control(native({}, ["phone_notice_test"]).call);
    await failed.c.test();
    expect(failed.c.state.note).toBe(TEST_RESULTS["unavailable"]);
  });

  it("shows the last phone notice native kept, whether from a test or a real notice, only while on (review N, M4)", async () => {
    // A real notice went while Settings was closed: native kept it; opening Settings shows it.
    const real = { outcome: "unreachable", at_ms: Date.parse("2026-11-16T15:02:00Z") };
    const { c } = control(native({ phone_notice_status: { on: true, channel: CHANNEL, last: real } }).call);
    await c.load();
    expect(c.state.last).toEqual(real);
    // Then the test button: the line follows it.
    const n = native({ phone_notice_status: { on: true, channel: CHANNEL, last: real }, phone_notice_test: { outcome: "accepted", at_ms: real.at_ms + 60_000 } });
    const t = control(n.call);
    await t.c.load();
    await t.c.test();
    expect(t.c.state.last).toEqual({ outcome: "accepted", at_ms: real.at_ms + 60_000 });
    // Off: none shown, whatever arrives; turning off forgets it on the page too.
    const off = control(native({ phone_notice_status: { on: false, channel: null, last: real } }).call);
    await off.c.load();
    expect(off.c.state.last).toBeNull();
    await t.c.change(false);
    expect(t.c.state.last).toBeNull();
    // Native's real notices keep it too: each one goes through `send`, which keeps the last (core tests), and the test
    // command returns it (src-tauri phone_notice.rs).
    const tauri = source("../src-tauri/src/phone_notice.rs").split("#[cfg(test)]")[0]!;
    expect(tauri).toContain("let _ = phone.send(line);");
    expect(tauri).toContain("pub async fn phone_notice_test(app: tauri::AppHandle) -> LastNotice {");
    expect(tauri).toContain(".map(|phone| phone.send_noted(Line::Test))");
  });
});

describe("the channel stays where native keeps it", () => {
  it("is never saved by the page, written to the task record or a developer line", async () => {
    for (const file of ["../src/phone-notice.ts", "../src/phone-notice-section.tsx"]) {
      const code = source(file).split("\n").filter(l => !/^\s*(?:\/\/|\*|\/\*\*)/u.test(l)).join("\n");
      for (const refused of ["localStorage", "sessionStorage", "indexedDB", "browserStore", "ledger", "dev_log", "console.", "desktopRecorder", "harness", "fetch("]) {
        expect(code, `${file}: ${refused}`).not.toContain(refused);
      }
    }
    // And at run time: a whole round of on, test, new channel and off touches no storage.
    const writes: string[] = [];
    const storage = { getItem: () => null, setItem: (k: string) => { writes.push(k); }, removeItem: (k: string) => { writes.push(k); } };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    try {
      const c = new PhoneControl((async (command: string) => command === "phone_notice_test" ? "accepted" : { on: true, channel: CHANNEL }) as unknown as Invoke, () => {});
      await c.load(); await c.change(true); await c.test(); await c.newChannel(); await c.change(false);
      expect(writes).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("the phone notice rides on the notices the page already holds back", () => {
  beforeEach(() => invoke.mockReset());

  it("is sent natively only from the two notice commands, which the page reaches with no text, only ever adding \"this Mac only\"", async () => {
    invoke.mockResolvedValue(undefined);
    await notifySundayAttention();
    for (const kind of ["briefing-ready", "needs-decision", "checked", "couldnt-check"] as const) await background.notify(kind);
    expect(invoke.mock.calls).toEqual([["notify_sunday_attention"], ...["briefing-ready", "needs-decision", "checked", "couldnt-check"].map(kind => ["notify_ozzie", { kind }])]);
    // "This Mac only": one more word, a yes, and nothing else.
    invoke.mockClear();
    await notifySundayAttention(THIS_MAC_ONLY);
    await background.notify("needs-decision", THIS_MAC_ONLY);
    expect(invoke.mock.calls).toEqual([["notify_sunday_attention", { localOnly: true }], ["notify_ozzie", { kind: "needs-decision", localOnly: true }]]);
    expect(THIS_MAC_ONLY).toEqual({ localOnly: true });
    expect(Object.isFrozen(THIS_MAC_ONLY)).toBe(true);
    // The schedule and what Ozzie keeps an eye on reach native through exactly these (proactive.ts, App.tsx).
    expect(source("../src/proactive.ts")).toContain("    notify: notifySundayAttention,\n");
    // App's own wrapper only remembers that a notice was sent (for the phone question, spec §4.2), then passes it on.
    expect(source("../src/App.tsx")).toContain("  notify: (kind, options) => background.notify(kind, options).then(sent => { moments.noticeSent(); return sent; }),");
    // Native maps each kind to its line and sends nothing for a kind it doesn't know (src-tauri phone_notice.rs tests).
    const rust = source("../../../core/native-auth/src/phone_notice.rs");
    for (const kind of ["briefing-ready", "needs-decision", "checked", "couldnt-check"]) expect(rust).toContain(`"${kind}" => Line::`);
  });

  /** The Sunday schedule's own controller with the real notice command, as desktopProactive builds it. */
  function sunday(start: string, over: Partial<SundayRules> = {}) {
    let now = start;
    let change: ((c: SundayCapture) => void) | undefined;
    const data = new Map<string, string>();
    const store: KeyValueStore = { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } };
    const settings: Settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
    const status: ConnectionStatus = { state: "connected", organization: "1001", checked_at_ms: null, source: "", problem: null };
    let rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3, ...over };
    const captureAt = (iso: string): SundayCapture => {
      const c = nov22Capture();
      change?.(c);
      const delta = Date.parse(iso) - Date.parse(c.completed_at);
      const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString();
      return { ...c, started_at: shift(c.started_at), completed_at: shift(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
    };
    const deps: ProactiveDeps = { store, now: () => now, timeZone: () => "America/Chicago", check: async () => captureAt(now), notify: notifySundayAttention,
      problem: sundayProblem, timers: { setInterval: () => 0, clearInterval: () => {} } };
    const p = createProactive(deps);
    const notices = () => invoke.mock.calls.filter(c => c[0] === "notify_sunday_attention").length;
    return { p, notices, set: (iso: string) => { now = iso; }, changeTo: (f: (c: SundayCapture) => void) => { change = f; },
      setRules: (next: Partial<SundayRules>) => { rules = { sundayLeads: [], checkInAfterSundaysInARow: 3, ...next }; },
      launch: async () => { p.start({ context: () => ({ settings, rules, status }), onStatus: () => {}, onCapture: () => {} }); await p.tick(); } };
  }
  type Row = { id: string; attributes: Record<string, unknown> };
  const rows = (c: SundayCapture, collection: string) => c.reads.find(r => r.collection === collection)!.body!.data as Row[];
  const decline = (c: SundayCapture) => {
    rows(c, "team_members").find(m => m.id === "401")!.attributes.status = "D";
    rows(c, "needed_positions").find(n => n.attributes.team_position_name === "Greeter")!.attributes.quantity = 2;
  };

  it("quiet hours: no notice command (so nothing to the phone) until they end, then one", async () => {
    invoke.mockResolvedValue(undefined);
    const h = sunday("2026-11-21T02:30:00Z"); // 8:30 PM in Chicago
    await h.launch();
    h.changeTo(decline);
    h.set("2026-11-21T04:00:00Z"); // 10 PM: quiet
    await h.p.tick();
    expect(h.notices()).toBe(0);
    h.set("2026-11-21T12:50:00Z"); // 6:50 AM: still quiet
    await h.p.tick();
    expect(h.notices()).toBe(0);
    h.set("2026-11-21T13:01:00Z"); // 7:01 AM
    await h.p.tick();
    expect(h.notices()).toBe(1);
  });

  it("Worth a look, without \"Always tell me right away\" for its kind: no notice command at all, so nothing to the phone", async () => {
    invoke.mockResolvedValue(undefined);
    const h = sunday("2026-11-20T15:00:00Z");
    await h.launch();
    h.changeTo(c => { rows(c, "team_members").find(m => m.id === "403")!.attributes.status = "D"; });
    h.set("2026-11-20T16:00:00Z");
    await h.p.tick();
    expect(h.p.view().history[0]!.changes!.map(c => c.kind)).toEqual(["pending-declined"]);
    expect(h.notices()).toBe(0);
    expect(invoke.mock.calls.filter(c => String(c[0]).startsWith("notify") || String(c[0]).startsWith("phone"))).toEqual([]);
  });

  // ---- A notice only about a background check stays on this Mac (review N, L6) ----------------------------------

  /** Planning Center People's background check for the Nursery volunteer, expiring on `expires`. */
  const onFile = (expires: string) => (c: SundayCapture) => {
    c.reads.push({ collection: BACKGROUND_CHECKS, people_person_id: PEOPLE.nurseryConfirmed, offset: 0, checked_at: c.completed_at, outcome: "ok", body: {
      data: [{ type: "BackgroundCheck", id: "901", attributes: { status: "complete_clear", current: true, expires_on: expires }, relationships: { person: { data: { type: "Person", id: PEOPLE.nurseryConfirmed } } } }],
      meta: { count: 1, total_count: 1 } } });
  };
  const expired = onFile("2026-11-01");
  const kids = (feedback: FeedbackEntry[] = []): Partial<SundayRules> => ({ kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 1 }], feedback });
  const rightAway = (kind: string): FeedbackEntry => ({ type: "urgency", id: `r-${kind}`, kind, at: "2026-11-20T14:00:00Z", level: "right-away" });
  const sundayNotices = () => invoke.mock.calls.filter(c => c[0] === "notify_sunday_attention");

  it("names the flag the same on both sides: the page sends localOnly, native takes local_only, and nothing renames it (review N re-check, N3)", () => {
    // Tauri maps a command's snake_case argument to the page's camelCase key unless the command says otherwise.
    const camel = (snake: string) => snake.replace(/_([a-z])/gu, (_, c: string) => c.toUpperCase());
    expect(camel("local_only")).toBe("localOnly");
    const rust = (file: string) => source(`../src-tauri/src/${file}`);
    for (const [file, fn] of [["always_on.rs", "pub fn notify_ozzie("], ["main.rs", "fn notify_sunday_attention("]] as const) {
      const code = rust(file);
      const at = code.indexOf(fn);
      expect(at, fn).toBeGreaterThan(0);
      // The attribute right above it is the bare command, with no rename of its arguments.
      const above = code.slice(0, at).trimEnd().split("\n").at(-1)!.trim();
      expect(above, fn).toBe("#[tauri::command]");
      const params = code.slice(at).split("{")[0]!;
      // The coverage notice also takes its day as a closed code (contract N8), after the flag.
      expect(params, fn).toMatch(/\blocal_only: Option<bool>,?\s*(?:day: Option<String>,?\s*)?\)/u);
      expect(params, fn).not.toMatch(/localOnly|rename/u);
    }
    // Nowhere in the app does a command attribute take arguments (rename_all or anything else).
    const files = readdirSync(new URL("../src-tauri/src/", import.meta.url)).filter(f => f.endsWith(".rs"));
    expect(files).toEqual(expect.arrayContaining(["always_on.rs", "main.rs", "phone_notice.rs"]));
    for (const file of files) expect(rust(file), file).not.toMatch(/#\[\s*tauri::command\s*\(|#\[\s*command\s*\(/u);
    // The page: both call sites send exactly `localOnly: true`, and no other spelling reaches a notice command.
    expect(source("../src/proactive.ts")).toContain('const args = { ...(options?.localOnly ? { localOnly: true } : {}), ...(options?.day ? { day: options.day } : {}) };');
    expect(source("../src/proactive.ts")).toContain('invoke<void>("notify_sunday_attention", args)');
    expect(source("../src/background.ts")).toContain('invoke<void>("notify_ozzie", options?.localOnly ? { kind, localOnly: true } : { kind })');
    for (const file of readdirSync(new URL("../src/", import.meta.url)).filter(f => /\.tsx?$/u.test(f))) {
      const page = source(`../src/${file}`);
      for (const line of page.split("\n").filter(l => /"notify_(?:ozzie|sunday_attention)"/u.test(l) && /invoke/u.test(l))) {
        expect(line, file).not.toMatch(/local_only|localonly|LocalOnly|"localOnly"/u);
      }
    }
  });

  it("says a notice stays on this Mac only when every finding that brought it is a background check", () => {
    expect(BACKGROUND_CHECK).toBe("background-check");
    expect(source("../../../core/src/kids-rules.ts")).toContain('kind: "background-check"');
    expect(thisMacOnly(["background-check"])).toBe(true);
    expect(thisMacOnly(["background-check", "background-check"])).toBe(true);
    for (const mixed of [[], ["background-check", "needs-people"], ["background-check", null], [null], ["too-few-confirmed"], [undefined]]) {
      expect(thisMacOnly(mixed), JSON.stringify(mixed)).toBe(false);
    }
  });

  it("the Sunday notice: a background check newly expired, told right away, stays on this Mac; mixed with an open role, the phone line goes", async () => {
    for (const mixed of [false, true]) {
      invoke.mockReset();
      invoke.mockResolvedValue(undefined);
      const h = sunday("2026-11-20T15:00:00Z", kids([rightAway("background-check")]));
      h.changeTo(onFile("2027-06-01"));
      await h.launch();
      h.changeTo(c => { expired(c); if (mixed) decline(c); });
      h.set("2026-11-20T16:00:00Z");
      await h.p.tick();
      // The Mac's notice goes either way; only the phone line is kept back, and only when nothing else brought it.
      // The day is the checked plan's (a Sunday here), a closed code beside the flag (native contract N8).
      expect(sundayNotices(), `mixed: ${mixed}`).toEqual([mixed ? ["notify_sunday_attention", { day: "sunday" }] : ["notify_sunday_attention", { localOnly: true, day: "sunday" }]]);
      expect(h.p.view().history[0]).toMatchObject({ kind: "changes", notice: "sent" });
    }
  });

  it("the Sunday notice held for quiet hours: still only about a background check when it goes, still on this Mac", async () => {
    invoke.mockResolvedValue(undefined);
    const h = sunday("2026-11-21T02:30:00Z", kids([rightAway("background-check")])); // 8:30 PM in Chicago
    h.changeTo(onFile("2027-06-01"));
    await h.launch();
    h.changeTo(expired);
    h.set("2026-11-21T04:00:00Z"); // 10 PM: quiet
    await h.p.tick();
    expect(sundayNotices()).toEqual([]);
    expect(h.p.view().history[0]!.notice).toBe("held");
    h.set("2026-11-21T13:01:00Z"); // 7:01 AM
    await h.p.tick();
    expect(sundayNotices()).toEqual([["notify_sunday_attention", { localOnly: true, day: "sunday" }]]);
  });

  /** The runner with a small stand-in for the native store, the fictional Sunday and Church rules with a kids team. */
  function keepSundayCovered(feedback: FeedbackEntry[] = []) {
    const ET = "America/New_York";
    let now = "2026-11-20T15:00:00.000Z";
    let change: ((c: SundayCapture) => void) | undefined = onFile("2027-06-01");
    const items: Responsibility[] = [];
    let n = 0;
    const id = (k: number) => `00000000-0000-4000-8000-${k.toString(16).padStart(12, "0")}`;
    const find = (rid: string) => { const r = items.find(x => x.id === rid); if (!r) throw "unknown"; return r; };
    const refused = async (): Promise<never> => { throw "unavailable"; };
    const store: ResponsibilityNative = {
      list: async () => ({ paused_all: false, items: structuredClone(items) }),
      create: async plan => {
        const t = TEMPLATES[plan.template];
        const r: Responsibility = { ...structuredClone(plan), id: id(++n), title: t.title, skill_id: t.skill_id, status: "active", created_at: now, confirmed_at: now, runs: [], open_run: null };
        items.push(r);
        return structuredClone(r);
      },
      edit: refused, pause: refused, resume: refused, stop: refused, pauseAll: refused,
      begin: async (rid, trigger) => {
        const run: RunRow = { run_id: id(1000 + ++n), trigger, started_at: now, ended_at: null, outcome: null, code: null, noticed: 0, drafts: 0, ai_steps: 0 };
        find(rid).runs.unshift(run);
        find(rid).open_run = run;
        return { run_id: run.run_id, ai_steps: 0, checks_left: 5 };
      },
      end: async (rid, runId, outcome, code, noticed, drafts) => {
        Object.assign(find(rid).runs.find(x => x.run_id === runId)!, { ended_at: now, outcome, code, noticed, drafts });
        find(rid).open_run = null;
        return structuredClone(find(rid));
      },
    };
    const notify = vi.fn<(kind: NoticeKind, options?: NoticeOptions) => Promise<void>>(async () => {});
    const data = new Map<string, string>();
    const runner = createRunner({ native: store, store: { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } }, now: () => now, notify });
    const context: RunnerContext = {
      ready: true, granted: ["services"], rules: { sundayLeads: [], checkInAfterSundaysInARow: 3, ...kids(feedback) }, zone: ET, macZone: ET,
      quiet: DEFAULT_QUIET_HOURS, urgentWithinHours: 48, modelReady: false,
    };
    const captureAt = (iso: string): SundayCapture => {
      const c = nov22Capture();
      change?.(c);
      const delta = Date.parse(iso) - Date.parse(c.completed_at);
      const shift = (t: string) => new Date(Date.parse(t) + delta).toISOString();
      return { ...c, started_at: shift(c.started_at), completed_at: shift(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: shift(r.checked_at) })) };
    };
    runner.start({ context: () => context, check: async () => captureAt(now), prepare: async () => null });
    /** What the regular Sunday check hands over, so Keep Sunday covered runs sooner. */
    const handed = () => runner.changes([{ id: "need-increased:x", kind: "need-increased", effect: "worse", urgency: "attention", position: "Greeter", from: 1, to: 2 }]);
    /**
     * Checks asked for by hand, a minute apart, until the run record of the held notice `item` is pushed out of what
     * Ozzie keeps (NOTICED_KEPT): the notice itself stays held, with nothing left to recheck it against.
     */
    const pushOut = async (id: string, item: string) => {
      for (let k = 1; k <= 60 && runner.view().noticed.some(i => i.id === item); k++) {
        now = new Date(Date.parse(now) + 60_000).toISOString();
        await runner.runNow(id);
      }
      expect(runner.view().noticed.some(i => i.id === item), "the held notice's record is gone").toBe(false);
    };
    return {
      runner, notify, handed, context, pushOut, now: () => now, set: (iso: string) => { now = iso; }, changeTo: (f: (c: SundayCapture) => void) => { change = f; },
      start: async () => { const r = await runner.create(defaultPlan("keep-sunday-covered", now, ET)); await runner.tick(); return r; },
    };
  }

  it("Keep services covered: a background check newly found missing stays on this Mac; with an open role too, the phone line goes", async () => {
    for (const mixed of [false, true]) {
      const h = keepSundayCovered();
      await h.start();
      expect(h.notify).not.toHaveBeenCalled();
      h.set("2026-11-20T17:00:00.000Z"); // noon in New York
      h.changeTo(c => { expired(c); if (mixed) decline(c); });
      await h.handed();
      expect(h.notify.mock.calls, `mixed: ${mixed}`).toEqual([mixed ? ["needs-decision"] : ["needs-decision", THIS_MAC_ONLY]]);
      expect(h.runner.view().noticed[0]).toMatchObject({ kind: "found", trigger: "change", notice: "sent" });
    }
  });

  it("Keep Sunday covered held for quiet hours: rechecked when it goes, and still on this Mac if only the background check holds", async () => {
    const h = keepSundayCovered();
    await h.start();
    h.set("2026-11-21T04:00:00.000Z"); // 11 PM in New York: quiet
    h.changeTo(expired);
    await h.handed();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.runner.view().noticed[0]!.notice).toBe("held");
    h.set("2026-11-21T12:30:00.000Z"); // 7:30 AM
    await h.runner.tick();
    expect(h.notify.mock.calls).toEqual([["needs-decision", THIS_MAC_ONLY]]);
  });

  // ---- Held notices whose cause can't be rechecked, or has changed (review N re-check, N2) -------------------------

  it("the rule for a held notice: what can be rechecked decides; what can't falls back to what was so when it was held", () => {
    const bg = BACKGROUND_CHECK;
    // Rechecked: only background checks still bring it → this Mac; anything else too → the phone, whatever it was held as.
    expect(heldMacOnly(true, [bg])).toBe(true);
    expect(heldMacOnly(false, [bg])).toBe(true);
    expect(heldMacOnly(true, [bg, "needs-people"])).toBe(false);
    expect(heldMacOnly(true, ["needs-people"])).toBe(false);
    expect(heldMacOnly(true, [null])).toBe(false);
    expect(heldMacOnly(undefined, [bg])).toBe(true);
    // Can't be rechecked: what it was held as.
    expect(heldMacOnly(true, null)).toBe(true);
    expect(heldMacOnly(false, null)).toBe(false);
    // Neither known (held before this was kept): the phone line goes, as it always did.
    expect(heldMacOnly(undefined, null)).toBe(false);
    // Never more phone lines than the stricter "held only about background checks AND still so" rule would send.
    for (const held of [true, false, undefined]) {
      for (const now of [[bg], [bg, "needs-people"], ["pending"], [null], null]) {
        const both = held !== false && (now === null ? held === true : thisMacOnly(now));
        if (both) expect(heldMacOnly(held, now), JSON.stringify([held, now])).toBe(true);
      }
    }
  });

  it("Keep Sunday covered held, only about a background check, whose run record is gone by morning: still stays on this Mac", async () => {
    const h = keepSundayCovered();
    const r = await h.start();
    h.set("2026-11-21T04:00:00.000Z"); // 11 PM in New York: quiet
    h.changeTo(expired);
    await h.handed();
    const item = h.runner.view().noticed[0]!;
    expect(item).toMatchObject({ trigger: "change", notice: "held" });
    await h.pushOut(r.id, item.id);
    h.set("2026-11-21T12:30:00.000Z"); // 7:30 AM
    await h.runner.tick();
    expect(h.notify.mock.calls).toEqual([["needs-decision", THIS_MAC_ONLY]]);
  });

  it("Keep Sunday covered held, mixed with an open role: the phone line goes, whether or not its record is still there", async () => {
    for (const gone of [false, true]) {
      const h = keepSundayCovered();
      const r = await h.start();
      h.set("2026-11-21T04:00:00.000Z");
      h.changeTo(c => { expired(c); decline(c); });
      await h.handed();
      const item = h.runner.view().noticed[0]!;
      expect(item.notice).toBe("held");
      if (gone) await h.pushOut(r.id, item.id);
      h.set("2026-11-21T12:30:00.000Z");
      await h.runner.tick();
      expect(h.notify.mock.calls, `record gone: ${gone}`).toEqual([["needs-decision"]]);
    }
  });

  it("Keep Sunday covered held, only about a background check, that has since gained another cause: the phone line goes", async () => {
    // "Put this in the briefing" for open roles: the decline is kept for the briefing, so only the background check
    // brings the notice when it is held.
    const h = keepSundayCovered([{ type: "urgency", id: "b", kind: "needs-people", at: "2026-11-20T14:00:00Z", level: "briefing" }]);
    await h.start();
    h.set("2026-11-21T04:00:00.000Z");
    h.changeTo(c => { expired(c); decline(c); });
    await h.handed();
    expect(h.runner.view().noticed[0]!.notice).toBe("held");
    // Overnight the person takes open roles out of the briefing: the decline now brings the notice too.
    h.context.rules = { ...h.context.rules, feedback: [] };
    h.set("2026-11-21T12:30:00.000Z");
    await h.runner.tick();
    expect(h.notify.mock.calls).toEqual([["needs-decision"]]);
  });

  it("Keep Sunday covered held, mixed, whose open role was filled again before morning: only the background check holds, so it stays on this Mac", async () => {
    const h = keepSundayCovered();
    const r = await h.start();
    h.set("2026-11-21T04:00:00.000Z");
    h.changeTo(c => { expired(c); decline(c); });
    await h.handed();
    expect(h.runner.view().noticed[0]!.notice).toBe("held");
    // A later check that night: the decline is undone; the background check is still missing.
    h.set("2026-11-21T05:00:00.000Z");
    h.changeTo(expired);
    await h.runner.runNow(r.id);
    h.set("2026-11-21T12:30:00.000Z");
    await h.runner.tick();
    expect(h.notify.mock.calls).toEqual([["needs-decision", THIS_MAC_ONLY]]);
  });

  it("the Sunday notice held, only about a background check, that has since gained another cause: the phone line goes", async () => {
    invoke.mockResolvedValue(undefined);
    const briefing: FeedbackEntry = { type: "urgency", id: "b", kind: "needs-people", at: "2026-11-20T14:00:00Z", level: "briefing" };
    const h = sunday("2026-11-21T02:30:00Z", kids([rightAway("background-check"), briefing]));
    h.changeTo(onFile("2027-06-01"));
    await h.launch();
    h.changeTo(c => { expired(c); decline(c); });
    h.set("2026-11-21T04:00:00Z"); // 10 PM: quiet
    await h.p.tick();
    expect(h.p.view().history[0]!.notice).toBe("held");
    // The Sunday check keeps each held entry's own changes, so its cause can always be rechecked: no stored value needed.
    h.setRules(kids([rightAway("background-check")]));
    h.set("2026-11-21T13:01:00Z"); // 7:01 AM
    await h.p.tick();
    expect(sundayNotices()).toEqual([["notify_sunday_attention", { day: "sunday" }]]);
  });
});
