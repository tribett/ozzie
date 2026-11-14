// A fact sheet that uses every line kind buildAskContext emits, from fixed fictional data. Pinned in
// ask.test.ts and parsed by core/native-auth/src/model_tests.rs, which checks each line against the
// native fact-line grammar, so the two sides cannot drift apart.
import { AskSession, buildAskContext } from "../src/ask.js";
import { buildSundayBrief } from "../src/sunday-brief.js";
import { nov22Capture, PEOPLE, TEAMS } from "../src/fictional-sunday.js";
import { decide } from "../src/sunday-decisions.js";

export function richContext() {
  const capture = nov22Capture();
  // Greeter's team-leader read timed out, so its leaders are unknown ("?").
  capture.reads.find(r => r.collection === "team_leaders" && r.team_id === TEAMS.greeter)!.outcome = "timeout";
  const rules = { sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }], checkInAfterSundaysInARow: 3 };
  const brief = buildSundayBrief(capture, rules, "2026-11-20T15:05:00Z");
  for (const f of brief.findings) {
    if (f.position?.name === "Greeter") f.position = { ...f.position, name: "Greeters (9:30) & Hosts" };
    if (f.position?.name === "Lyrics") f.position = { ...f.position, name: "Prayer Team" };
    if (f.kind === "lead-missing") f.pending_leads = [PEOPLE.riley];
  }
  const nursery = brief.findings.find(f => f.kind === "lead-missing")!;
  brief.findings.push({ ...nursery, id: "lead-unverified:x", key: "lead-unverified:x", kind: "lead-unverified", why: [] });
  const greeter = brief.findings.find(f => f.kind === "needs-people")!;
  const decisions = [decide(greeter, "covered-outside", "Tom Example (Riley's husband) will cover; 555-0100", "2026-11-20T15:10:00Z")];
  return buildAskContext(new AskSession(), { brief, names: capture.names, organization: capture.organization, decisions }, { timeZone: "America/New_York" })!;
}
