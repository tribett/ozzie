// Placeholder labels for one app session (build contract §6: stable tokens, local restore).
// People and positions use the Ask session's labels, so the same person or position keeps one
// label whether it reached the model through Ask or through an agent tool. Rooms, follow-up
// workflows and steps, and imported events get their own label families here. Everything a label
// stands for stays on this Mac; only the label itself is ever placed in a tool result.
//
// A position is labelled by its name, as Ask labels it. When two teams of the same plan hold a
// position of the same name, the tools label each team's one by (team, name) instead, so their
// people and statuses are never merged (review 2026-11-14 B-S2); a question naming the position
// still gets the name's own label, which stands for every team's position of that name.
//
// With more than one service watched (owner request 2026-11-21), each service a question names gets a [Service N] label
// here, by its own name (core/src/service-names.ts serviceKey: two names that read the same are one service). A task whose
// question holds one reads the services tools for that service only (host.ts, tools.ts `scope`); the label is put back as
// the service's name on this Mac only.
import { AskSession, type AskedQuestion } from "../ask.js";
import { serviceKey } from "../service-names.js";
import { roleWithService } from "../sunday-brief.js";

export type LabelKind = "person" | "role" | "room" | "workflow" | "step" | "event" | "service";
export type LabelTarget =
  | { kind: "person"; scope: string; id: string }
  | { kind: "role"; name: string; team?: string }
  | { kind: "room" | "workflow" | "step" | "event"; id: string }
  | { kind: "service"; name: string };

/** Every label a tool may issue: the families below, numbered from 1. */
export const LABEL_PATTERN = /\[(?:Person|Role|Room|Workflow|Step|Event|Service) [1-9]\d{0,3}\]/gu;
/** Any square-bracketed text, label or not. */
export const BRACKETED = /\[[^\]\n]{0,80}\]/gu;
export const YOUR_NAME = "[Your name]";
const FAMILY: Record<"room" | "workflow" | "step" | "event", string> = { room: "Room", workflow: "Workflow", step: "Step", event: "Event" };

export class HarnessSession {
  readonly ask: AskSession;
  readonly #targets = new Map<string, LabelTarget>();
  readonly #own = new Map<string, string>();
  readonly #counts = { room: 0, workflow: 0, step: 0, event: 0 };
  readonly #services = new Map<string, string>();
  constructor(ask: AskSession = new AskSession()) { this.ask = ask; }

  /** `scope` is the organization, so one Planning Center person keeps one label across checks. */
  person(scope: string, id: string): string {
    const label = this.ask.person(scope, id);
    this.#targets.set(label, { kind: "person", scope, id });
    return label;
  }
  /** A position, by its exact name; with `team`, that team's position of the name only (header). */
  role(name: string, team?: string): string {
    const label = this.ask.role(team === undefined ? name : `${name}\u0000${team}`);
    this.#targets.set(label, team === undefined ? { kind: "role", name } : { kind: "role", name, team });
    return label;
  }
  room(id: string): string { return this.#mint("room", id); }
  workflow(id: string): string { return this.#mint("workflow", id); }
  step(id: string): string { return this.#mint("step", id); }
  event(id: string): string { return this.#mint("event", id); }
  /** A watched service, by its own name (header); one label for names that read the same. */
  service(name: string): string {
    const key = serviceKey(name) || name.trim();
    let label = this.#services.get(key);
    if (!label) {
      label = `[Service ${this.#services.size + 1}]`;
      this.#services.set(key, label);
      this.#targets.set(label, { kind: "service", name: name.trim() });
    }
    return label;
  }
  #mint(kind: "room" | "workflow" | "step" | "event", id: string): string {
    const key = `${kind}\u0000${id}`;
    let label = this.#own.get(key);
    if (!label) {
      label = `[${FAMILY[kind]} ${++this.#counts[kind]}]`;
      this.#own.set(key, label);
      this.#targets.set(label, { kind, id });
    }
    return label;
  }

  /** Whether this session issued the label (through a tool or a prepared question). */
  has(label: string): boolean { return this.#targets.has(label); }
  target(label: string): LabelTarget | undefined { return this.#targets.get(label); }
  /** Labels a prepared Ask question used, so later tool arguments and restores know them. */
  record(asked: AskedQuestion, scope: string): void {
    for (const [label, id] of asked.people) if (label.startsWith("[Person ")) this.#targets.set(label, { kind: "person", scope, id });
    for (const [label, name] of asked.roles) if (!this.#targets.has(label)) this.#targets.set(label, { kind: "role", name });
  }
}

export const labelsIn = (text: string): string[] => [...new Set(text.match(LABEL_PATTERN) ?? [])];
export const kindOf = (label: string): LabelKind | null => {
  const m = /^\[(Person|Role|Room|Workflow|Step|Event|Service) [1-9]\d{0,3}\]$/u.exec(label);
  return m ? m[1]!.toLowerCase() as LabelKind : null;
};

/** What a label is put back as, on this Mac only. */
export interface RestoreSources {
  names: Readonly<Record<string, string>>;
  /** The organization of the check the names come from. A person label issued for another organization restores as "a team member". */
  organization?: string;
  /** Room, workflow and step display names (capture.labels `room:<id>` or operations.labels `room<id>`). Local only. */
  places?: Readonly<Record<string, string>>;
  /** Imported event titles by id (fictional import). Local only. */
  events?: Readonly<Record<string, string>>;
  sender?: string;
  /** Drafts greet people by first name. */
  firstNames?: boolean;
  /** The church's own zone, for showing ISO times in plain words. */
  timeZone?: string | null;
  /** This Mac's zone, for the times that say when Ozzie checked (CHECK_TIME); this Mac's own when not given (tests pin one). */
  macZone?: string | null;
  /**
   * With more than one service watched (owner decision 2026-11-19): the service a role is in, by the role's name and,
   * when its label names one, its team; null when that isn't one service. Its name is said after the role ("Greeter
   * (Youth Night)"). Local only: service names never reach a model.
   */
  roleService?: (name: string, team?: string) => string | null;
}
const GENERIC: Record<LabelKind, string> = {
  person: "a team member", role: "a role", room: "a room", workflow: "a follow-up workflow", step: "a follow-up step", event: "an event",
  service: "a service",
};

// Times stay ISO 8601 all the way to this Mac (the model copies them exactly; verification checks them
// against the tool results). Here they become plain words in the church's own zone.
const ISO_DATETIME = /\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})(?![\d:])/gu;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b(?![T\d])/gu;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const clock = (hour: number, minute: string) => `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
/**
 * A time that says when Ozzie checked or read something, in a sentence Ozzie writes on this Mac after the AI's last step
 * (compose.ts: a background check's "checked …", the fictional import's "from …"): kept as this token until it is shown,
 * then said on this Mac's clock, never the church's (the rule since 0.5.5: service and role times on the church's clock,
 * Ozzie's own checks on this Mac's). Never in a tool result or anything sent: the tools and the facts keep their ISO times.
 */
export const CHECK_TIME = /\{\{checked:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))\}\}/gu;
export const checkTime = (iso: string): string => `{{checked:${iso}}}`;
/** An instant's clock and date in `zone` ("9:30 AM on November 22"), or this Mac's own zone; null for a zone this runtime doesn't know. */
function inZone(instant: number, zone: string | undefined): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { ...(zone ? { timeZone: zone } : {}), month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(instant));
    const part = (type: string) => parts.find(p => p.type === type)?.value ?? "";
    return `${clock(+part("hour"), part("minute"))} on ${MONTHS[+part("month") - 1]} ${+part("day")}`;
  } catch { return null; }
}
/**
 * "2026-11-22T09:30-05:00" → "9:30 AM on November 22" in the church's zone; "2026-11-22" → "November 22". A check time
 * (CHECK_TIME) the same way on this Mac's clock (`macZone`, or this Mac's own zone). Local only.
 */
export function showTimes(text: string, timeZone?: string | null, macZone?: string | null): string {
  return text.replace(CHECK_TIME, (_whole, iso: string) => {
    const instant = Date.parse(iso);
    return (Number.isNaN(instant) ? null : inZone(instant, macZone ?? undefined)) ?? iso;
  }).replace(ISO_DATETIME, (whole, y: string, mo: string, d: string, h: string, mi: string, offset: string) => {
    const instant = Date.parse(whole);
    if (Number.isNaN(instant) || +mo < 1 || +mo > 12) return whole;
    // Not a zone this runtime knows: the time as written below.
    const zoned = timeZone ? inZone(instant, timeZone) : null;
    return zoned ?? `${clock(+h, mi)}${offset === "Z" ? " UTC" : ""} on ${MONTHS[+mo - 1]} ${+d}`;
  }).replace(ISO_DATE, (whole, _y: string, mo: string, d: string) => +mo >= 1 && +mo <= 12 && !Number.isNaN(Date.parse(whole)) ? `${MONTHS[+mo - 1]} ${+d}` : whole);
}

/**
 * A person as a write-up keeps them on this Mac (responsibility-runner.ts): their Planning Center id in a fixed token,
 * never their name, filled in from the check on screen only when the write-up is shown (fillPeople).
 */
export const PERSON_TOKEN = /\{\{person:([A-Za-z0-9_-]{1,64})\}\}/gu;
/** Names for restoreLabels that keep each person as their token: what a kept write-up is written with. */
export const keptNames = (names: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.keys(names).filter(id => /^[A-Za-z0-9_-]{1,64}$/u.test(id)).map(id => [id, `{{person:${id}}}`]));
/** Local only: each person token back to the name the current check holds for that id, or "a team member". */
export const fillPeople = (text: string, names: Readonly<Record<string, string>>): string =>
  text.replace(PERSON_TOKEN, (_whole, id: string) => (Object.hasOwn(names, id) ? names[id]?.trim() : "") || GENERIC.person);

/**
 * Local only: labels back to names, and ISO times to plain words. A label this session didn't issue, or with nothing
 * known, becomes plain words, as "[a team member]" (a name part several people share) does (review C11).
 */
export function restoreLabels(text: string, session: HarnessSession, sources: RestoreSources): string {
  const place = (kind: string, id: string) => sources.places?.[`${kind}:${id}`] ?? sources.places?.[`${kind}${id}`];
  // Times first, so nothing a name or place holds is ever read as a time.
  return showTimes(text, sources.timeZone, sources.macZone).replace(/\[Your name\]/gu, () => sources.sender?.trim() || YOUR_NAME)
    .replace(/\[a team member\]/gu, GENERIC.person).replace(LABEL_PATTERN, label => {
    const t = session.target(label), kind = kindOf(label)!;
    if (!t) return GENERIC[kind];
    if (t.kind === "person") {
      if (sources.organization !== undefined && t.scope !== sources.organization) return GENERIC.person;
      const name = sources.names[t.id]?.trim();
      return name ? (sources.firstNames ? name.split(/\s+/u)[0]! : name) : GENERIC.person;
    }
    if (t.kind === "role") return roleWithService(t.name, sources.roleService?.(t.name, t.team));
    if (t.kind === "service") return t.name || GENERIC.service;
    const restored = t.kind === "event" ? sources.events?.[t.id] : place(t.kind, t.id);
    return restored?.trim() || GENERIC[t.kind];
  });
}
