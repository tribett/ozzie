// Planning Center's copies for other AI apps and for Siri and Shortcuts, byte for byte as before a church on B1 Church
// or Breeze was shared too (recorded from 0.9.1's code, c1e12bb6, before that change): the shared copy's text over every
// harness fixture, every tool's words over it (and over no copy), the handshake and the tool list, and every Siri and
// Shortcuts answer at the times and zones a leader might ask. Hashed; fixed fictional data and a pinned clock, so the
// same in every zone a test runs in (checked with TZ=UTC, Asia/Tokyo and Pacific/Kiritimati).
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import type { Skill } from "../../src/harness/contract.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools } from "../../src/harness/tools.js";
import { McpServer, TOOLS, type Response } from "../../mcp/server.js";
import { sharedCheckText, sharedEnvelopes, type SharedTask } from "../../mcp/snapshot.js";
import { shortcutsAnswer, shortcutsEnvelopes } from "../../mcp/shortcuts.js";
import { FIXTURES, FRESH } from "../harness/fixtures.js";

const skills: ReadonlyMap<string, Skill> = await bundledSkills();
const SHARED_AT = "2026-11-20T15:06:00Z";
const COPY = "B4K7Q2X9M3T8";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(SHARED_AT)); });
afterEach(() => { vi.useRealTimers(); });
/** Every kind of task row a Planning Center church's record holds: a check that read it, one that failed, a question and a procedure. */
const TASKS: SharedTask[] = [
  { kind: "check", skill_id: "sunday-ready", state: "verified", created_at: "2026-11-20T15:00:00Z", updated_at: "2026-11-20T15:00:04Z", failure: null,
    events: [{ type: "admitted", detail: "", at: "2026-11-20T15:00:00Z" }, { type: "running", detail: "", at: "2026-11-20T15:00:00Z" },
      { type: "tool", detail: "planning_center.refresh complete", at: "2026-11-20T15:00:02Z" }, { type: "verified", detail: "", at: "2026-11-20T15:00:04Z" }] },
  { kind: "check", skill_id: "sunday-ready", state: "failed", created_at: "2026-11-20T14:00:00Z", updated_at: "2026-11-20T14:00:09Z", failure: "provider-failure",
    events: [{ type: "admitted", detail: "", at: "2026-11-20T14:00:00Z" }, { type: "failed", detail: "provider-failure", at: "2026-11-20T14:00:09Z" }] },
  { kind: "ask", skill_id: "answer-from-what-was-read", state: "failed", created_at: "2026-11-20T13:50:00Z", updated_at: "2026-11-20T13:50:09Z", failure: "egress",
    events: [{ type: "model", detail: "1", at: "2026-11-20T13:50:01Z" }, { type: "model", detail: "1 egress", at: "2026-11-20T13:50:02Z" },
      { type: "failed", detail: "egress", at: "2026-11-20T13:50:09Z" }] },
  { kind: "skill", skill_id: "room-check", state: "cancelled", created_at: "2026-11-20T13:40:00Z", updated_at: "2026-11-20T13:40:03Z", failure: null, events: [] },
];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const textOf = (r: Response | null): string => r && "result" in r ? JSON.stringify(r.result) : JSON.stringify(r);
/** Everything a client sees from the server over `text`: the handshake, the tool list and every tool's words. */
function served(text: string | null): string {
  const server = new McpServer({ read: () => text, skills });
  const out = [
    textOf(server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })),
    textOf(server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })),
    ...TOOLS.map(t => textOf(server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: t.name, arguments: {} } }))),
  ];
  return out.join("\n");
}
/** When a leader might ask Siri: just after the check, past Ozzie's limit for a live check, after the service, and with this Mac's clock behind. */
const ASKED = ["2026-11-20T15:10:00Z", "2026-11-20T18:00:00Z", "2026-11-24T12:00:00Z", "2026-11-20T14:00:00Z"].map(t => Date.parse(t));
const ZONES = ["America/Chicago", "Asia/Tokyo", "Pacific/Kiritimati", "Nowhere/Unknown"];
const asked = (text: string): string => ASKED.flatMap(nowMs => ZONES.map(timeZone => shortcutsAnswer("sunday", { on: true, text, nowMs, timeZone }))).join("\n");

/** sha256 of each fixture's copy, its server words and its Siri answers, as recorded from c1e12bb6. */
const PINNED: Readonly<Record<string, { copy: string; served: string; siri: string }>> = {
  "fictional": { copy: "e8202d41b1ff398ce2c792a7440ae4e4192e8929f0f9870797d32b072cb734a1", served: "a2f084f175435cdb16b909bb4f5fccbf5be93b70dbe1f221f2845b82ff17b91a", siri: "522d1a2dbff49cdfdeb25a0b1f072e3c9d3d2d5e6d5650b6e7746ee8bec56195" },
  "lead rule and a decision": { copy: "ce38f7c026b65b6fe21211693a030e7f7565b1bfea56d19ff513e03a09fd13f7", served: "55cb5a7ff284efb0378ecbbe7d287b3b99bd2bc8eaa5a4668f26b71c3aaaa213", siri: "e26fd9f85c1f2a1030d3ce86a68542e1d9a7bef9c6b933a97c98c194576c645d" },
  "live and connected": { copy: "c47d644a565a9bfebd3c77f5b2326157990ad23180f39931039e412c847b171c", served: "7d1444d0998db5182a7409190618b3a530563ecb8a37cbb7e1721f0e40d74423", siri: "ab7623a170197af282813cfb2e5605efcda5602da4d9a6fba8457aedddbf6797" },
  "live, out of date": { copy: "d899cd5ba6a98ff4cdd72bd70b73162a70eb6a3750596b3a96d6b1eddd81c75a", served: "88b8801dc8de4715651509f77b8ec623cd839eded459f7ca22472cf7450ef0ae", siri: "c948dbda6e819423f16350281d7899d7389c335963bc0287f7d30af8b8d2ed59" },
  "saved recording": { copy: "2c32ac260e1c2b91b131c15234842d31fd49c09dd36ce9871263a46b18c0cc10", served: "b0879327dd6c21f64d4c3c1109e83b71e6d87a21ddf835752cf12a753bee7c2e", siri: "7490929d778a8a1cbd73ce2a05c42c8b7ffc5348565afef02b71ff47b655542e" },
  "Services only": { copy: "e8202d41b1ff398ce2c792a7440ae4e4192e8929f0f9870797d32b072cb734a1", served: "a2f084f175435cdb16b909bb4f5fccbf5be93b70dbe1f221f2845b82ff17b91a", siri: "522d1a2dbff49cdfdeb25a0b1f072e3c9d3d2d5e6d5650b6e7746ee8bec56195" },
  "operations turned off": { copy: "9e519bd8199244ee584c89ef79c8c6f7b3fb973edab8332dcd8b81fe686f6173", served: "e6d144187f6e8c4b9cc518ffffb5dacd0329c415a19a996294392b3274429bfe", siri: "8fb4a1c4bbc0fce70beebcb4d45e15b41ef560225ac914511b6b65bffe6d3bd6" },
  "a read that didn't complete": { copy: "69d965a0cc5cf26ea220497a514b6c3c1ac8417f75f51fe39b1af5cd072566f3", served: "532b2036c7316be6c24ed38a2131453a44090f5f2fb03b82a9f2a321f3f0e536", siri: "9eea39f88905bb6eb2a2ead4f2e3c6d82638f8affda9bd2a85f86dd231b90e3a" },
  "canary names and positions": { copy: "e8202d41b1ff398ce2c792a7440ae4e4192e8929f0f9870797d32b072cb734a1", served: "a2f084f175435cdb16b909bb4f5fccbf5be93b70dbe1f221f2845b82ff17b91a", siri: "522d1a2dbff49cdfdeb25a0b1f072e3c9d3d2d5e6d5650b6e7746ee8bec56195" },
  "team reads denied and schedules truncated": { copy: "3221658d25132d9f41d0c6a11209eac307aa5551be9f6cf6bd045a9b21534c2e", served: "d198d44347c4c57ee6fd9d29ffd6df58166131086855e079f16750c253521ba0", siri: "9eea39f88905bb6eb2a2ead4f2e3c6d82638f8affda9bd2a85f86dd231b90e3a" },
  "room bookings timed out": { copy: "0a9c1b131a5db9e53b53e57c41930611cf24529a9a7b08fd93ecde6eeaf34a5b", served: "f9b4f0d7d7592779965fe4032669e0794d32ee528e241c73f22ae49b0ed868a8", siri: "29b539e6140e20da5b3620ec2783c6efdd30d9974675d34fda7315a2caab2167" },
  "room list and workflows failed": { copy: "b4b348c3847fa388fb0adeac40f0a43719675c977db59251b1cd547d9b3ab32c", served: "34491fe7b63b1e98a7761ea69175bccc6ac008d5a94b8298075fecfbc6918c4a", siri: "29b539e6140e20da5b3620ec2783c6efdd30d9974675d34fda7315a2caab2167" },
  "group reads denied": { copy: "c56d8b24848fb3c5cb22dc701391b00b747b6558e9421c35b97af6f76aac165b", served: "f6313401c8bc8526a95446db32a4daf487e6e630cc49a12387170a98ba87914b", siri: "ab7623a170197af282813cfb2e5605efcda5602da4d9a6fba8457aedddbf6797" },
  "someone scheduled with a blockout": { copy: "3c99c62bf382e274a31aafbea0814b656e56081f71084fecbe2ac16f17ab462e", served: "f94ecaf46fba0f3cee0f233dbb2275a065353f95f3dda2543b58a34de9df30df", siri: "2ab312b4a645f6fd1fcbee468934b2ba32ba7bec578d0244adec7162b29be62b" },
  "kids teams and background checks": { copy: "e60692ab2659cdb48197b9badc2a4b0fd271f1f65c6550f27180c4f0fe61c0cd", served: "13e7d75da949f616522bbc6280b43d1b1243f5bcdb5842b936b63dc52adeb3aa", siri: "8f817e03342443944ad0afbe97a88ee43f75546744519cec65e6a7c1974a8027" },
  "kids teams, People not granted": { copy: "e60692ab2659cdb48197b9badc2a4b0fd271f1f65c6550f27180c4f0fe61c0cd", served: "13e7d75da949f616522bbc6280b43d1b1243f5bcdb5842b936b63dc52adeb3aa", siri: "8f817e03342443944ad0afbe97a88ee43f75546744519cec65e6a7c1974a8027" },
  "two services watched": { copy: "c47d644a565a9bfebd3c77f5b2326157990ad23180f39931039e412c847b171c", served: "7d1444d0998db5182a7409190618b3a530563ecb8a37cbb7e1721f0e40d74423", siri: "ab7623a170197af282813cfb2e5605efcda5602da4d9a6fba8457aedddbf6797" },
};

describe("Planning Center's copies, byte for byte as before", () => {
  it("pins every fixture the harness has", () => {
    expect(FIXTURES.map(([name]) => name).sort()).toEqual(Object.keys(PINNED).sort());
  });

  it("serves nothing shared, and answers Siri with the switch off, no copy and an unknown question, as before", () => {
    expect(sha(served(null))).toBe("95a38cec29f5e75006b8625dc7bfd17f77ea6ce91e90fdb352f67a19fe6d7297");
    const at = { nowMs: ASKED[0]!, timeZone: ZONES[0]! };
    expect(sha([shortcutsAnswer("sunday", { on: false, text: null, ...at }), shortcutsAnswer("sunday", { on: true, text: null, ...at }),
      shortcutsAnswer("weather", { on: true, text: null, ...at })].join("\n"))).toBe("1aac767fad05c2f305484db56bc98ddb56d29608f356581dda5be3f83d0f6a2b");
  });

  it.each(FIXTURES)("%s: the copy, every tool's words and every Siri answer", async (name, data) => {
    const envelopes = await sharedEnvelopes(new HarnessTools(data(), new HarnessSession(), { now: () => FRESH }));
    const copy = sharedCheckText(envelopes, TASKS, SHARED_AT, COPY);
    const forSiri = sharedCheckText(shortcutsEnvelopes(envelopes), [], SHARED_AT, COPY);
    expect({ copy: sha(copy), served: sha(served(copy)), siri: sha(asked(forSiri)) }, name).toEqual(PINNED[name]);
  });
});
