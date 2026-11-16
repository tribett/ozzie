// The church reads (People forms, Check-Ins, Registrations) stay on this Mac, shown at run time beside the lane's own
// boundary test (core/test/church-reads-boundary.test.ts). A live check holds unique markers in a form's name, a
// submitter's name, a Check-Ins event and room, and a signup's name, and Church rules hold entries made from the room's
// card (its labels name the room). Then every way something leaves Ozzie runs for real, from HarnessData built the way
// App builds it: Ask through the real harness (a Sunday question, a drafted note and a Check-Ins question), rewording a
// note, the copy for other AI apps, the copy Siri and Shortcuts answer from and what Siri would say from it, both
// notices, and Today's briefing script. No marker is in any model request, any argument of a native command that
// sends or saves, the Siri answer or the briefing; Today's church section shows them, so the markers really were read.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ calls: [] as [string, unknown][] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => { native.calls.push([command, args]); return command === "reword_draft" ? "Hi [Volunteer A], could you help?" : null; }),
}));

import { CHECKED, nov22Capture, TEAMS } from "../../../core/src/fictional-sunday.js";
import type { SundayCapture, SundayRead, SundayRules } from "../../../core/src/sunday-capture.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { checkInsFacts, checkInsTarget, formsFacts, registrationsFacts } from "../../../core/src/church-reads/index.js";
import { correctionEntry, stopEntry, stopScopes } from "../../../core/src/finding-feedback.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import type { ToolEnvelope } from "../../../core/src/harness/contract.js";
import { buildRewordRequest, templateDraft } from "../../../core/src/draft-request.js";
import { sharedCheckText } from "../../../core/mcp/snapshot.js";
import { shortcutsAnswer } from "../../../core/mcp/shortcuts.js";
import type { ConnectionStatus } from "../src/connection.js";
import { askOzzie, buildHarnessData, createAppHarness, type Invoke } from "../src/harness-bridge.js";
import { model } from "../src/model.js";
import { syncShared } from "../src/share-check.js";
import { syncShortcuts } from "../src/siri-shortcuts.js";
import { notifySundayAttention } from "../src/proactive.js";
import { background } from "../src/background.js";
import { TodayPage } from "../src/today-page.js";
import { ChurchReadsToday } from "../src/church-reads-view.js";
import { answer, draftTurns, greeterTurns, scripted, RULES } from "./harness-fakes.js";

const FORM = "QZXFORM5521 Volunteer Form", SUBMITTER = "Quilla Qzxsubmitter", EVENT = "QZXEVENT5521 Kids", ROOM = "QZXROOM5521 Nursery", SIGNUP = "QZXSIGNUP5521 Retreat";
const MARKERS = ["QZXFORM5521", "Qzxsubmitter", "QZXEVENT5521", "QZXROOM5521", "QZXSIGNUP5521"];
const leaks = (value: unknown) => { const text = JSON.stringify(value) ?? ""; return MARKERS.filter(m => text.includes(m)); };
const now = "2026-11-20T15:05:00.000Z";
const zone = "America/Chicago";
const WINDOW = { starts_at: "2026-11-12T14:59:50Z", ends_at: "2026-11-20T14:59:50Z" };
const rel = (type: string, id: string) => ({ data: { type, id } });
const page = (data: unknown[], included?: unknown[]) => ({ data, ...(included ? { included } : {}), meta: { count: data.length, total_count: data.length } });
const read = (collection: string, body: NonNullable<SundayRead["body"]>, extra: Partial<SundayRead> = {}): SundayRead => ({ collection, offset: 0, checked_at: CHECKED, outcome: "ok", body, ...extra });

/** The fictional Sunday as a live check, with every church read holding a marker. */
function withChurch(capture: SundayCapture): SundayCapture {
  const reads: SundayRead[] = [
    read("people_forms", page([{ type: "Form", id: "610", attributes: { archived: false } }])),
    read("people_form_submissions", page([{ type: "FormSubmission", id: "700", attributes: { created_at: "2026-11-15T15:00:00Z" },
      relationships: { form: rel("Form", "610"), person: rel("Person", "190") } }]), { form_id: "610", window: WINDOW }),
    read("checkins_events", page([{ type: "Event", id: "620", attributes: { archived_at: null } }])),
    read("checkins_locations", page([{ type: "Location", id: "650", attributes: { kind: "Location" }, relationships: { parent: { data: null } } }]), { checkins_event_id: "620" }),
    read("checkins_event_periods", page([{ type: "EventPeriod", id: "660", attributes: { starts_at: "2026-11-15T06:00:00Z", ends_at: "2026-11-16T06:00:00Z" },
      relationships: { event: rel("Event", "620") } }],
    [{ type: "EventTime", id: "630", attributes: { starts_at: "2026-11-15T14:00:00Z" }, relationships: { event: rel("Event", "620"), event_period: rel("EventPeriod", "660") } }]),
    { checkins_event_id: "620", window: WINDOW }),
    read("checkins_location_counts", page([{ type: "LocationEventTime", id: "670", attributes: { regular_count: 8, guest_count: 1, volunteer_count: 1 },
      relationships: { location: rel("Location", "650") } }]), { checkins_event_time_id: "630" }),
    read("registrations_signups", page([{ type: "Signup", id: "640", attributes: { archived: false, closed: false, close_at: "2026-11-27T00:00:00Z", maximum_capacity: 40 } }])),
  ];
  return {
    ...capture, reads: [...capture.reads, ...reads], forms: ["610"],
    names: { ...capture.names, "190": SUBMITTER },
    labels: { ...capture.labels, "form:610": FORM, "checkins_event:620": EVENT, "checkins_location:650": ROOM, "signup:640": SIGNUP },
  };
}
const BASE_RULES: SundayRules = {
  ...RULES, forms: { on: true, watched: ["610"] }, checkIns: { rooms: [{ location_id: "650", team_id: TEAMS.nursery }] },
  kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2, name: "Nursery" }],
};
const status: ConnectionStatus = { state: "connected", organization: "1001", checked_at_ms: 1, source: "test", problem: null, scopes: "services-and-operations" };
const SENDING = new Set(["ask_ozzie", "reword_draft", "agent_step", "responsibility_agent_step", "share_last_check", "save_shortcuts_check", "notify_sunday_attention", "notify_ozzie", "managed_connect", "ledger_admit", "ledger_event", "ledger_transition"]);

describe("church reads at run time", async () => {
  const capture = withChurch(nov22Capture());
  // Church rules hold what the leader said on the room's card, whose labels name the room.
  const room = checkInsFacts(capture, BASE_RULES, { now })!.below[0]!;
  const target = checkInsTarget(room);
  const rules: SundayRules = { ...BASE_RULES, feedback: [correctionEntry(target, "Counted by hand", now), stopEntry(target, stopScopes(target)[0]!, now)] };
  const brief = buildSundayBrief(capture, rules, now);
  // HarnessData as App builds it for a live, connected check.
  const data = buildHarnessData({ capture, fictional: false, rules, decisions: [], status, configured: true, now });
  const skills = await bundledSkills();

  it("has every marker in what it read, and in Church rules (so the checks below aren't empty)", () => {
    const facts = JSON.stringify([formsFacts(capture, rules, { zone }), checkInsFacts(capture, BASE_RULES, { now }), registrationsFacts(capture, rules, { now, zone }), capture.names]);
    for (const m of MARKERS) expect(facts, m).toContain(m);
    expect(leaks(rules.feedback)).toContain("QZXROOM5521");
    expect(data.mode).toBe("live");
    expect(data.capture).toBe(capture);
  });

  it("never puts them in a model request from Ask: a Sunday question, a drafted note, a Check-Ins question", async () => {
    const requests: unknown[] = [];
    for (const [turns, question] of [
      [greeterTurns, "Who could cover Greeter?"], [draftTurns, "Draft a note asking someone to cover Greeter."],
      [[() => answer(JSON.stringify({ answer: "facts", facts: [] }))], "How many people checked in to the nursery last Sunday, and who sent in forms?"],
    ] as const) {
      const { model: step, requests: sent } = scripted([...turns]);
      const harness = createAppHarness({ workspace_id: "1001", data, skills, session: new HarnessSession(), loop: "ts", step });
      await askOzzie(harness, question, { skills });
      requests.push(...sent);
    }
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(leaks(requests)).toEqual([]);
  });

  it("never puts them in a reworded note, the copy for other AI apps, the Siri copy or answer, a notice or Today's briefing", async () => {
    native.calls.length = 0;
    const finding = brief.findings.find(f => (f.people?.suggestions.length ?? 0) > 0)!;
    await model.reword(buildRewordRequest(templateDraft({ finding, person_id: finding.people!.suggestions[0]!.person_id }, capture.names), "warmer", capture.names));
    const saved: [string, unknown][] = [];
    const record: Invoke = (async (command: string, args?: unknown) => { saved.push([command, args]); return null; }) as Invoke;
    const context = { organization: "1001", status };
    await syncShared(data, new HarnessSession(), context, record);
    await syncShortcuts(data, new HarnessSession(), context, record);
    await notifySundayAttention();
    await background.notify("briefing-ready");
    const sent = [...native.calls, ...saved].filter(([command]) => SENDING.has(command));
    expect(sent.map(([command]) => command).sort()).toEqual(["notify_ozzie", "notify_sunday_attention", "reword_draft", "save_shortcuts_check", "share_last_check"]);
    expect(leaks(sent)).toEqual([]);
    const copy = saved.find(([command]) => command === "save_shortcuts_check")![1] as { envelopes: string[] };
    const heard = shortcutsAnswer("sunday", { on: true, text: sharedCheckText(copy.envelopes.map(e => JSON.parse(e) as ToolEnvelope), [], now, "B4K7Q2X9M3T8"),
      nowMs: Date.parse(now), timeZone: zone });
    expect(heard).toMatch(/Checked in Planning Center today/u);
    expect(leaks(heard)).toEqual([]);

    const html = renderToStaticMarkup(React.createElement(TodayPage, {
      brief, onSunday: () => undefined, now, zone, example: false, store: { get: () => null, set: () => undefined },
      church: React.createElement(ChurchReadsToday, { capture, rules: BASE_RULES, names: capture.names, now }),
    }));
    const start = html.indexOf("<section class=\"today-group today-church\"");
    const church = start >= 0 ? html.slice(start, html.indexOf("</section>", start) + "</section>".length) : "";
    // Today's church section is where they are shown (the form, its submitter, the room's team and the signup)…
    expect(leaks(church).length).toBeGreaterThanOrEqual(3);
    // …and nowhere else on Today, the briefing script included.
    expect(leaks(html.replace(church, ""))).toEqual([]);
    expect(html).toContain("listen-script");
  });
});
