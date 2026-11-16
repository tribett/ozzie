// Check-Ins, after the fact: how many checked in to each room at each time of the most recent
// finished Sunday, as Planning Center Check-Ins counts them (regular, guest, volunteer), and where a
// room the leader matched to a kids team shows fewer volunteers checked in than that team's rule's
// number. Pure: no I/O, no model.
//
// Counts only. The native read never asks for a check-in, a person or a child, so nothing here can
// name one. A Sunday is "finished" once three hours had passed since the start of its last check-in
// time (every event read) when Ozzie read Check-Ins, whatever the time it's looked at; a Sunday not
// over at the read is shown only "so far, as of" that read, never compared, and its times that
// hadn't started are named. Facts are about the event the check read, not one chosen since. Without
// the church's own time zone nothing is placed.
//
// Every comparison is Worth a look (coordinator, review P M4): it sets volunteers who checked in to
// a room beside a rule about confirmed people on a Services team, and Check-Ins may lower a room's
// count when people check out. A room that merely shares a kids team's name says so. Anything not
// fully read is listed as not checked, never zero, and "held" is said only after a full comparison.
import { churchZone, localDate } from "../church-time.js";
import { kidsTeams } from "../kids-rules.js";
import type { SundayCapture, SundayRead, SundayRules } from "../sunday-capture.js";
import { applyFeedback, feedbackOf, type CorrectionEntry, type FeedbackTarget, type StopEntry } from "../finding-feedback.js";
import {
  answered, asRows, attr, bodyRows, count, earliest, evaluatedAt, instant, isId, labelOf, link, ms, plural, REASON, rowId, stateOf, unique,
} from "./common.js";
import { checkInsEvent, roomMatches } from "./rules.js";
import { clockIn, dayWords, isSunday } from "./words.js";

export const CHECK_INS_SOURCE = "Planning Center Check-Ins";
export const CHECK_INS_KIND = "checkins-below-rule";
/** A check-in time is taken as over this long after it starts; a Sunday is finished when its last time is. */
export const TIME_OVER_MS = 3 * 3_600_000;

export interface RoomCount { location_id: string; name: string | null; regular: number; guest: number; volunteer: number; line: string }
export interface CheckInsTime {
  event_id: string; event: string | null; event_time_id: string; starts_at: string; clock: string;
  /** The rooms this time's count read held, in Planning Center's order. */
  rooms: RoomCount[];
  /** Every room count for this time was read in full. */
  complete: boolean;
  checked_at: string | null;
}
/** A matched room (or one sharing a kids team's name) with fewer volunteers checked in than the rule's number. Never about a person. */
export interface RoomRuleFact {
  id: string; key: string; kind: typeof CHECK_INS_KIND;
  /** Always Worth a look until a live read settles what a count means after people check out. */
  tone: "look";
  matched: "chosen" | "same-name";
  location_id: string; room: string | null; team_id: string; team: string | null;
  needed: number; volunteers: number | null;
  event_time_id: string; starts_at: string; clock: string; sunday: string;
  checked_at: string; source: string; title: string; why: string[];
}
/** How a room the leader matched fared on the Sunday shown. */
export interface MatchState {
  location_id: string; room: string | null; team_id: string; team: string | null;
  /** "met": compared in full at every time of its event and at or above the number. */
  state: "met" | "below" | "set-aside" | "not-compared";
}
export interface CheckInsDay {
  sunday: string; sunday_words: string; on: string; times: CheckInsTime[];
  /** When Check-Ins was read ("9:20 AM"): these counts are as of then. */
  as_of: string;
  /** The Sunday is over by now, though it wasn't when read: check again for the finished counts. */
  over: boolean;
}
export interface CheckInsFacts {
  source: string;
  /** The church-local date of the most recent finished Sunday with check-in times, or null when none was placed. */
  sunday: string | null; sunday_words: string | null;
  /** "today", or "on Sunday, November 8": "today" only for a live check of today's date. */
  on: string | null;
  times: CheckInsTime[];
  below: RoomRuleFact[];
  hidden?: { kind: string; key: string; entry: StopEntry | CorrectionEntry }[];
  /** A Sunday whose times have started but isn't finished: its counts so far, still changing, never compared. */
  so_far: CheckInsDay | null;
  /** Each room the leader matched to a kids team, and how it fared on the Sunday shown. */
  matched: MatchState[];
  /** True only when every matched room was compared in full and met its rule's number, and nothing was set aside. */
  held: boolean;
  /** Every room Check-Ins listed for the events read (folders left out), for matching in Church rules. Local names. */
  rooms: { location_id: string; name: string | null; event_id: string; event: string | null }[];
  events: { event_id: string; name: string | null }[];
  /** Kids teams with no room matched in Church rules. */
  unmatched: { team_id: string; team: string | null }[];
  not_checked: string[];
  checked_at: string | null;
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const DAY_MS = 86_400_000;

/** A card as Church rules see it: "This isn't right" sets one Sunday's occurrence aside; "Stop flagging this" a team's. */
export function checkInsTarget(f: RoomRuleFact): FeedbackTarget {
  return {
    kind: CHECK_INS_KIND, key: f.key, occurrence: f.sunday, facts: JSON.stringify([f.volunteers, f.needed, f.matched]),
    tone: "look", scope: { team_id: f.team_id },
    labels: { ...(f.team ? { team: f.team } : {}), ...(f.room ? { room: f.room } : {}), occurrence: `${dayWords(f.sunday)} at ${f.clock}` },
  };
}

interface Placed { event_id: string; event_time_id: string; starts_at: string; date: string }

export function checkInsFacts(capture: SundayCapture, rules: SundayRules, options: { now?: string } = {}): CheckInsFacts | null {
  const reads = (collection: string) => capture.reads.filter(r => r.collection === collection);
  const eventReads = reads("checkins_events"), roomReads = reads("checkins_locations"), periodReads = reads("checkins_event_periods"), countReads = reads("checkins_location_counts");
  if (![...eventReads, ...roomReads, ...periodReads, ...countReads].length) return null;
  const now = evaluatedAt(capture, options.now);
  // When Check-Ins was read: whether a Sunday was over is judged at the read, never by the clock it's viewed at.
  const readAt = instant(capture.started_at) ?? now;
  const not_checked: string[] = [];
  const used: SundayRead[] = [...eventReads.filter(answered)];
  const picked = checkInsEvent(rules);
  // The event this check read, when one was chosen then; null: every listed event (up to the bound).
  const readChoice = isId(capture.checkins_event) ? capture.checkins_event : null;

  const eventState = stateOf(eventReads);
  const events = unique(bodyRows(eventReads.filter(answered)).map(r => rowId(r, "Event")).filter(isId))
    .map(event_id => ({ event_id, name: labelOf(capture, "checkins_event", event_id) }));
  const eventName = (id: string) => events.find(e => e.event_id === id)?.name ?? null;
  // A list cut at the bound with no event chosen: some events weren't read, so nothing is said about what they'd show.
  const cut = eventState === "truncated" && picked === null;
  if (cut) not_checked.push("Check-Ins lists more events than Ozzie reads at once, so some weren't read. Choose your Sunday event on Church rules.");
  else if (eventState !== "ok") not_checked.push(`Check-Ins events: ${REASON[eventState]}.`);
  const pickedListed = picked !== null && events.some(e => e.event_id === picked);
  // The events whose rooms and times this check read, and those the facts are about: the event chosen now when the
  // check read it, else what the check read. A choice made since that the check didn't read says to check again.
  const readEvents = events.filter(e => [...roomReads, ...periodReads].some(r => r.checkins_event_id === e.event_id));
  const pickedRead = picked !== null && readEvents.some(e => e.event_id === picked);
  const changed = picked !== readChoice && !(readChoice === null && pickedRead);
  if (picked !== null && !pickedListed && eventState === "ok") not_checked.push("The Check-Ins event you chose on Church rules isn't in Check-Ins any more.");
  else if (changed) {
    not_checked.push(picked === null && readChoice !== null
      ? `This check read only ${eventName(readChoice) ?? "one Check-Ins event"}. Check again to read every event.`
      : "This check read a different Check-Ins event than the one chosen on Church rules now. Check again to read the event you chose.");
  }
  const inScope = (id: string) => pickedRead ? id === picked : readChoice === null || id === readChoice;

  // Rooms people check in to, per event read; folders hold rooms and aren't checked in to.
  const rooms: CheckInsFacts["rooms"] = [];
  // Every listed event's rooms were read only when no event was chosen for the check and the list was complete.
  let roomsComplete = eventState === "ok" && readChoice === null;
  for (const event of readEvents) {
    const own = roomReads.filter(r => r.checkins_event_id === event.event_id);
    const state = stateOf(own);
    if (state !== "ok") { roomsComplete = false; not_checked.push(`Check-Ins rooms for ${event.name ?? "an event"}: ${REASON[state]}.`); }
    used.push(...own.filter(answered));
    for (const row of bodyRows(own.filter(answered))) {
      const id = rowId(row, "Location");
      if (!id || attr(row, "kind") === "Folder" || rooms.some(r => r.location_id === id)) continue;
      rooms.push({ location_id: id, name: labelOf(capture, "checkins_location", id), event_id: event.event_id, event: event.name });
    }
  }

  // Kids teams and the rooms matched to them: chosen on Church rules, or sharing a name (both only Worth a look).
  const teams = kidsTeams(rules);
  const chosen = roomMatches(rules).filter(m => teams.some(t => t.team_id === m.team_id));
  const listed = chosen.filter(m => rooms.some(r => r.location_id === m.location_id));
  const unlisted = chosen.filter(m => !rooms.some(r => r.location_id === m.location_id));
  const teamWords = (team: { name?: string | undefined } | undefined) => team?.name ? `the ${team.name} kids team` : "a kids team";
  // A matched room missing from a complete list of every event's rooms is gone; otherwise it just wasn't read this time.
  if (unlisted.length && roomsComplete) {
    not_checked.push(`${unlisted.length === 1 ? "1 Check-Ins room you matched to a kids team isn't" : `${unlisted.length} Check-Ins rooms you matched to a kids team aren't`} in Check-Ins any more.`);
  } else {
    for (const m of unlisted) {
      not_checked.push(`A Check-Ins room you matched to ${teamWords(teams.find(t => t.team_id === m.team_id))} wasn't read in this check${readChoice !== null ? " (it may be in another event than the one read)" : ""}, so it wasn't compared.`);
    }
  }
  const matches: { location_id: string; team_id: string; matched: RoomRuleFact["matched"] }[] = listed.map(m => ({ ...m, matched: "chosen" }));
  for (const team of teams) {
    if (!team.name || listed.some(m => m.team_id === team.team_id)) continue;
    for (const room of rooms) {
      if (room.name && fold(room.name) === fold(team.name) && !listed.some(m => m.location_id === room.location_id)) {
        matches.push({ location_id: room.location_id, team_id: team.team_id, matched: "same-name" });
      }
    }
  }
  const unmatched = teams.filter(t => !listed.some(m => m.team_id === t.team_id)).map(t => ({ team_id: t.team_id, team: t.name ?? null }));
  const stateOfMatch = (m: { location_id: string; team_id: string }, state: MatchState["state"]): MatchState => {
    const room = rooms.find(r => r.location_id === m.location_id), team = teams.find(t => t.team_id === m.team_id);
    return { location_id: m.location_id, room: room?.name ?? null, team_id: m.team_id, team: team?.name ?? null, state };
  };
  const notCompared = chosen.map(m => stateOfMatch(m, "not-compared"));
  const base = { source: CHECK_INS_SOURCE, rooms, events, unmatched, held: false };
  const none = (lines: string[], so_far: CheckInsDay | null = null): CheckInsFacts =>
    ({ ...base, sunday: null, sunday_words: null, on: null, times: [], below: [], so_far, matched: notCompared, not_checked: lines, checked_at: earliest(used) });

  const zone = churchZone(capture).zone;
  if (!zone) return none([...not_checked, "Check-Ins: the church's time zone wasn't read, so last Sunday's check-ins couldn't be placed."]);

  // Every event time placed by its own period on a period read of its event, by church-local date. Times that started
  // inside the window by the evaluation time are what's counted; every time of a date says when that date is over.
  const started: Placed[] = [];
  const placed: Placed[] = [];
  const lastStart = new Map<string, number>();
  let windowDays = 8, periodsOk = true;
  for (const event of readEvents.filter(e => inScope(e.event_id))) {
    const own = periodReads.filter(r => r.checkins_event_id === event.event_id);
    const state = stateOf(own);
    if (state !== "ok") { periodsOk = false; not_checked.push(`Check-Ins times for ${event.name ?? "an event"}: ${REASON[state]}.`); }
    for (const read of own.filter(answered)) {
      used.push(read);
      const from = instant(read.window?.starts_at), until = instant(read.window?.ends_at);
      if (!from || !until) continue;
      windowDays = Math.round((ms(until) - ms(from)) / DAY_MS);
      const periods = new Set(asRows(read.body!.data).filter(p => rowId(p, "EventPeriod") && link(p, "event", "Event") === event.event_id).map(p => p.id as string));
      for (const t of asRows(read.body!.included)) {
        const id = rowId(t, "EventTime"), at = instant(attr(t, "starts_at")), period = link(t, "event_period", "EventPeriod"), owner = link(t, "event", "Event");
        if (!id || !at || !isId(period) || !periods.has(period) || (owner !== undefined && owner !== event.event_id)) continue;
        const date = localDate(at, zone);
        lastStart.set(date, Math.max(lastStart.get(date) ?? 0, ms(at)));
        if (placed.some(c => c.event_time_id === id)) continue;
        placed.push({ event_id: event.event_id, event_time_id: id, starts_at: at, date });
        if (ms(at) < ms(from) || ms(at) >= ms(until) || ms(at) > ms(readAt)) continue;
        started.push({ event_id: event.event_id, event_time_id: id, starts_at: at, date });
      }
    }
  }
  const overBy = (date: string, at: string) => (lastStart.get(date) ?? Infinity) + TIME_OVER_MS <= ms(at);
  const finished = (date: string) => overBy(date, readAt);
  const sundays = unique(started.map(c => c.date).filter(isSunday)).sort();
  const sunday = sundays.filter(finished).at(-1) ?? null;
  const live = sundays.filter(d => !finished(d) && (sunday === null || d > sunday)).at(-1) ?? null;
  const onWords = (date: string) => capture.kind === "live" && date === localDate(now, zone) ? "today" : `on ${dayWords(date)}`;

  const timesOf = (date: string, lines: boolean): CheckInsTime[] => {
    const onDate = started.filter(c => c.date === date).sort((a, b) => ms(a.starts_at) - ms(b.starts_at) || (a.event_id < b.event_id ? -1 : 1));
    const several = new Set(onDate.map(c => c.event_id)).size > 1;
    return onDate.map(c => {
      const own = countReads.filter(r => r.checkins_event_time_id === c.event_time_id);
      const state = stateOf(own);
      const clock = clockIn(c.starts_at, zone);
      if (lines && state !== "ok") not_checked.push(`Check-Ins room counts at ${clock}${several ? ` (${eventName(c.event_id) ?? "an event"})` : ""}: ${REASON[state]}.`);
      used.push(...own.filter(answered));
      const roomCounts: RoomCount[] = [];
      for (const row of bodyRows(own.filter(answered))) {
        const location = link(row, "location", "Location");
        const regular = count(attr(row, "regular_count")), guest = count(attr(row, "guest_count")), volunteer = count(attr(row, "volunteer_count"));
        if (!rowId(row, "LocationEventTime") || !isId(location) || regular === null || guest === null || volunteer === null ||
          roomCounts.some(r => r.location_id === location)) continue;
        const name = labelOf(capture, "checkins_location", location);
        roomCounts.push({ location_id: location, name, regular, guest, volunteer,
          line: `${name ?? "A room"}: ${regular + guest} checked in (${regular} regular, ${guest} ${guest === 1 ? "guest" : "guests"}) and ${plural(volunteer, "volunteer")}` });
      }
      return { event_id: c.event_id, event: eventName(c.event_id), event_time_id: c.event_time_id, starts_at: c.starts_at, clock, rooms: roomCounts,
        complete: state === "ok", checked_at: earliest(own) };
    });
  };
  const as_of = clockIn(readAt, zone);
  const so_far = live ? { sunday: live, sunday_words: dayWords(live), on: onWords(live), times: timesOf(live, false), as_of, over: overBy(live, now) } : null;
  // Times of that Sunday that hadn't started when Check-Ins was read are named, never silently left out.
  for (const c of live ? placed.filter(p => p.date === live && ms(p.starts_at) > ms(readAt)).sort((a, b) => ms(a.starts_at) - ms(b.starts_at)) : []) {
    not_checked.push(`The ${clockIn(c.starts_at, zone)} Check-Ins time on ${dayWords(live!)} hadn't started when Ozzie read Check-Ins at ${as_of}, so it wasn't read.`);
  }
  if (!sunday) {
    const one = pickedRead ? picked : readChoice;
    const whose = one !== null ? ` for ${eventName(one) ?? "the event read"}` : "";
    // "None" is said only from a complete read of the events the facts are about; a Sunday under way isn't none.
    if (!cut && eventState === "ok" && periodsOk && !live) not_checked.push(`Check-Ins shows no check-in times on a Sunday in the ${windowDays} days before this check${whose}.`);
    // Each matched room is named, so nothing reads as compared that wasn't.
    if (!live) {
      for (const m of listed) {
        const room = rooms.find(r => r.location_id === m.location_id)!, words = teamWords(teams.find(t => t.team_id === m.team_id));
        not_checked.push(inScope(room.event_id)
          ? `${room.name ?? "A room"} (matched to ${words}) wasn't compared: its event has no Sunday check-in time in this check.`
          : `${room.name ?? "A room"} (matched to ${words}) is in another Check-Ins event than the one you chose, so it wasn't compared.`);
      }
    }
    return none(not_checked, so_far);
  }
  const times = timesOf(sunday, true);
  const sunday_words = dayWords(sunday), on = onWords(sunday);

  const below: RoomRuleFact[] = [];
  const matchStates = new Map<string, MatchState["state"]>();
  for (const m of matches) {
    const room = rooms.find(r => r.location_id === m.location_id)!, team = teams.find(x => x.team_id === m.team_id)!;
    const own = times.filter(t => t.event_id === room.event_id);
    const name = room.name ?? "This room", words = teamWords(team);
    let state: MatchState["state"] = own.length ? "met" : "not-compared";
    if (m.matched === "chosen" && !own.length) {
      not_checked.push(inScope(room.event_id) ? `${name} (matched to ${words}) has no Check-Ins time ${on}, so it wasn't compared.`
        : `${name} (matched to ${words}) is in another Check-Ins event than the one you chose, so it wasn't compared.`);
    }
    for (const t of own) {
      const row = t.rooms.find(r => r.location_id === m.location_id);
      // A room missing from a partly read count is unknown, never zero.
      if (!row && !t.complete) {
        state = "not-compared";
        if (m.matched === "chosen") not_checked.push(`${name} (matched to ${words}) wasn't compared at ${t.clock}: its count wasn't read in full.`);
        continue;
      }
      const volunteers = row ? row.volunteer : null;
      if (volunteers !== null && volunteers >= team.min_confirmed) continue;
      if (state !== "not-compared") state = "below";
      below.push({
        id: `checkins:${m.location_id}:${t.event_time_id}`, key: JSON.stringify([CHECK_INS_KIND, m.location_id, t.starts_at]), kind: CHECK_INS_KIND,
        tone: "look", matched: m.matched,
        location_id: m.location_id, room: room.name, team_id: team.team_id, team: team.name ?? null, needed: team.min_confirmed, volunteers,
        event_time_id: t.event_time_id, starts_at: t.starts_at, clock: t.clock, sunday, checked_at: t.checked_at ?? capture.completed_at, source: CHECK_INS_SOURCE,
        title: volunteers === null ? `${name} at ${t.clock} ${on}: Check-Ins shows no count`
          : `${name} at ${t.clock} ${on}: ${plural(volunteers, "volunteer")} checked in, fewer than your rule's ${team.min_confirmed}`,
        why: [
          `Your Church rules ask for at least ${team.min_confirmed} confirmed people on ${words} at each service time.`,
          m.matched === "chosen" ? `You matched the Check-Ins room ${name} to that team on Church rules.`
            : `The Check-Ins room ${name} has the same name as that kids team, but you haven't matched them on Church rules.`,
          volunteers === null ? `Planning Center Check-Ins shows no count for ${name} at ${t.clock} on ${sunday_words}.`
            : `Planning Center Check-Ins shows ${plural(volunteers, "volunteer")} checked in to ${name} at ${t.clock} on ${sunday_words}.`,
          "This sets volunteers who checked in to the room beside a rule about confirmed people on the team: someone who served without checking in isn't counted, someone not on the team may be, and Ozzie doesn't check ages.",
          "Check-Ins may lower a room's count when people check out, so a count read after the service can be lower than it was. That's why this is Worth a look.",
          "Ozzie reads only counts from Check-Ins. It never reads who checked in.",
        ],
      });
    }
    if (m.matched === "chosen") matchStates.set(m.location_id, state);
  }
  const kept = applyFeedback(below, checkInsTarget, feedbackOf(rules));
  // A room whose only cards were set aside by the leader is never counted as having met its number.
  for (const h of kept.hidden) {
    if (matchStates.get(h.item.location_id) === "below" && !kept.shown.some(f => f.location_id === h.item.location_id)) matchStates.set(h.item.location_id, "set-aside");
  }
  const matched: MatchState[] = chosen.map(m => stateOfMatch(m, matchStates.get(m.location_id) ?? "not-compared"));
  const held = matched.length > 0 && matched.every(m => m.state === "met");
  return { ...base, sunday, sunday_words, on, times, below: kept.shown, so_far, matched, held,
    ...(kept.hidden.length ? { hidden: kept.hidden.map(h => ({ kind: h.item.kind, key: h.item.key, entry: h.entry })) } : {}),
    not_checked, checked_at: earliest(used) };
}
