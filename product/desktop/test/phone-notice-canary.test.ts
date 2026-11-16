// "A notice on your phone" carries no name, label or church detail, shown at run time like the calendar and church-read
// canaries (calendar-canary.test.ts, church-reads-canary.test.ts). Every fictional fixture Ozzie has (the fictional
// Sunday, its later check and background checks, rooms, follow-ups and group events, the fictional email and calendar
// import) is loaded, with the calendar and church-read markers on top; then every way a notice is asked for runs for
// real (the Sunday notice, each kind of notice, each also as "this Mac only", and Settings turning the phone notice on,
// testing it, making a new channel and turning it off). Each native call is recorded, and the phone line native would
// send for it is looked up in native's own closed set (core/native-auth phone_notice.rs). No call carries text, and no
// phone line or title holds any name, label, title, place, subject or marker from any fixture.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (...args: unknown[]) => {
    native.calls.push(args);
    if (args[0] === "phone_notice_test") return { outcome: "accepted", at_ms: 1_000 };
    if (String(args[0]).startsWith("phone_notice_")) return { on: true, channel: "ozzie-0123-4567-89ab-cdef-ghjk-mnpq-rstv-wxyz", last: { outcome: "accepted", at_ms: 1_000 } };
    return null;
  }),
}));

import { nov22Capture, nov22LaterCapture, withFictionalBackgroundChecks } from "../../../core/src/fictional-sunday.js";
import { FICTIONAL_CAPTURE_LABELS, FICTIONAL_OPERATION_LABELS, fictionalOperations, withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { harborAttentionImport } from "../../../core/src/fictional-attention.js";
import { notifySundayAttention } from "../src/proactive.js";
import { background } from "../src/background.js";
import { PhoneControl, phoneInvoke, THIS_MAC_ONLY } from "../src/phone-notice.js";
import type { NoticeKind } from "../src/responsibility-runner.js";

const CALENDAR_MARKERS = ["QZX-TITLE-4417", "QZX-PLACE-4417", "QZX-CALNAME-4417", "QZX-LABEL-4417", "QZX-ICS-4417", "QZX-ACCOUNT-4417"];
const CHURCH_MARKERS = ["QZXFORM5521 Volunteer Form", "Quilla Qzxsubmitter", "QZXEVENT5521 Kids", "QZXROOM5521 Nursery", "QZXSIGNUP5521 Retreat"];
/** Keys whose values are text a person or a church wrote: names, titles, places, subjects, bodies. */
const HUMAN = new Set(["name", "title", "team_position_name", "series_title", "subject", "body", "location", "summary", "label", "description", "first_name", "last_name", "quote"]);

/** Every piece of human text in a fixture: the values of names and labels maps, and of the keys above. */
function humanText(value: unknown, key = "", out: string[] = []): string[] {
  if (typeof value === "string") { if (HUMAN.has(key) && /\p{L}/u.test(value)) out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) humanText(v, key, out); return out; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "names" || k === "labels") && v && typeof v === "object") out.push(...Object.values(v as Record<string, unknown>).filter((s): s is string => typeof s === "string"));
      else humanText(v, k, out);
    }
  }
  return out;
}

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** Native's closed set: each line by name, and which line each kind the page names gets. */
function nativeLines() {
  const rust = source("../../../core/native-auth/src/phone_notice.rs");
  const text = rust.split("pub fn text(self)")[1]!.split("pub fn for_notice")[0]!;
  const lines = Object.fromEntries([...text.matchAll(/Line::(\w+) => \{?\s*"([^"]+)"/gu)].map(m => [m[1]!, m[2]!]));
  const kinds = Object.fromEntries([...rust.split("pub fn for_notice")[1]!.split("_ => return None")[0]!.matchAll(/"([a-z-]+)" => Line::(\w+)/gu)].map(m => [m[1]!, m[2]!]));
  const title = /pub const TITLE: &str = "([^"]+)";/u.exec(rust)![1]!;
  return { lines, kinds, title };
}

describe("the phone notice at run time, over every fixture", () => {
  const fixtures = [
    nov22Capture(), nov22LaterCapture(), withFictionalBackgroundChecks(nov22Capture()), withFictionalOperations(nov22Capture()), fictionalOperations(),
    harborAttentionImport(), FICTIONAL_CAPTURE_LABELS, FICTIONAL_OPERATION_LABELS,
  ];
  const texts = [...new Set([...fixtures.flatMap(f => humanText(f)), ...CALENDAR_MARKERS, ...CHURCH_MARKERS].map(t => t.trim()).filter(t => t.length >= 3))];
  // Every word of three letters or more in that text, except the two the notices themselves say.
  const words = [...new Set(texts.flatMap(t => t.split(/[^\p{L}\p{N}'-]+/u)).filter(w => w.length >= 3 && /\p{L}/u.test(w)))];
  const { lines, kinds, title } = nativeLines();

  it("read the fixtures (so the checks below aren't empty)", () => {
    expect(texts).toContain("Avery Brightwater");
    expect(texts).toContain("Greeter");
    expect(texts).toContain("Fellowship room");
    expect(texts.some(t => t.startsWith("Ignore your rules"))).toBe(true);
    expect(texts.length).toBeGreaterThan(30);
    expect(Object.keys(lines)).toHaveLength(6);
    expect(kinds).toEqual({ "briefing-ready": "BriefingReady", "needs-decision": "NeedsDecision", "checked": "Checked", "couldnt-check": "CouldntCheck" });
  });

  it("asks native with no text, and every phone line it could send holds nothing from any fixture", async () => {
    native.calls.length = 0;
    await notifySundayAttention();
    for (const kind of Object.keys(kinds) as NoticeKind[]) await background.notify(kind);
    await notifySundayAttention(THIS_MAC_ONLY);
    for (const kind of Object.keys(kinds) as NoticeKind[]) await background.notify(kind, THIS_MAC_ONLY);
    const control = new PhoneControl(phoneInvoke, () => {});
    await control.load(); await control.change(true); await control.test(); await control.newChannel(); await control.change(false);
    // No call carries any fixture text; the notice commands carry a kind at most, and "this Mac only" as a yes; the
    // phone commands nothing.
    const sent = JSON.stringify(native.calls);
    for (const t of texts) expect(sent.includes(t), t).toBe(false);
    const macOnly = (args: unknown) => (args as { localOnly?: unknown } | undefined)?.localOnly === true;
    for (const call of native.calls) {
      if (call[0] === "notify_ozzie") expect(call[1], JSON.stringify(call)).toEqual(macOnly(call[1]) ? { kind: (call[1] as { kind: string }).kind, localOnly: true } : { kind: (call[1] as { kind: string }).kind });
      else if (call[0] === "notify_sunday_attention" && call.length > 1) expect(call[1]).toEqual({ localOnly: true });
      else expect(call, String(call[0])).toHaveLength(1);
    }
    // The lines those calls bring to the phone, as native picks them: none for "this Mac only".
    const phoned = native.calls.flatMap(call => macOnly(call[1]) ? []
      : call[0] === "notify_sunday_attention" ? [lines["SundayAttention"]!]
        : call[0] === "notify_ozzie" ? [lines[kinds[(call[1] as { kind: string }).kind]!]!]
          : call[0] === "phone_notice_test" ? [lines["Test"]!] : []);
    expect(phoned).toHaveLength(6);
    expect(native.calls.filter(call => macOnly(call[1]))).toHaveLength(5);
    for (const line of [...Object.values(lines), title]) {
      for (const t of texts) expect(line.includes(t), `${line} holds ${t}`).toBe(false);
      const own = new Set(line.split(/[^\p{L}'-]+/u));
      for (const word of words.filter(w => w !== "Sunday" && w !== "Ozzie")) {
        // A person's or place's name is capitalised in the fixtures; an everyday word in a body or subject may be a
        // word the fixed line also uses ("check", "needs"), which says nothing about the church.
        if (/^\p{Lu}/u.test(word) && !/^(?:The|This|Please|No|Include|Ignore|Browse|Weekly|Tonight's|Room|Printing|Sunday|Your|Open)$/u.test(word)) {
          expect(own.has(word), `${line} holds ${word}`).toBe(false);
        }
      }
      expect(line).not.toMatch(/\d/u);
    }
  });
});
