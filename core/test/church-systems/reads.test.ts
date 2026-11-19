// Round 3, live finding B: every B1 Church check read as "part of it couldn't be read" because B1 always cuts its forms
// list short (it lists only the forms the key's maker may manage). A read the system cuts short by design isn't a
// failure; anything that truly didn't read in full still is, and is named by its part. Fictional captures only.
import { describe, expect, it } from "vitest";
import { PART_NAMES, unreadParts } from "../../src/church-systems/reads.js";
import { b1Capture, breezeCapture, B1_READS, readsOf } from "./fixtures.js";

describe("which parts of a check didn't read in full", () => {
  it("leaves out B1 Church's forms list, always cut short by design, and Breeze's entries for its newest forms only", () => {
    expect(unreadParts(b1Capture({ reads: readsOf(B1_READS, { "b1.forms": "truncated" }) }))).toEqual([]);
    const breezeWords = ["breeze.account", "breeze.events", "breeze.roles", "breeze.volunteers", "breeze.tags", "breeze.forms", "breeze.form_entries", "breeze.people"];
    expect(unreadParts(breezeCapture({ reads: readsOf(breezeWords, { "breeze.form_entries": "truncated" }) }))).toEqual([]);
  });

  it("names every part that truly didn't read in full, the forms included when their read failed", () => {
    expect(unreadParts(b1Capture({ reads: readsOf(B1_READS, { "b1.forms": "refused" }) }))).toEqual(["forms"]);
    expect(unreadParts(b1Capture({ reads: readsOf(B1_READS, { "b1.forms": "truncated", "b1.events": "timeout", "b1.blockouts": "truncated" }) })))
      .toEqual(["blockouts", "events"]);
    expect(unreadParts(b1Capture({ reads: readsOf(B1_READS, { "b1.plans": "unreachable" }) }))).toEqual(["service"]);
    // A read not asked for this time is no failure.
    expect(unreadParts(b1Capture({ reads: readsOf(B1_READS, { "b1.groups": "not-requested" }) }))).toEqual([]);
    expect(PART_NAMES.forms).toBe("forms");
    expect(PART_NAMES.service).toBe("the service's times");
  });
});
