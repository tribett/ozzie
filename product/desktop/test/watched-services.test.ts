// The services Ozzie watches besides the one Settings names (owner decision 2026-11-19), kept per church. Fixed data.
import { describe, expect, it } from "vitest";
import { addService, alsoWatched, MAX_WATCHED, movedOn, readDay, removeService, type AlsoWatched } from "../src/watched-services.js";
import type { KeyValueStore } from "../src/proactive.js";

const memory = (): KeyValueStore & { raw: Map<string, string> } => { const raw = new Map<string, string>(); return { raw, get: k => raw.get(k) ?? null, set: (k, v) => { raw.set(k, v); } }; };
const youth = { serviceTypeId: "2200", name: "Youth Night", plan: { id: "93000001", sort_date: "2026-11-25T19:00:00Z", times: ["2026-11-26T00:00:00Z"] } };
const choir = { serviceTypeId: "2300", name: "Choir", plan: { id: "93000002", sort_date: "2026-11-24T19:00:00Z", times: [] } };
const prayer = { serviceTypeId: "2400", name: "Prayer", plan: { id: "93000003", sort_date: "2026-11-23T19:00:00Z", times: [] } };
const fifth = { serviceTypeId: "2500", name: "Fifth", plan: { id: "93000004", sort_date: "2026-11-23T19:00:00Z", times: [] } };
const ZONE = "America/New_York";

describe("the services Ozzie watches besides Settings' own", () => {
  it("adds one with its next plan, never the one Settings names, never twice, and never more than four in all", () => {
    let list: AlsoWatched[] = [];
    list = addService(list, youth, "1500", ZONE)!;
    expect(list).toEqual([{ serviceTypeId: "2200", planId: "93000001", name: "Youth Night", sort_date: "2026-11-25T19:00:00Z", times: ["2026-11-26T00:00:00Z"], zone: ZONE, past: [] }]);
    expect(addService(list, youth, "1500", ZONE)).toBeNull();
    expect(addService(list, { ...choir, serviceTypeId: "1500" }, "1500", ZONE)).toBeNull();
    expect(addService(list, { ...choir, plan: null }, "1500", ZONE)).toBeNull();
    list = addService(addService(list, choir, "1500", ZONE)!, prayer, "1500", ZONE)!;
    expect(list).toHaveLength(MAX_WATCHED - 1);
    expect(addService(list, fifth, "1500", ZONE)).toBeNull();
  });

  it("moves one on to its next plan, remembering the passed plan so its saved checks can be forgotten with it", () => {
    const list = addService([], youth, "1500", ZONE)!;
    const next = { id: "93000010", sort_date: "2026-12-02T19:00:00Z", times: ["2026-12-03T00:00:00Z"] };
    const moved = movedOn(list, "2200", "93000001", next, ZONE);
    expect(moved[0]).toMatchObject({ planId: "93000010", sort_date: next.sort_date, times: next.times, past: ["93000001"] });
    // Only from the plan it watched: a move decided on an older plan changes nothing.
    expect(movedOn(moved, "2200", "93000001", { ...next, id: "93000011" }, ZONE)[0]!.planId).toBe("93000010");
    expect(removeService(moved, "2200")).toEqual({ list: [], plans: ["93000010", "93000001"] });
    expect(removeService(moved, "9999")).toEqual({ list: moved, plans: [] });
  });

  it("keeps what a check read of a plan's day, and hands back the same list when nothing changed", () => {
    const list = addService([], youth, "1500", ZONE)!;
    expect(readDay(list, "93000001", youth.plan.sort_date, youth.plan.times, ZONE)).toBe(list);
    const read = readDay(list, "93000001", youth.plan.sort_date, ["2026-11-26T00:00:00Z", "2026-11-26T02:00:00Z"], ZONE);
    expect(read).not.toBe(list);
    expect(read[0]!.times).toHaveLength(2);
    // A read that couldn't place the plan never forgets its day (review L5).
    expect(readDay(read, "93000001", null, [], null)).toBe(read);
    expect(readDay(read, "93000001", null, [], "America/Chicago")[0]).toMatchObject({ sort_date: youth.plan.sort_date, times: read[0]!.times, zone: "America/Chicago" });
  });

  it("is kept per church: another church's list is never read, and anything malformed is left out", () => {
    const store = memory(), kept = alsoWatched(store);
    kept.set("1001", addService([], youth, "1500", ZONE)!);
    expect(kept.get("1001").map(s => s.name)).toEqual(["Youth Night"]);
    expect(kept.get("1002")).toEqual([]);
    expect(kept.get("not an id")).toEqual([]);
    store.raw.set("ozzie.also-watched.v1", JSON.stringify({ organization: "1001", services: [{ serviceTypeId: "x", planId: "1" }, { ...youth, planId: "93000001", times: ["nope"], past: ["93000001", "bad"] }, 7] }));
    expect(kept.get("1001")).toEqual([{ serviceTypeId: "2200", planId: "93000001", name: "Youth Night", sort_date: null, times: [], zone: null, past: [] }]);
    store.raw.set("ozzie.also-watched.v1", "not json");
    expect(kept.get("1001")).toEqual([]);
  });
});
