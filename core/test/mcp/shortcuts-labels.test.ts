// What Siri says about who is pending (core/mcp/shortcuts.ts, e0847704: "N people are pending", each person once by
// their label). Anything where a person or role goes that isn't one of the shared copy's labels makes the whole copy
// refused (snapshot.ts parseSharedCheck), so Siri says only the fixed no-check sentence; a label, "not known" or a
// number that is let through is only ever counted (put in a set whose size is said). Checked with look-alike labels,
// names, repeats and values that aren't text, and swept over many mixed copies. Fictional data only.
import { describe, expect, it } from "vitest";
import type { ToolEnvelope } from "../../src/harness/contract.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools } from "../../src/harness/tools.js";
import { sharedCheckText, sharedEnvelopes } from "../../mcp/snapshot.js";
import { NO_CHECK, shortcutsAnswer, shortcutsEnvelopes } from "../../mcp/shortcuts.js";
import { FRESH, harnessData } from "../harness/fixtures.js";

const COPY = "B4K7Q2X9M3T8";
const ZONE = "America/New_York";
const MARK = "QZXPERSON";
const ask = (text: string) => shortcutsAnswer("sunday", { on: true, text, nowMs: Date.parse(FRESH), timeZone: ZONE });
const overview = async () => shortcutsEnvelopes(await sharedEnvelopes(new HarnessTools(harnessData({ mode: "live" }), new HarnessSession(), { now: () => FRESH })))[0]!;
/** The overview with its pending findings replaced by one per `people` value. */
function withPending(base: ToolEnvelope, people: readonly unknown[], roles: readonly unknown[] = ["[Role 3]"]): string {
  const copy = structuredClone(base) as ToolEnvelope & { payload: Record<string, unknown> };
  const kept = (copy.payload["findings"] as Record<string, unknown>[]).filter(f => f["kind"] !== "pending");
  copy.payload["findings"] = [...kept, ...people.map((person, i) => ({
    fact: `f${60 + i}`, kind: "pending", tone: "worth a look", role: roles[i % roles.length],
    time: { starts_at: "2026-11-22T09:30-05:00", ends_at: "2026-11-22T10:30-05:00" }, person,
    request: i % 3 === 0 ? "request sent, no answer yet" : i % 3 === 1 ? "request not sent yet" : "pending",
  }))];
  return sharedCheckText([copy], [], FRESH, COPY);
}

describe("who is pending, in what Siri says", () => {
  it("says nothing but the fixed no-check sentence when a person or role isn't a label: the copy is refused whole", async () => {
    const base = await overview();
    for (const [person, role] of [[`[${MARK} One]`, "[Role 3]"], ["[Riley Thornbury]", "[Role 3]"], [`${MARK} Plain`, "[Role 3]"], ["Riley Thornbury", "[Role 3]"],
      ["", "[Role 3]"], [null, "[Role 3]"], [{ name: MARK }, "[Role 3]"], ["[Person 1]", `[${MARK} Role]`], ["[Person 1]", "Greeter"], ["[Person 1]", null]] as const) {
      expect(ask(withPending(base, ["[Person 2]", person], [role])), JSON.stringify([person, role])).toBe(NO_CHECK);
    }
  });

  it("counts each label once and each row without one on its own, and says none of them", async () => {
    const base = await overview();
    // Labels [Person 1] (three times, once) and [Person 7]; "not known" twice and a number each count on their own.
    const said = ask(withPending(base, ["[Person 1]", "[Person 1]", "[Person 7]", "[Person 1]", "not known", "not known", 42], ["[Role 3]", "[Role 1]"]));
    expect(said).toContain("5 people are pending");
    for (const kept of ["Person", "Role", "not known", "42", "["]) expect(said, kept).not.toContain(kept);
    expect(ask(withPending(base, ["[Person 4]", "[Person 4]"]))).toContain("1 person is pending");
  });

  it("never says anything from a person or role field, over many mixed copies", async () => {
    const base = await overview();
    const pool: unknown[] = ["[Person 1]", "[Person 2]", "[Person 31]", "not known", 7, `[${MARK} A]`, `${MARK} B`, "Riley Thornbury", "", null];
    const roles = ["[Role 1]", "[Role 3]", `[${MARK} Role]`, "Greeter"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let answered = 0;
    for (let round = 0; round < 300; round++) {
      const people = Array.from({ length: 1 + Math.floor(next() * 8) }, () => pool[Math.floor(next() * pool.length)]);
      const said = ask(withPending(base, people, [roles[Math.floor(next() * roles.length)]]));
      expect(said, JSON.stringify(people)).not.toMatch(/QZXPERSON|Riley|Thornbury|Greeter|Person|Role \d|not known|[[\]{}]/u);
      if (said === NO_CHECK) continue;
      answered++;
      // Otherwise a count of people, in digits and fixed words.
      expect(said, JSON.stringify(people)).toMatch(/\b\d+ (?:person is|people are) pending\b/u);
    }
    expect(answered).toBeGreaterThan(20);
  });
});
