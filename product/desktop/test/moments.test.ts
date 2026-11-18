// The questions asked at the moment they matter (onboarding spec §4.2): the kids-team name list and its word-edge rules,
// and that each question fires once and is remembered on this Mac with nothing but the answer. Fictional teams only.
import { describe, expect, it } from "vitest";
import {
  FINISH_KEY, finishStore, kidsFacts, kidsTeamToAsk, KIDS_WORDS, looksLikeKids, MOMENTS_KEY, momentsStore, nameMomentDue, NO_MOMENTS, parseFinish, parseMoments,
  peopleQuestionDue, phoneMomentDue, type KeyValue,
} from "../src/moments.js";

/** A Map-backed stand-in for this Mac's storage. */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const storage: KeyValue = { getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
  return { map, storage: () => storage };
}

describe("which team names look like a team that serves with kids", () => {
  it("matches every word on the spec's fixed list, in any case", () => {
    expect([...KIDS_WORDS]).toEqual(["kids", "kid's", "children", "nursery", "preschool", "pre-k", "toddler", "infant", "elementary", "kindergarten", "VBS", "check-in"]);
    for (const name of ["Kids", "KIDS CHURCH", "Kid's Church", "Kid’s Corner", "Children's Ministry", "Childrens Ministry", "Nursery", "nursery (9:00)",
      "Preschool", "Pre-K", "Pre K", "PreK Room", "Toddlers", "Infant Room", "Infants", "Elementary", "Kindergarten", "VBS Crew", "vbs", "Check-In",
      "Kids Check In", "Checkin Desk", "Check-ins", "Nurseries", "Early Childhood / Nursery", "2nd Service – Kids"]) {
      expect(looksLikeKids(name), name).toBe(true);
    }
  });

  it("needs a whole word: a list word inside another word doesn't count", () => {
    for (const name of ["Kidney Fund Drive", "Skids and Ramps", "Checking Accounts", "Prekindle", "Nurseryman", "Infantry Veterans", "Toddlerific",
      "Elementals", "Greeters", "Worship Band", "Parking", "Child", "Kid Zone", "Childcare", "Check", "Pre", "", "   "]) {
      expect(looksLikeKids(name), name).toBe(false);
    }
  });

  it("treats a small letter followed by a capital as a word's edge, so names written together still count", () => {
    expect(looksLikeKids("KidsZone")).toBe(true);
    expect(looksLikeKids("SuperKids")).toBe(true);
    expect(looksLikeKids("TinyToddlers")).toBe(true);
    expect(looksLikeKids("Kidney")).toBe(false);
    expect(looksLikeKids("KIDNEY")).toBe(false);
  });

  it("reads only text", () => {
    for (const odd of [null, undefined, 7, ["Kids"], { name: "Kids" }]) expect(looksLikeKids(odd)).toBe(false);
  });
});

describe("the one kids team to ask about", () => {
  const TEAMS = [{ id: "201", name: "Greeters" }, { id: "202", name: "Nursery" }, { id: "203", name: "Preschool" }, { id: "204", name: "Kidney Fund Drive" }];

  it("is the first that looks like one, in the check's order, until it's answered", () => {
    const { storage } = memoryStorage();
    const store = momentsStore(storage);
    expect(kidsTeamToAsk(TEAMS, [], store.get())).toEqual({ id: "202", name: "Nursery" });
    store.answerKids("202");
    expect(kidsTeamToAsk(TEAMS, [], store.get())).toEqual({ id: "203", name: "Preschool" });
    store.answerKids("203");
    expect(kidsTeamToAsk(TEAMS, [], store.get())).toBeNull();
  });

  it("asks nothing while any team is already marked a kids team", () => {
    expect(kidsTeamToAsk(TEAMS, ["999"], NO_MOMENTS)).toBeNull();
    // An id that isn't a Planning Center id isn't a mark.
    expect(kidsTeamToAsk(TEAMS, ["", "x"], NO_MOMENTS)?.id).toBe("202");
  });

  it("skips a team without a Planning Center id", () => {
    expect(kidsTeamToAsk([{ id: "Nursery", name: "Nursery" }, { id: "0202", name: "Kids" }], [], NO_MOMENTS)).toBeNull();
  });

  it("gives the Finish list its facts: looking, and answered once marked or every one said No", () => {
    const { storage } = memoryStorage();
    const store = momentsStore(storage);
    expect(kidsFacts(TEAMS, [], store.get())).toEqual({ looking: true, answered: false });
    expect(kidsFacts(TEAMS, ["202"], store.get())).toEqual({ looking: true, answered: true });
    store.answerKids("202"); store.answerKids("203");
    expect(kidsFacts(TEAMS, [], store.get())).toEqual({ looking: true, answered: true });
    expect(kidsFacts([{ id: "201", name: "Greeters" }], [], NO_MOMENTS)).toEqual({ looking: false, answered: true });
  });
});

describe("each question fires once and is remembered", () => {
  it("your name: due while a note ends [Your name] and no name is set, until it's left", () => {
    const { storage } = memoryStorage();
    const store = momentsStore(storage);
    const note = "Hi Riley,\n\nThank you,\n[Your name]";
    expect(nameMomentDue(store.get(), false, note)).toBe(true);
    expect(nameMomentDue(store.get(), true, note)).toBe(false);
    expect(nameMomentDue(store.get(), false, "Thank you,\nPat")).toBe(false);
    store.leaveName();
    expect(nameMomentDue(store.get(), false, note)).toBe(false);
  });

  it("People: due while People isn't granted, until the person opens without an address", () => {
    const { storage } = memoryStorage();
    const store = momentsStore(storage);
    expect(peopleQuestionDue(store.get(), false)).toBe(true);
    expect(peopleQuestionDue(store.get(), true)).toBe(false);
    store.declinePeople();
    expect(peopleQuestionDue(store.get(), false)).toBe(false);
  });

  it("the phone line: due only after a notice was sent on this Mac, never once answered, never while phone notices are on", () => {
    const { storage } = memoryStorage();
    const store = momentsStore(storage);
    expect(phoneMomentDue(store.get(), false)).toBe(false);
    store.noticeSent();
    expect(store.get().noticeSent).toBe(true);
    expect(phoneMomentDue(store.get(), store.get().noticeSent)).toBe(true);
    expect(phoneMomentDue(store.get(), true, true)).toBe(false);
    store.answerPhone("no");
    expect(phoneMomentDue(store.get(), true)).toBe(false);
    const other = momentsStore(memoryStorage().storage);
    other.answerPhone("set-up");
    expect(phoneMomentDue(other.get(), true)).toBe(false);
  });

  it("keeps only the answers, under ozzie.moments.v1: no names, no team names", () => {
    const { map, storage } = memoryStorage();
    const store = momentsStore(storage);
    store.leaveName(); store.declinePeople(); store.answerKids("202"); store.answerPhone("no"); store.noticeSent();
    expect(JSON.parse(map.get(MOMENTS_KEY)!)).toEqual({ name: "left", people: "declined", kids: { "202": "no" }, phone: "no", noticeSent: true });
    expect([...map.keys()]).toEqual([MOMENTS_KEY]);
    // A team name is never a key.
    store.answerKids("Nursery");
    expect(JSON.parse(map.get(MOMENTS_KEY)!).kids).toEqual({ "202": "no" });
  });

  it("reads what's kept strictly: anything odd is as if never answered", () => {
    expect(parseMoments(null)).toEqual(NO_MOMENTS);
    expect(parseMoments({ name: "Pat", people: "yes", kids: { Nursery: "no", "202": "yes", "203": "no" }, phone: "maybe", noticeSent: "true" }))
      .toEqual({ ...NO_MOMENTS, kids: { "203": "no" } });
    const broken = momentsStore(memoryStorage({ [MOMENTS_KEY]: "{not json" }).storage);
    expect(broken.get()).toEqual(NO_MOMENTS);
  });

  it("asks again (never crashes) when this Mac's storage refuses", () => {
    const refusing: KeyValue = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const store = momentsStore(() => refusing);
    expect(() => store.leaveName()).not.toThrow();
    expect(store.get()).toEqual(NO_MOMENTS);
  });
});

describe("the Finish list's memory (ozzie.finish-list.v1)", () => {
  it("keeps hidden and Not now, and nothing else", () => {
    const { map, storage } = memoryStorage();
    const store = finishStore(storage);
    expect(store.get()).toEqual({ hidden: false, notNow: [] });
    store.notNow("ai"); store.notNow("ai"); store.notNow("start");
    expect(store.get()).toEqual({ hidden: false, notNow: ["start", "ai"] });
    store.hide();
    expect(JSON.parse(map.get(FINISH_KEY)!)).toEqual({ hidden: true, notNow: ["start", "ai"] });
    expect(parseFinish({ hidden: "yes", notNow: ["ai", "nonsense", 3] })).toEqual({ hidden: false, notNow: ["ai"] });
  });
});
