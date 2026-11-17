// "Looks good — I'll send it" on a prepared note (audit item 18): the leader's own mark that they will ask that person,
// kept on this Mac so the Sunday page's row for them and Today can say so quietly, with Undo. It is a mark only: nothing
// is sent, nothing is written to Planning Center, and opening a note in Mail or Messages never makes one; only the
// leader's click does. It is kept by ids and times alone (the person's Planning Center id, the finding's key, the
// Sunday's plan id), with the person's name put in on this Mac when it is shown.
//
// A mark lasts while that person's place in that finding stays as it was when the leader made it: once the plan changes
// for them (they accept, decline or are scheduled elsewhere, the role is filled, the finding is gone) or the Sunday has
// passed, it is dropped. Only App.tsx imports this module, and it hands the Sunday page and Today the words to show and
// Undo through their props (sunday-page.tsx `AskedSlot`); nothing that builds a model request, a notice, the copy for
// other AI apps or Siri imports it (product/desktop/test/asked.test.ts). Pure apart from the small store it is given.
import type { Finding, SundayBrief } from "../../../core/src/sunday-brief.js";
import type { KeyValueStore } from "./proactive.js";

/** One mark, by ids and times only. */
export interface AskedMark {
  /** The Sunday's plan id and its church-local date ("2026-11-22"), so the mark is dropped once the Sunday passes. */
  plan_id: string; plan_date: string | null;
  /** The finding the note was for (its stable key) and the person the note was for (a Planning Center id). */
  key: string; person_id: string;
  /** That person's place in that finding when the mark was made: a change drops the mark. */
  facts: string;
  /** When the leader said it. */
  at: string;
}

const KEY = "ozzie.asked.v1";
const KEPT = 200;
const ID = /^[1-9]\d{0,31}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isMark = (v: unknown): v is AskedMark => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return Object.keys(m).every(k => ["plan_id", "plan_date", "key", "person_id", "facts", "at"].includes(k))
    && typeof m.plan_id === "string" && ID.test(m.plan_id) && (m.plan_date === null || (typeof m.plan_date === "string" && DATE.test(m.plan_date)))
    && isText(m.key, 600) && typeof m.person_id === "string" && ID.test(m.person_id) && isText(m.facts, 600)
    && typeof m.at === "string" && Number.isFinite(Date.parse(m.at));
};

/** Where a person stands in a finding, as the mark keeps it: their place in it, never anything said about them. */
export function placeIn(finding: Finding, person: string): string {
  const p = finding.people;
  const where = p?.suggestions.some(x => x.person_id === person) ? "no-overlap" : p?.conflicts.some(x => x.person_id === person) ? "conflict"
    : p?.unverified.some(x => x.person_id === person) ? "unverified" : p?.left_out.some(x => x.person_id === person) ? "left-out"
      : finding.person_id === person ? `the-person:${finding.notification ?? ""}` : finding.leaders?.includes(person) ? "leader" : "none";
  return JSON.stringify([finding.kind, where, finding.confirmed?.includes(person) ?? false]);
}

/** A mark for this note: the finding and the person it was for, on the Sunday shown. */
export function askedMark(brief: Pick<SundayBrief, "plan">, finding: Finding, person: string, at: string): AskedMark | null {
  if (!ID.test(person) || !ID.test(brief.plan.id)) return null;
  return { plan_id: brief.plan.id, plan_date: brief.plan.date && DATE.test(brief.plan.date) ? brief.plan.date : null, key: finding.key, person_id: person, facts: placeIn(finding, person), at };
}

/** The marks that still hold for this Sunday as it reads now: its plan, the finding still there, the person's place unchanged. */
export function holding(marks: readonly AskedMark[], brief: Pick<SundayBrief, "plan" | "findings"> | null): AskedMark[] {
  if (!brief) return [];
  return marks.filter(m => {
    if (m.plan_id !== brief.plan.id) return false;
    const f = brief.findings.find(x => x.key === m.key);
    return Boolean(f) && placeIn(f!, m.person_id) === m.facts;
  });
}

/** "On Mon, Nov 16 you said you'd ask Riley about Greeter.": the first name, from the names read on this Mac. */
export function askedText(mark: Pick<AskedMark, "at" | "person_id">, names: Readonly<Record<string, string>>, role: string | null): string {
  const full = Object.hasOwn(names, mark.person_id) ? names[mark.person_id]?.trim() : "";
  const first = full ? full.split(/\s+/u)[0]! : "this person";
  const d = new Date(mark.at);
  const day = Number.isNaN(d.getTime()) ? "earlier" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `On ${day} you said you'd ask ${first}${role ? ` about ${role}` : ""}.`;
}

/** The marks kept on this Mac: read, add, undo; a mark whose Sunday has passed is forgotten when they are read. */
export function askedMemory(store: KeyValueStore, today: () => string) {
  const read = (): AskedMark[] => {
    try {
      const raw = JSON.parse(store.get(KEY) ?? "null") as { version?: unknown; marks?: unknown } | null;
      if (!raw || raw.version !== 1 || !Array.isArray(raw.marks)) return [];
      return (raw.marks as unknown[]).filter(isMark).filter(m => !m.plan_date || m.plan_date >= today()).slice(-KEPT);
    } catch { return []; }
  };
  const write = (marks: AskedMark[]) => { store.set(KEY, JSON.stringify({ version: 1, marks: marks.slice(-KEPT) })); return marks; };
  const same = (a: Pick<AskedMark, "plan_id" | "key" | "person_id">, b: Pick<AskedMark, "plan_id" | "key" | "person_id">) =>
    a.plan_id === b.plan_id && a.key === b.key && a.person_id === b.person_id;
  return {
    all: read,
    add: (mark: AskedMark) => write([...read().filter(m => !same(m, mark)), mark]),
    undo: (mark: Pick<AskedMark, "plan_id" | "key" | "person_id">) => write(read().filter(m => !same(m, mark))),
    /**
     * After a live check of a Sunday: its marks that no longer hold are dropped for good, so a mark never comes back when
     * the plan changes back. Marks for other Sundays are kept as they are.
     */
    settle(brief: Pick<SundayBrief, "plan" | "findings">): AskedMark[] {
      const all = read();
      const kept = new Set(holding(all, brief));
      const next = all.filter(m => m.plan_id !== brief.plan.id || kept.has(m));
      return next.length === all.length ? all : write(next);
    },
  };
}
