// Round 3 polish seen live on B1 Church: what needs a decision is listed before what is worth a look, and a plan title
// that only says its date again isn't shown beside the date (the same rule for Planning Center). Fictional data.
import { describe, expect, it } from "vitest";
import { buildSystemBrief } from "../../src/church-systems/brief.js";
import { suggestedQuestions } from "../../src/ask.js";
import { titleOnlyDate } from "../../src/service-day.js";
import { b1Capture, NOW } from "./fixtures.js";

describe("a B1 Church check's findings", () => {
  it("list what needs a decision first, then what is worth a look, each in the system's order", () => {
    // Guitar first in B1's order, with only someone waiting to answer (worth a look); Vocals after it, still needing people.
    const c = b1Capture({
      positions: [{ id: "POS-guitar", team_id: "GRP-worship", needed: 1 }, { id: "POS-vocals", team_id: "GRP-worship", needed: 2 }, { id: "POS-greeter", team_id: "GRP-hosp", needed: 2 }],
      assignments: [{ id: "ASN-g", position_id: "POS-guitar", person_id: "PER-bram", status: "unconfirmed", asked: true },
        { id: "ASN-rowan", position_id: "POS-vocals", person_id: "PER-rowan", status: "accepted", asked: true }],
    });
    const built = buildSystemBrief(c, { confirmedZone: "America/Chicago" }, NOW);
    if (!built.ok) throw new Error(built.reason);
    const tones = built.brief.findings.map(f => f.tone);
    expect(tones.indexOf("look")).toBeGreaterThan(tones.lastIndexOf("decision"));
    expect(built.brief.findings[0]).toMatchObject({ kind: "needs-people", position: { name: "Vocals" } });
    // Ask's suggestions follow the same order: "Why is … flagged?" names a role that needs a decision.
    expect(suggestedQuestions(built.brief)).toContain("Why is Vocals flagged?");
  });
});

describe("a plan title that only says its date again", () => {
  it("is recognized in the forms churches write dates in", () => {
    for (const title of ["Sunday Nov 22", "Nov 22", "November 22, 2026", "Sunday, November 22nd", "11/22", "11/22/2026", "Sun 22 Nov", "Sunday", "2026-11-22"]) {
      expect(titleOnlyDate(title, "2026-11-22"), title).toBe(true);
    }
  });
  it("isn't when it adds anything, or names another date", () => {
    for (const title of ["Youth Night", "Sunday Gathering", "Sunday Nov 22 Communion", "Christmas Eve", "Nov 29", "Saturday Nov 22", "Sunday Service", ""]) {
      expect(titleOnlyDate(title, "2026-11-22"), title).toBe(false);
    }
    // Review of round 3, L4: a number that isn't the day ("Sunday 11" may be the 11 o'clock service), or a part said twice.
    for (const title of ["Sunday 11", "Sunday 11 2026", "Sunday 22 22", "11/11", "Sunday Sunday", "Nov Nov 22", "Nov 22 11", "Sunday 26"]) {
      expect(titleOnlyDate(title, "2026-11-22"), title).toBe(false);
    }
    // A day equal to the month, or to the year's last two digits, is still the day.
    expect(titleOnlyDate("11/11", "2026-11-11")).toBe(true);
    expect(titleOnlyDate("Thursday 11/26/26", "2026-11-26")).toBe(true);
    expect(titleOnlyDate("Thurs Nov 26", "2026-11-26")).toBe(true);
    expect(titleOnlyDate("Sunday Nov 22", "not a date")).toBe(false);
  });
});
