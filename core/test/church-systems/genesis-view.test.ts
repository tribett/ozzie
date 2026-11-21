// Round 5: a church that uses only Genesis. Genesis shares no volunteer schedules, so the view says what it does share,
// plainly, and "worth a look" only for a form filled in more times than at the last check.
import { describe, expect, it } from "vitest";
import { fictionalGenesis } from "../../src/church-systems/fictional.js";
import { GENESIS_NO_SCHEDULES, genesisSummary, genesisView, newSubmissionLine } from "../../src/church-systems/genesis-view.js";
import { labelsOf } from "../../src/church-systems/placeholders.js";
import { parseSystemCapture } from "../../src/church-systems/types.js";

const capture = fictionalGenesis();
const NOW = capture.completed_at;

describe("a Genesis church's view", () => {
  it("the fictional church is a valid capture with no service, role or name", () => {
    const parsed = parseSystemCapture(JSON.parse(JSON.stringify(capture)));
    expect(parsed.ok).toBe(true);
    expect(capture.service).toBeNull();
    expect(capture.names).toEqual({});
  });

  it("splits events into coming and just past, and says what it holds in counts", () => {
    const v = genesisView(capture, capture.church.time_zone, NOW, null);
    expect(v.upcoming.map(e => e.event_id)).toEqual(["GE-nov22", "GE-nov26", "GE-nov29"]);
    expect(v.recent.map(e => [e.event_id, e.attendance])).toEqual([["GE-nov19", 34]]);
    expect(genesisSummary(v)).toBe("3 events in the next four weeks, 2 forms, 3 groups");
    expect(GENESIS_NO_SCHEDULES).toBe("Genesis doesn't share volunteer schedules, so Ozzie can't check whether a service is covered.");
  });

  it("is worth a look only for a form filled in more times than at the last check, said as numbers", () => {
    expect(genesisView(capture, capture.church.time_zone, NOW, null).newSubmissions).toEqual([]);
    const v = genesisView(capture, capture.church.time_zone, NOW, { "GF-prayer": 5, "GF-serve": 3 });
    expect(v.newSubmissions).toEqual([{ form_id: "GF-prayer", before: 5, now: 7 }]);
    expect(newSubmissionLine(v.newSubmissions[0]!, labelsOf(capture))).toBe("Prayer Card was filled in 2 more times since the last check (7 in all).");
    expect(v.counts).toEqual({ "GF-prayer": 7, "GF-serve": 3 });
    // Fewer than before (a form's entries deleted) or a count Ozzie couldn't read: never worth a look.
    expect(genesisView(capture, capture.church.time_zone, NOW, { "GF-prayer": 9 }).newSubmissions).toEqual([]);
    const uncounted = { ...capture, forms: capture.forms.map(f => ({ ...f, submissions: null })) };
    expect(genesisView(uncounted, capture.church.time_zone, NOW, { "GF-prayer": 5 }).newSubmissions).toEqual([]);
  });

  it("holds every event back until the church's zone is the one confirmed (Genesis gives none)", () => {
    const v = genesisView(capture, "America/New_York", NOW, null);
    expect(v.upcoming).toEqual([]);
    expect(v.facts.reads.events.outcome).toBe("held-for-zone");
  });
});
