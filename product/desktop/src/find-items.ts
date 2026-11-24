// What Find in Ozzie can find (owner decision 2026-11-24), built from what the pages already hold: Ozzie's pages, Settings'
// sections, Church rules' headings, what the Services page shows to decide for every service watched, the people on those
// plans, visitor cards open for review, and a few safe things to do. Pure: no storage, no native call, no network, nothing
// kept. A church's items come only from what its own pages show, and while the example church is on, only the example's
// (no count of visitor cards, none of the church's lists). The church's own lists are searched by their names and the
// people's names in them, never by any other cell and never the church's notes (owner decision 2026-11-24, item 3); what is
// found goes no further than this box, and choosing it opens that list on Church lists by the list's id.
import type { SundayBrief } from "../../../core/src/sunday-brief.js";
import { applyDecisions, type DecidedItem, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import type { SundayOperations } from "../../../core/src/operations-capture.js";
import { genesisLabel, newSubmissionLine, type GenesisView } from "../../../core/src/church-systems/genesis-view.js";
import { labelsOf } from "../../../core/src/church-systems/placeholders.js";
import { eventWhen, type SystemWords } from "./church-system.js";
import { fold, matchesOf, prepare, typedWords, type Prepared } from "./find-match.js";
import { PROCEDURES_TITLE } from "./rules-page.js";

export type FindGroup = "pages" | "settings" | "rules" | "decide" | "people" | "lists" | "genesis" | "cards" | "actions";
/** Each group's heading, in the order the groups are listed. */
export const GROUPS: readonly { id: FindGroup; heading: string }[] = [
  { id: "pages", heading: "Pages" },
  { id: "settings", heading: "Settings" },
  { id: "rules", heading: "Church rules" },
  { id: "decide", heading: "Things to decide" },
  { id: "people", heading: "People on your plans" },
  { id: "lists", heading: "Church lists" },
  { id: "genesis", heading: "Coming up in Genesis" },
  { id: "cards", heading: "Visitor cards" },
  { id: "actions", heading: "Do something" },
];
/** Said under the people's heading: their order isn't a ranking. */
export const PEOPLE_ORDER = "Not ranked. People on a role with something to decide come first, then A to Z.";

/** The safe things Find can do. None of them changes anything in a church system. */
export type FindAction = "check" | "ask" | "ai" | "bigger" | "smaller" | "how" | "check-setup";
/** Where choosing an item goes, or what it does. */
export type FindTarget =
  | { to: "page"; page: string }
  | { to: "setup" }
  | { to: "settings"; section: string }
  | { to: "heading"; page: string; id: string }
  | { to: "procedure"; id: string }
  /** A list on Church lists, by its id only: nothing of what it holds. */
  | { to: "list"; id: string }
  | { to: "card"; key: string }
  | { to: "do"; action: FindAction };

export interface FindItem {
  /** Unique in one list. */
  id: string;
  group: FindGroup;
  title: string;
  /** One quieter line beside the title: a role and service, Needs a decision, a key to press. */
  detail: string | null;
  /** Plain-English words that also find it, never shown. */
  other: readonly string[];
  target: FindTarget;
}

/** One watched service as its part of the Services page shows it. */
export interface FindService {
  /** Its name, said beside its items only when more than one service is watched. */
  name: string | null;
  brief: SundayBrief;
  decisions: readonly SundayDecision[];
  operations: SundayOperations | null;
  names: Readonly<Record<string, string>>;
  /** Its check: who is on the plan comes from here. */
  capture: SundayCapture | SystemCapture | null;
  /** The Services page's own key for a card of this service (another service's keys are its own: services-merge.ts partKey). */
  key: (findingKey: string) => string;
}

export interface FindInput {
  words: SystemWords;
  /** The sidebar's pages, as it names them. */
  pages: readonly { id: string; label: string }[];
  /** "Setting up" leads back into setup while it's unfinished. */
  settingUp: string | null;
  /** Settings' sections on the page now, as its own index names them. */
  settings: readonly { id: string; label: string }[];
  /** Church rules' headings on the page now, by their ids. */
  rules: readonly { id: string; label: string }[];
  /** What the AI is asked to do, each by its title on Church rules. */
  procedures: readonly { id: string; title: string }[];
  /** The example church is on: only its own made-up people and findings are found, and no visitor cards. */
  example: boolean;
  /** Every watched service, the first one first. Empty on Genesis, and before anything is read. */
  services: readonly FindService[];
  /** A church on Genesis: what its Services page shows. */
  genesis: { capture: SystemCapture; view: GenesisView } | null;
  /** Visitor cards open for review now (a count). */
  openCards: number;
  /** The church's own lists (listsForFind): each one's name and the people's names in it. */
  lists: readonly FindList[];
  /** The safe things that can be done now. */
  can: { check: boolean; ask: boolean; checkSetup: boolean };
}

const nameOf = (names: Readonly<Record<string, string>>, id: string | undefined): string =>
  id !== undefined && Object.hasOwn(names, id) && names[id] ? names[id]! : "Someone";
const plural = (n: number, one: string, many: string) => n === 1 ? one : `${n} ${many}`;

/** Plain-English words for each page, by the sidebar's id. */
const PAGE_WORDS: Readonly<Record<string, readonly string[]>> = {
  today: ["home", "start", "briefing", "morning", "overview"],
  sunday: ["service", "services", "sunday", "plan", "plans", "roles", "serving", "volunteers", "schedule", "covered", "coverage", "open roles"],
  cards: ["visitor", "visitors", "guest", "guests", "newcomer", "welcome", "connection cards", "photos"],
  rules: ["rules", "kids", "leads", "rooms", "background checks", "weeks in a row"],
  lists: ["lists", "spreadsheet", "sheet", "notes", "files", "links"],
  automatic: ["jobs", "watch", "schedule", "automatic", "notices", "notifications", "quiet hours", "keep an eye"],
  activity: ["history", "activity", "log", "what ran", "record", "past"],
  connection: ["settings", "preferences", "options", "setup", "configure"],
};
/** Plain-English words for Settings' sections, by heading id. */
const SETTINGS_WORDS: Readonly<Record<string, readonly string[]>> = {
  "pco-title": ["connect", "sign in", "sign out", "disconnect", "church", "service", "services", "plan", "watch another service",
    "rooms", "follow-ups", "groups", "calendar access", "people access", "adding people", "changes you confirm"],
  "systems-title": ["b1", "b1 church", "breeze", "genesis", "planning center", "switch", "other systems"],
  "your-name-title": ["name", "signature", "sign off", "notes"],
  "ai-title": ["ai", "key", "api key", "model", "claude", "anthropic", "openai", "chatgpt", "ollama", "this mac", "ozzie's ai", "zero data retention"],
  "runs-title": ["notifications", "notices", "quiet hours", "schedule", "keeping watch", "start with this mac", "login", "menu bar", "closed window", "phone", "ntfy"],
  "calendars-title": ["calendar", "calendars", "events", "icloud", "google"],
  "lists-title": ["lists", "spreadsheet", "notes"],
  "other-ai-title": ["siri", "shortcuts", "spotlight", "claude", "other ai apps", "share", "sharing"],
  "updates-title": ["update", "updates", "version", "new version", "download"],
  "saved-title": ["saved", "copies", "delete", "history"],
  "check-setup": ["setup", "troubleshoot", "problem", "not working", "walk through setup again"],
};
const RULE_WORDS: Readonly<Record<string, readonly string[]>> = {
  "streak-rules": ["streak", "weeks in a row", "check in", "care"],
  "leads-rules": ["lead", "leads", "leader", "scheduled lead"],
  "kids-rules-title": ["kids", "children", "nursery", "background check", "background checks", "confirmed people"],
  "forms-rules-title": ["forms", "submissions", "people forms"],
  "checkins-rules-title": ["check-ins", "checkins", "kids rooms"],
  "rooms-rules": ["room", "rooms", "booking", "bookings", "setup time", "not shared"],
  "from-cards-title": ["don't flag", "always do", "corrections", "told ozzie", "feedback"],
  "how-checks-title": ["ai", "procedures", "steps", "how it works", "see how this works"],
};

/**
 * One finding as a row: Ozzie's own short words for what its card says, a person named as the card names them (this
 * Mac only), and the role. Never a score or a label about anyone.
 */
function findingRow(i: DecidedItem, names: Readonly<Record<string, string>>): { title: string; other: string[] } {
  const f = i.finding, role = f.position?.name ?? "A role", who = nameOf(names, f.person_id);
  switch (f.kind) {
    case "needs-people": return { title: `${role} still needs ${f.remaining === 1 || f.remaining === undefined ? "one more person" : `${f.remaining} more people`}`,
      other: ["open role", "needs people", "unfilled", "cover", "who could help"] };
    case "pending": return { title: `${who} is pending for ${role}`, other: ["pending", "waiting", "no answer", "unanswered", "request", "hasn't answered"] };
    case "streak": return { title: `${who} is scheduled ${f.sundays ?? 0} weeks in a row`, other: [role, "streak", "weeks in a row", "check in", "care"] };
    case "lead-missing": return { title: `No one is scheduled to lead ${role}`, other: ["lead", "leader", "scheduled lead"] };
    case "lead-unverified": return { title: `The scheduled lead for ${role} couldn't be confirmed`, other: ["lead", "leader", "scheduled lead"] };
    case "too-few-confirmed": return { title: `${role} has fewer confirmed people than your rule asks`, other: ["kids", "confirmed", "rule", "kids team"] };
    case "background-check": return { title: `A background check for someone on ${role}`, other: ["background check", "kids", "kids team"] };
    case "blockout": return { title: `${who} has a blockout while scheduled for ${role}`, other: ["blockout", "away", "conflict", "unavailable"] };
    default: return {
      title: f.role_facts ? (f.role_facts.roles === 1 ? "One role couldn't be checked" : `${f.role_facts.roles} roles couldn't be checked`)
        : f.stale ? "This check is out of date" : "Part of the service couldn't be checked",
      other: ["couldn't be checked", "incomplete", "out of date", "check again"],
    };
  }
}

/** The open cards of one service, in the page's order: Needs a decision before Worth a look. */
const openItems = (s: FindService): DecidedItem[] => {
  const items = applyDecisions(s.brief, s.decisions).items.filter(i => i.state !== "resolved");
  return [...items.filter(i => i.finding.tone === "decision"), ...items.filter(i => i.finding.tone !== "decision")];
};

/** What the Services page shows to decide or look at, for every service watched, each with its own card. */
function decideItems(services: readonly FindService[]): FindItem[] {
  const several = services.length > 1;
  const out: FindItem[] = [];
  services.forEach((s, at) => {
    const service = several && s.name ? ` · ${s.name}` : "";
    for (const i of openItems(s)) {
      const row = findingRow(i, s.names);
      const tag = i.state === "reopened" ? "Needs attention again" : i.finding.tone === "decision" ? "Needs a decision" : "Worth a look";
      out.push({ id: `decide:${at}:${i.finding.key}`, group: "decide", title: row.title, detail: `${tag}${service}`,
        other: [...row.other, ...(i.finding.position ? [i.finding.position.name] : []), ...(s.name ? [s.name] : [])], target: { to: "card", key: s.key(i.finding.key) } });
    }
    const ops = s.operations && !s.operations.stale ? s.operations : null;
    const found = ops?.result?.findings ?? [];
    const rooms = found.filter(f => f.kind === "room-overlap"), followUps = found.filter(f => f.kind === "unowned-overdue");
    const meetings = ops?.group_meetings.length ?? 0;
    const opsRow = (key: string, title: string, decision: boolean, other: string[]) => out.push({ id: `decide:${at}:ops:${key}:${title}`, group: "decide", title,
      detail: `${decision ? "Needs a decision" : "Worth a look"}${service}`, other: [...other, ...(s.name ? [s.name] : [])], target: { to: "card", key: s.key(key) } });
    if (rooms.length) opsRow("rooms", rooms.length === 1 ? "A room has overlapping bookings" : `${rooms.length} room booking overlaps`,
      rooms.some(r => r.certainty === "confirmed"), ["room", "rooms", "booking", "overlap", "double booked", "calendar"]);
    if (followUps.length) opsRow("follow-ups", followUps.length === 1 ? "A follow-up has no owner" : `${followUps.length} follow-ups have no owner`, true,
      ["follow-up", "follow up", "owner", "welcome", "people", "workflow"]);
    if (meetings) opsRow("rooms", `${plural(meetings, "A group meets", "groups meet")} at the same time as serving`, false, ["group", "groups", "meeting", "clash"]);
  });
  return out;
}

/** A person a church system lists on the service with no role. */
export const NO_ROLE = "On the service, with no role";
/** Who is on a plan, as its check read them: confirmed or not answered yet (never someone who said no), by role. */
export function planPeople(capture: SundayCapture | SystemCapture): { person_id: string; role: string; team_id: string | null }[] {
  const out = new Map<string, { person_id: string; role: string; team_id: string | null }>();
  const add = (person_id: string, role: string, team_id: string | null) => { out.set(JSON.stringify([person_id, team_id, role]), { person_id, role, team_id }); };
  if ("assignments" in capture) {
    const labels = labelsOf(capture);
    for (const a of capture.assignments) {
      if (a.status !== "accepted" && a.status !== "unconfirmed") continue;
      const role = Object.hasOwn(labels, `position:${a.position_id}`) ? labels[`position:${a.position_id}`]! : "A role without a name";
      add(a.person_id, role, capture.positions.find(p => p.id === a.position_id)?.team_id ?? null);
    }
    // Someone the system lists on the service with no role (Breeze), as its roster shows them.
    for (const person of capture.on_service) add(person, NO_ROLE, null);
    return [...out.values()];
  }
  type Row = { attributes?: Record<string, unknown>; relationships?: Record<string, { data?: unknown }> };
  const rel = (row: Row, key: string): string | null => {
    const d = row.relationships?.[key]?.data as { id?: unknown } | null | undefined;
    return d && typeof d.id === "string" ? d.id : null;
  };
  for (const read of capture.reads) {
    if (read.collection !== "team_members" || read.outcome !== "ok") continue;
    const data = read.body?.data;
    for (const row of (Array.isArray(data) ? data : data ? [data] : []) as Row[]) {
      const status = row.attributes?.["status"];
      if (status !== "C" && status !== "Confirmed" && status !== "U" && status !== "Unconfirmed") continue;
      const person = rel(row, "person"), role = row.attributes?.["team_position_name"];
      if (person && typeof role === "string" && role.trim()) add(person, role, rel(row, "team"));
    }
  }
  return [...out.values()];
}

const collator = new Intl.Collator("en-US", { sensitivity: "base", numeric: true });

/**
 * The people on every watched plan, each with one detail (their role, and its service when several are watched), going
 * to their own card, else their role's, else the Services page. Listed in one fixed order that isn't a ranking: those on
 * a card that needs a decision first, then A to Z (PEOPLE_ORDER says so).
 */
function peopleItems(services: readonly FindService[]): FindItem[] {
  const several = services.length > 1;
  const rows: { item: FindItem; first: boolean; name: string; role: string; at: number }[] = [];
  services.forEach((s, at) => {
    if (!s.capture) return;
    const items = openItems(s);
    for (const p of planPeople(s.capture)) {
      if (!Object.hasOwn(s.names, p.person_id) || !s.names[p.person_id]?.trim()) continue;
      const name = s.names[p.person_id]!.trim();
      const sameTeam = (team: string | undefined) => !p.team_id || !team || team === "?" || team === p.team_id;
      const own = items.find(i => i.finding.person_id === p.person_id && (!i.finding.position || (i.finding.position.name === p.role && sameTeam(i.finding.position.team_id))));
      const role = items.find(i => !i.finding.person_id && i.finding.position?.name === p.role && sameTeam(i.finding.position.team_id));
      const card = own ?? role;
      rows.push({ item: { id: `person:${at}:${p.person_id}:${p.team_id ?? ""}:${p.role}`, group: "people", title: name,
        detail: several && s.name ? `${p.role} · ${s.name}` : p.role, other: [p.role, ...(s.name ? [s.name] : [])],
        target: card ? { to: "card", key: s.key(card.finding.key) } : { to: "page", page: "sunday" } },
        first: own?.finding.tone === "decision" || role?.finding.tone === "decision", name, role: p.role, at });
    }
  });
  rows.sort((a, b) => Number(b.first) - Number(a.first) || collator.compare(a.name, b.name) || collator.compare(a.role, b.role) || a.at - b.at);
  return rows.map(r => r.item);
}

/** What a Genesis church's Services page shows: forms filled in again (Worth a look) and the events coming up. */
function genesisItems(g: { capture: SystemCapture; view: GenesisView }): FindItem[] {
  const labels = labelsOf(g.capture);
  return [
    ...g.view.newSubmissions.map(n => ({ id: `genesis:form:${n.form_id}`, group: "decide" as const, title: newSubmissionLine(n, labels), detail: "Worth a look",
      other: ["form", "forms", "filled in", "submissions"], target: { to: "page", page: "sunday" } as FindTarget })),
    ...g.view.upcoming.map(e => ({ id: `genesis:event:${e.event_id}`, group: "genesis" as const, title: genesisLabel(g.capture, `event:${e.event_id}`, "An event without a name"),
      detail: eventWhen("genesis", e.starts_at, g.capture.church.time_zone), other: ["event", "events", "coming up"],
      target: { to: "heading", page: "sunday", id: "genesis-coming" } as FindTarget })),
  ];
}

/** Everything Find can find now, group by group, each group in its page's own order. */
export function findItems(input: FindInput): FindItem[] {
  const w = input.words;
  const items: FindItem[] = [];
  if (input.settingUp) items.push({ id: "page:setup", group: "pages", title: input.settingUp, detail: null, other: ["setup", "set up", "connect", "first run"], target: { to: "setup" } });
  for (const p of input.pages) items.push({ id: `page:${p.id}`, group: "pages", title: p.label, detail: null, other: ["page", ...(PAGE_WORDS[p.id] ?? [])], target: { to: "page", page: p.id } });
  for (const s of input.settings) items.push({ id: `settings:${s.id}`, group: "settings", title: s.label, detail: "Settings", other: ["settings", ...(SETTINGS_WORDS[s.id] ?? [])],
    target: { to: "settings", section: s.id } });
  for (const r of input.rules) items.push({ id: `rules:${r.id}`, group: "rules", title: r.label, detail: "Church rules", other: ["church rules", "rules", ...(RULE_WORDS[r.id] ?? [])],
    target: { to: "heading", page: "rules", id: r.id } });
  for (const p of input.procedures) items.push({ id: `procedure:${p.id}`, group: "rules", title: p.title, detail: "What the AI is asked to do",
    other: ["ai", "procedure", "steps", "see how this works"], target: { to: "procedure", id: p.id } });
  items.push(...decideItems(input.services), ...peopleItems(input.services));
  // The church's own lists are real: never beside the example. A list's name, then the people in it in the file's order.
  if (!input.example) for (const l of input.lists) {
    items.push({ id: `list:${l.id}`, group: "lists", title: l.label, detail: "Church lists", other: ["list", "lists", "church lists"], target: { to: "list", id: l.id } });
    l.people.forEach((name, at) => items.push({ id: `list:${l.id}:${at}`, group: "lists", title: name, detail: `In ${l.label}`, other: [], target: { to: "list", id: l.id } }));
  }
  if (input.genesis) items.push(...genesisItems(input.genesis));
  // Visitor cards are real too, and their names stay on their own page: a count, and only while a review is open.
  if (!input.example && input.openCards > 0) items.push({ id: "cards:open", group: "cards", title: input.openCards === 1 ? "1 visitor card open for review" : `${input.openCards} visitor cards open for review`,
    detail: "Visitor cards", other: ["visitor", "visitors", "cards", "guest", "newcomer", "welcome", "review"], target: { to: "page", page: "cards" } });
  const action = (id: FindAction, title: string, detail: string | null, other: string[]) =>
    items.push({ id: `do:${id}`, group: "actions", title, detail, other, target: { to: "do", action: id } });
  if (input.can.check) action("check", w.checkNow, null, ["check", "refresh", "reload", "update", "read again", "check now", "sync"]);
  if (input.can.ask) action("ask", "Ask Ozzie", null, ["ask", "question", "chat"]);
  action("ai", "Choose how Ozzie uses AI", null, ["ai", "key", "api key", "model", "claude", "openai", "ollama", "settings"]);
  action("bigger", "Make text bigger", "⌘+", ["text size", "bigger text", "larger", "zoom", "font", "read"]);
  action("smaller", "Make text smaller", "⌘−", ["text size", "smaller text", "zoom", "font"]);
  if (input.can.ask) action("how", "See how Ozzie works", "What Ozzie can do, answered on this Mac", ["help", "what can you do", "how", "explain", "see how this works"]);
  if (input.can.checkSetup) action("check-setup", "Check my setup", null, ["setup", "troubleshoot", "problem", "not working"]);
  return items;
}

/** The starting points shown before anything is typed, by id, the first of these that exist. */
const STARTING = ["page:today", "page:sunday", "do:check", "settings:ai-title", "do:bigger"] as const;
export function startingPoints(items: readonly FindItem[]): FindItem[] {
  return STARTING.flatMap(id => items.find(i => i.id === id) ?? []);
}

/** Each item with its words folded once (Find does this as it opens); its detail line finds it too, as one of its other words. */
export const prepareItems = (items: readonly FindItem[]): Prepared<FindItem>[] =>
  items.map(item => ({ ...prepare({ title: item.title, other: [...(item.detail ? [item.detail] : []), ...item.other] }), item }));
/** Groups whose rows name people or what the page shows about them keep their own order, never one by how well they matched. */
const IN_ORDER: ReadonlySet<FindGroup> = new Set(["decide", "people", "lists"]);

/**
 * The matches for `typed`, by group: a group whose best match is better (in its title, then cleanly) comes first, and
 * otherwise GROUPS' order holds. Within a group, best first; what the Services page shows to decide, the people on the
 * plans and the church's lists keep their own order (the page's, never one by how well a name matched).
 */
export function findGroups(items: readonly FindItem[] | readonly Prepared<FindItem>[], typed: string): { id: FindGroup; heading: string; items: FindItem[] }[] {
  const prepared = items.map(i => "item" in i ? i : prepareItems([i])[0]!);
  return GROUPS.flatMap((g, at) => {
    const found = matchesOf(typed, prepared.filter(p => p.item.group === g.id), IN_ORDER.has(g.id));
    return found.length ? [{ ...g, items: found.map(f => f.item), best: Math.min(...found.map(f => f.tier)), at }] : [];
  }).sort((x, y) => x.best - y.best || x.at - y.at).map(({ id, heading, items: list }) => ({ id, heading, items: list }));
}

/**
 * The words of names Find holds that Ask can't put a label in place of: people in the church's own lists who aren't on a
 * plan Ozzie read (Ask knows only the plans' names). Each word of the name, the name's parts on either side of an
 * apostrophe ("O'Neil": "oneil" and "neil"), and two neighbouring words written as one ("Mary Jane": "maryjane").
 * Folded, for a yes or no about what was typed; never handed on. None while the example church is on: the lists are
 * real, and nothing real is used beside it.
 */
export function unaskableWords(input: FindInput): ReadonlySet<string> {
  const out = new Set<string>();
  if (input.example) return out;
  const known = new Set(input.services.flatMap(s => Object.values(s.names)).map(n => typedWords(n).join(" ")));
  const add = (word: string) => { if ([...word].length >= 2) out.add(word); };
  for (const l of input.lists) for (const name of l.people) {
    const w = typedWords(name);
    if (known.has(w.join(" "))) continue;
    w.forEach((word, i) => { add(word); if (i > 0) add(w[i - 1]! + word); });
    for (const part of typedWords(name.replace(/['’ʼ`]/gu, " "))) add(part);
  }
  return out;
}
/** A typed word without a possessive ending ("Pat's", "Pats"): the apostrophe is gone already, so a trailing s. */
const unpossessed = (word: string) => [...word].length > 2 && word.endsWith("s") ? word.slice(0, -1) : word;
/**
 * Whether what was typed may name such a person (unaskableWords): any typed word, with a possessive ending or without,
 * or two neighbouring typed words written as one ("O Neil"). A yes or no only. It fails safe: a common word that is also
 * someone's name ("Will", "Grace") counts too.
 */
export function namesUnaskable(typed: string, words: ReadonlySet<string>): boolean {
  if (!words.size) return false;
  const w = typedWords(typed);
  return w.some((word, i) => [word, unpossessed(word), ...(i > 0 ? [w[i - 1]! + word, unpossessed(w[i - 1]! + word)] : [])].some(x => words.has(x)));
}

/** Church rules' headings as the page shows them, by the ids the page gives them (rules-page.tsx and the sections in it). */
export function rulesHeadings(r: { other: boolean; systemName: string; leads: string; told: boolean; procedures: boolean }): { id: string; label: string }[] {
  const told = r.told ? [{ id: "from-cards-title", label: "What you've told Ozzie" }] : [];
  if (r.other) return [{ id: "system-rules", label: `What Ozzie checks with ${r.systemName}` }, ...told];
  return [
    { id: "streak-rules", label: "Serving many weeks in a row" }, { id: "leads-rules", label: r.leads }, { id: "kids-rules-title", label: "Kids teams" },
    { id: "forms-rules-title", label: "People forms" }, { id: "checkins-rules-title", label: "Check-Ins rooms" }, { id: "rooms-rules", label: "Rooms" }, ...told,
    ...(r.procedures ? [{ id: "how-checks-title", label: PROCEDURES_TITLE }] : []),
  ];
}

/** One of the church's own lists as Find holds it: its id and name, and the people's names in it, in the file's order. */
export interface FindList { id: string; label: string; people: readonly string[] }
/**
 * What Find reads of Church lists' state (church-sources.ts ChurchSourcesState): each list's id, name and the column the
 * leader chose for teams or roles, and its last read. The church's notes aren't part of it.
 */
export interface ListsSeen {
  sources: readonly { id: string; label: string; column: string | null }[] | null;
  reads: ReadonlyMap<string, { ok: true; sheet: { headers: readonly string[]; rows: readonly (readonly string[])[] } } | { ok: false }>;
}
/** At most this many names from one list. */
export const LIST_NAMES_MAX = 500;
const words = (header: string) => fold(header).split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
/** A header naming something that isn't a person ("Team name", "Room name"). */
const NOT_PEOPLE = new Set(["team", "role", "position", "ministry", "group", "event", "room", "class", "list", "service", "location", "site", "campus", "church",
  "file", "form", "plan", "song", "item", "door", "key", "user", "screen"]);
/** Headers that hold a person's name. */
const PEOPLE = new Set(["name", "names", "person", "people", "who", "full"]);
/** Headers that may hold a person's name or something else (a yes, a phone number): counted only where the cell looks like a name. */
const MAYBE_PEOPLE = new Set(["contact", "contacts", "volunteer", "volunteers", "member", "members", "leader", "leaders", "helper", "helpers", "parent", "parents",
  "guardian", "teacher", "teachers", "usher", "ushers", "greeter", "greeters"]);
/**
 * The columns of a list that hold people's names, by their headers alone: "Name", "Full name", "Who"; a "First name"
 * and a "Last name" column read together; and "Volunteer", "Contact", "Leader" and the like (`maybe`), whose cells count
 * only when they look like a name. Never the column the leader chose for teams or roles, and never a header that names
 * something else ("Team name"). No other cell is ever looked at.
 */
export function nameColumns(headers: readonly string[], chosen: string | null): { first?: number; last?: number; whole: number[]; maybe: number[] } {
  const out: { first?: number; last?: number; whole: number[]; maybe: number[] } = { whole: [], maybe: [] };
  headers.forEach((h, i) => {
    if (h === chosen) return;
    const w = words(h);
    if (!w.length || w.some(x => NOT_PEOPLE.has(x))) return;
    const named = w.includes("name") || w.includes("names");
    if (named && w.some(x => x === "first" || x === "given")) { out.first ??= i; return; }
    if ((named && w.some(x => x === "last" || x === "family")) || w.includes("surname")) { out.last ??= i; return; }
    if (w.every(x => PEOPLE.has(x))) out.whole.push(i);
    else if (w.every(x => PEOPLE.has(x) || MAYBE_PEOPLE.has(x))) out.maybe.push(i);
  });
  return out;
}
/** A cell that can't be a name: a number, an address, or an answer such as Yes or No. */
const NOT_A_NAME = /[\p{N}@]|^(?:yes|no|y|n|true|false|x|ok|n\/a|na|none|tbd|tba|[-–—✓✔✗✘])$/iu;
/** Two to four words, each starting with a capital letter, of letters, apostrophes, hyphens and dots only. */
const LOOKS_LIKE_A_NAME = /^\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*){1,3}$/u;
/** The church's own lists for Find: each list's name, and the people's names in the columns nameColumns finds. */
export function listsForFind(state: ListsSeen): FindList[] {
  return (state.sources ?? []).map(s => {
    const read = state.reads.get(s.id);
    if (!read?.ok) return { id: s.id, label: s.label, people: [] };
    const cols = nameColumns(read.sheet.headers, s.column);
    const people = new Set<string>();
    for (const row of read.sheet.rows) {
      if (people.size >= LIST_NAMES_MAX) break;
      const cell = (i: number | undefined) => { const v = i === undefined ? "" : (row[i] ?? "").replace(/\s+/gu, " ").trim(); return NOT_A_NAME.test(v) ? "" : v; };
      const joined = [cell(cols.first), cell(cols.last)].filter(Boolean).join(" ");
      const names = [joined, ...cols.whole.map(cell), ...cols.maybe.map(cell).filter(v => LOOKS_LIKE_A_NAME.test(v))];
      for (const name of names) if (name && name.length <= 120) people.add(name);
    }
    return { id: s.id, label: s.label, people: [...people].slice(0, LIST_NAMES_MAX) };
  });
}
