// A task about one watched service (owner request 2026-11-21; tools.ts `scope`): rooms, follow-ups and group meetings are
// the first service's, as its page shows them, so an overview or the open decisions added on this Mac hold them for the
// first service only (review B, F9); without a scope every result is the same as before. Fixed fictional data.
import { describe, expect, it } from "vitest";
import { decisionsLeftOut } from "../../src/harness/compose.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools, OVERVIEW_FOLLOW_UP, OVERVIEW_ROOM } from "../../src/harness/tools.js";
import { FRESH, harnessData, twoServices } from "./fixtures.js";

const signal = new AbortController().signal;
const FIRST = "Canary Weekend Service", SECOND = "Canary Youth Night";
const kinds = (payload: unknown) => ((payload as { findings: { kind: string }[] }).findings).map(f => f.kind);

describe("rooms, follow-ups and group meetings go with the first service", () => {
  const data = twoServices(harnessData({ mode: "live" }));
  const tools = () => new HarnessTools(data, new HarnessSession(), { now: () => FRESH });

  it("an overview for the first service holds them, one for another service doesn't, and an unscoped one is as before", async () => {
    const all = (await tools().run("sunday.overview", {}, signal)).payload;
    const first = (await tools().run("sunday.overview", {}, signal, "t", [FIRST])).payload;
    const second = (await tools().run("sunday.overview", {}, signal, "t", [SECOND])).payload;
    expect(kinds(all)).toContain(OVERVIEW_ROOM);
    expect(kinds(all)).toContain(OVERVIEW_FOLLOW_UP);
    expect(kinds(first).filter(k => k === OVERVIEW_ROOM || k === OVERVIEW_FOLLOW_UP)).toEqual(kinds(all).filter(k => k === OVERVIEW_ROOM || k === OVERVIEW_FOLLOW_UP));
    expect(kinds(second)).not.toContain(OVERVIEW_ROOM);
    expect(kinds(second)).not.toContain(OVERVIEW_FOLLOW_UP);
    // Unscoped, exactly as with no services known at all.
    const plain = { ...data };
    delete plain.services;
    delete plain.serviceOfTeam;
    const before = new HarnessTools(plain, new HarnessSession(), { now: () => FRESH });
    expect(JSON.stringify(all)).toBe(JSON.stringify((await before.run("sunday.overview", {}, signal)).payload));
  });

  it("the first service is the one marked first, never the one listed first", async () => {
    const reversed = { ...data, services: [...(data.services ?? [])].reverse() };
    const second = (await new HarnessTools(reversed, new HarnessSession(), { now: () => FRESH }).run("sunday.overview", {}, signal, "t", [SECOND])).payload;
    expect(kinds(second)).not.toContain(OVERVIEW_ROOM);
    const unmarked = { ...data, services: (data.services ?? []).map(s => ({ name: s.name, read: s.read })) };
    const first = (await new HarnessTools(unmarked, new HarnessSession(), { now: () => FRESH }).run("sunday.overview", {}, signal, "t", [FIRST])).payload;
    expect(kinds(first)).not.toContain(OVERVIEW_ROOM);
  });

  it("the open decisions added on this Mac hold rooms and follow-ups for the first service only", async () => {
    const t = tools();
    const first = await decisionsLeftOut(t, '{"answer":"not-covered"}', [], signal, undefined, [FIRST]);
    const second = await decisionsLeftOut(t, '{"answer":"not-covered"}', [], signal, undefined, [SECOND]);
    expect(first.evidence.map(e => e.tool)).toEqual(["sunday.overview", "rooms.conflicts", "followups.unowned"]);
    expect(second.evidence.map(e => e.tool)).toEqual(["sunday.overview"]);
  });
});
