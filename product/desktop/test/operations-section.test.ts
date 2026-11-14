// Regression tests for the second independent review: what the Sunday page's rooms and follow-ups
// slot may say (ported from the reviewer's page probes, asserting the fixed behaviour). Fictional data only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { hasOperationsSection, OperationsSection, SundayPage } from "../src/sunday-page.js";
import { sundayOperations, type OperationsOptions } from "../../../core/src/operations-capture.js";
import { FICTIONAL_ROOM, withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const none: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const notShared = (setup = 0): SundayRules => ({ ...none, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: setup }] });
const capture = () => withFictionalOperations(nov22Capture());
const reads = (c: SundayCapture, collection: string) => c.reads.filter(r => r.collection === collection);
type Row = { attributes: Record<string, unknown> };
const bookings = (c: SundayCapture) => reads(c, "calendar_resource_bookings")[0]!.body!.data as Row[];
const section = (c: SundayCapture, rules: SundayRules, o: OperationsOptions = {}) => {
  const ops = sundayOperations(c, rules, o)!;
  return hasOperationsSection(ops) ? text(renderToStaticMarkup(React.createElement(OperationsSection, { operations: ops }))) : "";
};
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** Nothing found anywhere: the lunch setup moved off the service, no unowned overdue card. */
const quiet = () => {
  const c = capture();
  bookings(c)[1]!.attributes.starts_at = "2026-11-22T16:30:00Z";
  bookings(c)[1]!.attributes.ends_at = "2026-11-22T17:00:00Z";
  (reads(c, "people_workflow_ready_cards")[0]!.body!.data as unknown[]).splice(0, 1);
  return c;
};

describe("rooms and follow-ups on the Sunday page", () => {
  it("an out-of-date live check shows only that it's out of date: no results, no clear line, no fresh time (P4)", () => {
    const c: SundayCapture = { ...capture(), kind: "live" };
    const now = "2026-11-20T16:30:00Z";
    const t = section(c, notShared(), { now });
    expect(t).toContain("Out of date");
    expect(t).toContain("Rooms, follow-ups and group meetings aren't shown.");
    expect(t).not.toContain("No room overlaps");
    expect(t).not.toContain("has no owner");
    expect(t).not.toContain(time(now));
    expect(t).not.toContain("Checked");
  });
  it("refused bookings and workflows never read as clear, even with every room ruled (P3)", () => {
    const c = capture();
    for (const r of [...reads(c, "calendar_resource_bookings"), ...c.reads.filter(r => r.collection.startsWith("people_"))]) { r.outcome = "denied"; delete r.body; }
    expect(section(c, notShared())).not.toContain("No room overlaps");
    const page = text(renderToStaticMarkup(React.createElement(SundayPage, {
      brief: buildSundayBrief(c, notShared(), c.completed_at, true), names: c.names, busy: false, problem: "", sender: "", connected: false,
      hasRecording: false, configured: false, canReword: false, decisions: [], onDecisions: () => undefined, operations: sundayOperations(c, notShared()),
      onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    })));
    expect(page).not.toContain("No room overlaps");
    expect(page).toContain("Room bookings: Planning Center didn't allow it.");
  });
  it("a fully checked quiet Sunday says so, names what was checked and when Planning Center was read", () => {
    const c = quiet();
    expect(section(c, notShared())).toContain(`No room overlaps or follow-ups without an owner in what was read (checked ${time(reads(c, "calendar_rooms")[0]!.checked_at)}).`);
    for (const r of [...reads(c, "calendar_rooms"), ...reads(c, "calendar_resource_bookings"), ...reads(c, "calendar_conflicts")]) { r.outcome = "not-requested"; delete r.body; }
    const followUps = section(c, notShared());
    expect(followUps).toContain("No follow-ups without an owner in what was read");
    expect(followUps).not.toContain("room overlaps");
  });
  it("a large room list still checks the booked room (P9)", () => {
    const c = capture();
    const list = reads(c, "calendar_rooms")[0]!.body!.data as unknown[];
    for (let i = 0; i < 42; i++) list.push({ type: "Resource", id: String(900000 + i), attributes: { kind: "Room" } });
    const t = section(c, notShared());
    expect(t).toContain("Room use needs review");
    expect(t).not.toContain("No room overlaps");
  });
  it("setup time before both starts still confirms Calendar's unresolved conflict, with no stray line (P1)", () => {
    const c = capture();
    bookings(c)[1]!.attributes.starts_at = "2026-11-22T14:00:00Z";
    const t = section(c, notShared(30));
    expect(t).toContain("Room use needs review");
    expect(t).not.toContain("Planning Center doesn't show clearly whether overlapping bookings");
    expect(t).not.toContain("isn't recorded");
  });
  it("a finding's check time is a Planning Center read time, not the Church rules", () => {
    const c = capture();
    const t = section(c, notShared(30));
    expect(t).toContain(`Checked ${time(reads(c, "calendar_resource_bookings")[0]!.checked_at)}`);
  });
});
