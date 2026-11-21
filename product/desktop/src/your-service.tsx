// S5, your service (onboarding spec §2 S5, decisions 1, 12, 18): Ozzie picks the next plan itself and asks "Which service
// should Ozzie watch?" only when the church has two or more services with something planned; then it reads that plan
// with live progress and shows the person's own answer to "Is {Day} covered?". Setup is done there. Every word about the
// day comes from the plan's real day (core service-day.ts), never an assumed Sunday. Native calls go through the
// onboarding bridge; reading is the same check as every other (`read`, App's proactive.checkNow).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { dayWords, longDate, planTimes, type DayWords } from "../../../core/src/service-day.js";
import { planDate } from "../../../core/src/church-time.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { SundayBrief } from "../../../core/src/sunday-brief.js";
import { onboarding, reasonOf, type OnboardingBridge, type PlanOption, type ReadProgress, type ReadStage, type ServiceOption, type ServicePick } from "./onboarding-bridge.js";
import { promise } from "./promises.js";
import { eyeLine, pageRef } from "./day-phrases.js";
import { planFromAddress } from "./planning-center-forms.js";
import type { Settings } from "./sunday-source.js";
import { Icon } from "./icons.js";
import { FIRST_RUN, Sheet, StepHead, useTitleFocus } from "./first-run-screens.js";

// ---- Words -------------------------------------------------------------------------------------------------------

const wall = (sortDate: string) => {
  const m = /T(\d{2}):(\d{2})/u.exec(sortDate);
  if (!m) return null;
  const h = Number(m[1]), mi = m[2]!;
  return `${h % 12 === 0 ? 12 : h % 12}:${mi} ${h < 12 ? "AM" : "PM"}`;
};
/** "9:00 and 11:00 AM", "9:00 AM and 6:00 PM": the plan's service times in the church's zone, else its own wall-clock time. */
export function timesText(plan: Pick<PlanOption, "sort_date" | "times">, zone: string | null): string {
  const shown = zone && plan.times.length
    ? [...new Set([...plan.times].sort().map(t => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone })))]
    : [wall(plan.sort_date)].filter((t): t is string => Boolean(t));
  if (shown.length <= 1) return shown[0] ?? "";
  const suffix = shown[0]!.slice(-2);
  const same = shown.every(t => t.endsWith(suffix));
  const items = same ? shown.map(t => t.slice(0, -3)) : shown;
  const joined = `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return same ? `${joined} ${suffix}` : joined;
}
/** The plan's day and date: "Sunday, November 23" (both dates for a weekend). */
export const planWhen = (plan: Pick<PlanOption, "sort_date" | "times">, zone: string | null) =>
  dayWords(plan, zone).date ?? (planDate(plan.sort_date) ? longDate(planDate(plan.sort_date)!) : "Date not set");
/** "Sunday, November 23 · 9:00 and 11:00 AM": a service row's second line. */
export const planLine = (plan: Pick<PlanOption, "sort_date" | "times">, zone: string | null) => [planWhen(plan, zone), timesText(plan, zone)].filter(Boolean).join(" · ");
const nameOf = (s: Pick<ServiceOption, "name">) => s.name ?? "Your service";

/** S5d: nothing planned yet. App's hourly look (decideService) keeps this promise while no service is chosen (review H2). */
export const NOT_PLANNED = {
  body: "When someone at your church makes the next plan in Planning Center Services, Ozzie finds it by itself. It looks again every hour while it's open. If it's the only service with a plan, Ozzie starts watching it by itself; otherwise it asks you on Today.",
} as const;

/** Services native listed without reading their plans (past the first 20; contract L7). */
export const unreadServices = (pick: ServicePick) => pick.more || pick.services.some(s => s.problem === "not-read");

/** What Ozzie does with the church's services: pick the only one with a plan, ask among several, or wait. */
export type ServiceDecision =
  | { kind: "one"; service: ServiceOption; plan: PlanOption; zone: string | null }
  | { kind: "several" }
  | { kind: "none"; service: ServiceOption | null }
  | { kind: "no-services" };
export function decideService(pick: ServicePick): ServiceDecision {
  const planned = pick.services.filter(s => s.next);
  // Native read only the first 20 services' plans: one of the rest may be the church's main one, so Ozzie asks.
  if (unreadServices(pick)) return { kind: "several" };
  if (planned.length === 1) return { kind: "one", service: planned[0]!, plan: planned[0]!.next!, zone: pick.time_zone };
  if (planned.length > 1) return { kind: "several" };
  return pick.services.length === 0 ? { kind: "no-services" } : { kind: "none", service: pick.services[0] ?? null };
}

export const SERVICE = {
  eyebrow: "Step 3 of 3",
  whichTitle: "Which service should Ozzie watch?",
  findingTitle: "Finding your services in Planning Center",
  whichBody: "Your church has more than one kind of service in Planning Center. Ozzie watches one for now; you can change it any time in Settings.",
  whichHelp: "Not sure? Choose the one most of your volunteers serve at.",
  showAll: (n: number) => `Show all ${n} services`,
  nothingFold: (n: number) => `Services with nothing planned yet (${n})`,
  nothingBody: "Ozzie can watch one of these once it has a plan.",
  notRead: "Ozzie read the first 20 services. If yours isn't listed, choose it in Settings.",
  unreadable: "Couldn't read its plans just now",
  watching: (when: string, times: string, name: string) => `Ozzie is watching ${[when, times, name].filter(Boolean).join(" · ")}`,
  different: "Choose a different one",
  sheetTitle: "Which plan should Ozzie watch?",
  watchThis: "Watch this one",
  notListed: "My plan isn't listed",
  pasteLabel: "Copy the plan's address from Planning Center Services and paste it here.",
  pasteButton: "Watch this plan",
  pasteHelp: "That address doesn't show which plan it is. Open the plan in Planning Center Services and copy the address from your browser.",
  usually: "This can take a minute or two.",
  still: "Still reading. Larger churches take longer; you can wait here or come back later. Ozzie keeps going in the background.",
  goToday: "Go to Today",
  tryAgain: "Try again",
  notNow: "Not now",
  copyRequest: "Copy this request",
  copied: "Copied. Paste it into an email or message to whoever looks after Planning Center.",
  lookAgain: "Look again now",
  nextAi: "Next: choose how Ozzie uses AI",
} as const;

/** Rows 7, 8 and 13, and the read's own failures (S5c), as fixed sentences. */
export const SERVICE_PROBLEM = {
  refused: (church: string) => `You're signed in to Planning Center as part of ${church}, but this account can't see Services, where service plans live. You don't need to be an administrator: ask whoever looks after Planning Center at your church to give you access to Services, then press Try again.`,
  request: () => `Could you give my Planning Center account access to Services, so Ozzie can read our service plans? ${promise("request")}`,
  none: "Planning Center shows no services this account can see. Ask whoever looks after Planning Center at your church to give you access to your services, then press Try again.",
  slow: "Planning Center asked Ozzie to slow down. Wait a minute, then try again.",
  lost: (day: DayWords) => `Ozzie read part of ${day.day} but lost the connection to Planning Center. Nothing is wrong with your Planning Center. Press Try again.`,
  /** The pick couldn't reach Planning Center: nothing was read yet (review M9). */
  unreachable: "Ozzie couldn't reach Planning Center just now, so it couldn't see your services. Check that this Mac is online, then press Try again.",
  busy: "Ozzie is already reading Planning Center. Wait a moment, then press Try again.",
  signIn: "Planning Center no longer accepts Ozzie's sign-in. Connect again, then Ozzie reads your service.",
} as const;
type Problem = { kind: "refused" | "none" | "slow" | "lost" | "busy" | "sign-in" };
const problemOf = (error: unknown): Problem => {
  const r = `${reasonOf(error)} ${JSON.stringify(error) ?? ""}`;
  if (/sign-in-not-renewed|invalid-credentials|missing-credentials|not-connected|invalid-token/u.test(r)) return { kind: "sign-in" };
  if (/rate-limited/u.test(r)) return { kind: "slow" };
  if (/busy/u.test(r)) return { kind: "busy" };
  if (/denied/u.test(r)) return { kind: "refused" };
  return { kind: "lost" };
};

/** The read's progress lines (S5c): from native's stages when they come, else from what the pick already knows. */
export function progressLines(input: { plan: Pick<PlanOption, "sort_date" | "times">; zone: string | null; church: string; events: readonly ReadProgress[]; rules: boolean; finished: boolean }):
  { stage: ReadStage; text: string; done: boolean }[] {
  const { plan, zone, church, events, rules, finished } = input;
  const when = planWhen(plan, zone);
  const seen = new Map<ReadStage, ReadProgress>();
  for (const e of events) { const was = seen.get(e.stage); seen.set(e.stage, { ...e, count: e.count ?? was?.count ?? null, done: e.done || Boolean(was?.done) }); }
  const n = (s: ReadStage) => seen.get(s)?.count ?? null;
  const times = timesText(plan, zone);
  const services = n("plan") ?? (zone && plan.times.length ? plan.times.length : null);
  const planDone = services !== null && times
    ? `Found ${services === 1 ? "1 service" : `${services} services`}: ${times}.`
    : `Read ${when}.`;
  const teams = n("teams"), people = n("people");
  const all: { stage: ReadStage; start: string; done: string }[] = [
    { stage: "plan", start: `Reading ${when} at ${church}…`, done: planDone },
    { stage: "teams", start: teams !== null ? `Reading ${teams} teams and their roles…` : "Reading the teams and their roles…",
      done: teams !== null ? `Read ${teams} teams and their roles.` : "Read the teams and their roles." },
    { stage: "people", start: people !== null ? `Checking who said yes: ${people} people scheduled so far…` : "Checking who said yes…",
      done: people !== null ? `Checked who said yes: ${people} people scheduled.` : "Checked who said yes." },
    { stage: "away", start: "Checking the times people said they'll be away…", done: "Checked the times people said they'll be away." },
    ...(rules ? [{ stage: "rules" as const, start: "Comparing with your Church rules…", done: "Compared with your Church rules." }] : []),
  ];
  // Without native's stages, every line shows from the start, none ticked until the read ends: nothing pretends.
  const live = events.length > 0;
  return all.filter(l => !live || finished || seen.has(l.stage)).map(l => {
    const done = finished || Boolean(seen.get(l.stage)?.done);
    return { stage: l.stage, text: done ? l.done : l.start, done };
  });
}

/** How many are scheduled and how many said yes, from the check's own team_members read (no names). */
export function scheduledCounts(capture: Pick<SundayCapture, "reads">): { scheduled: number; yes: number; waiting: number } {
  const byPerson = new Map<string, string>();
  for (const read of capture.reads) {
    if (read.collection !== "team_members" || read.outcome !== "ok") continue;
    const data = (read.body as { data?: unknown } | null | undefined)?.data;
    for (const row of Array.isArray(data) ? data : []) {
      const r = row as { attributes?: { status?: unknown }; relationships?: { person?: { data?: { id?: unknown } } } };
      const who = r.relationships?.person?.data?.id, status = r.attributes?.status;
      if (typeof who !== "string") continue;
      const s = status === "C" || status === "Confirmed" ? "C" : status === "U" || status === "Unconfirmed" ? "U" : "D";
      const was = byPerson.get(who);
      if (!was || (was !== "C" && s === "C") || (was === "D" && s === "U")) byPerson.set(who, s);
    }
  }
  const yes = [...byPerson.values()].filter(s => s === "C").length, waiting = [...byPerson.values()].filter(s => s === "U").length;
  return { scheduled: yes + waiting, yes, waiting };
}

// ---- The step ----------------------------------------------------------------------------------------------------

export interface ResultView {
  brief: SundayBrief; capture: SundayCapture;
  /** The same counts as Today and the Sunday page (App's `sundayShownCount`). */
  counts: { decisions: number; looks: number };
  /** Up to three decisions as Today names them (today-groups.ts `decisionLines`). */
  lines: readonly { key: string; text: string }[];
  /** The other services watched, when there are any (Planning Center only): what the result says of them (othersLine). */
  others?: readonly OtherResult[];
  /** What needs a decision across every service watched: the one count the sidebar, Today and the Services page show. */
  total?: number;
}

/** Another service watched: its name, its date, and how many things need a decision there (null: not read yet). */
export interface OtherResult { name: string | null; when: string | null; decisions: number | null }

const and = (xs: readonly string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
/**
 * The result is the first service's (signing in again on a Mac that watches several): this says so, and what the other
 * services hold, in the one count the sidebar and Today show (coordinator's live read of 0.5.0). Null with one service.
 */
export function othersLine(others: readonly OtherResult[], first: number, total: number): string | null {
  if (!others.length) return null;
  const of = (o: OtherResult) => `${o.name ?? "another service"}${o.when ? ` on ${o.when}` : ""}`;
  const more = others.filter(o => (o.decisions ?? 0) > 0), clear = others.filter(o => o.decisions === 0), unread = others.filter(o => o.decisions === null);
  const counted = more.map((o, i) => i === 0 && !first ? `${o.decisions} ${o.decisions === 1 ? "thing needs" : "things need"} a decision for ${of(o)}`
    : `${o.decisions}${first ? " more" : ""} for ${of(o)}`);
  return [
    more.length ? `${first ? `And ${and(counted)}` : and(counted)}, so your services have ${total} ${total === 1 ? "thing" : "things"} to decide in all.` : "",
    clear.length ? `Nothing needs a decision for ${and(clear.map(of))}.` : "",
    unread.length ? `Ozzie also watches ${and(unread.map(o => o.name ?? "another service"))}, read with the next check.` : "",
    `You'll see every service on ${pageRef()}.`,
  ].filter(Boolean).join(" ");
}
type Phase =
  | { at: "loading" }
  | { at: "which"; pick: ServicePick }
  | { at: "reading"; service: ServiceOption | null; plan: PlanOption; zone: string | null; started: number }
  | { at: "result"; service: ServiceOption | null; plan: PlanOption; zone: string | null }
  | { at: "none"; service: ServiceOption | null }
  | { at: "problem"; problem: Problem; during: "pick" | "read"; service: ServiceOption | null; plan: PlanOption | null; zone: string | null };

export function YourService({ bridge = onboarding, settings, onSettings, church, read, result, rules, intervalMinutes, aiOffered, banner, onNext, onDeferred, onWatching, nowMs }: {
  bridge?: OnboardingBridge; settings: Settings; onSettings: (s: Settings) => void;
  /** The church's name as Planning Center gave it (or "your church"). */
  church: string;
  /** Reads the watched plan, as every check does. */
  read: () => Promise<SundayCapture>;
  /** The result on screen once the read finished (App builds it from the capture). */
  result: ResultView | null;
  /** Whether the church has Church rules to compare with (adds that progress line). */
  rules: boolean;
  intervalMinutes: number; aiOffered: boolean;
  /** S4's "Connected to {church}" banner, shown at the top until a result is on screen. */
  banner?: ReactNode;
  /** Where to go next: the AI screen, the service's own page, or Today. */
  onNext: (to: "ai" | "sunday" | "today") => void;
  /** "Not now" on the question: Today's Finish card then holds "Choose which service Ozzie watches". */
  onDeferred: () => void;
  /** The plan Ozzie now watches, with its date and times, so every page can name its day before the read ends. */
  onWatching?: ((plan: PlanOption, zone: string | null, service: string | null) => void) | undefined;
  /** This Mac's clock (App ticks it every second). */
  nowMs: number;
}) {
  const [phase, setPhase] = useState<Phase>({ at: "loading" });
  const [events, setEvents] = useState<ReadProgress[]>([]);
  const [sheet, setSheet] = useState(false);
  const [pickNow, setPickNow] = useState(0);
  const [readNow, setReadNow] = useState(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Which services there are, and what Ozzie picks: the watched plan when one is already chosen, else the only service's
  // next plan, else the question.
  useEffect(() => {
    let alive = true;
    setPhase({ at: "loading" });
    bridge.pickService().then(pick => {
      if (!alive) return;
      const s = settingsRef.current;
      const chosen = pick.services.find(x => x.id === s.serviceTypeId && x.next?.id === s.planId);
      if (chosen?.next) { onWatching?.(chosen.next, pick.time_zone, chosen.name); setPhase({ at: "reading", service: chosen, plan: chosen.next, zone: pick.time_zone, started: Date.now() }); return; }
      if (/^\d+$/u.test(s.planId) && /^\d+$/u.test(s.serviceTypeId)) {
        // A plan chosen before (by hand, or a later one): read it as it is.
        const service = pick.services.find(x => x.id === s.serviceTypeId) ?? null;
        setPhase({ at: "reading", service, plan: { id: s.planId, sort_date: service?.next?.id === s.planId ? service.next.sort_date : "", title: null, series_title: null, times: [] }, zone: pick.time_zone, started: Date.now() });
        return;
      }
      const d = decideService(pick);
      if (d.kind === "one") choose(d.service, d.plan, d.zone);
      else if (d.kind === "several") setPhase({ at: "which", pick });
      else if (d.kind === "no-services") setPhase({ at: "problem", problem: { kind: "none" }, during: "pick", service: null, plan: null, zone: pick.time_zone });
      // With several services and nothing planned in any, the title names none of them (review L4).
      else setPhase({ at: "none", service: pick.services.length === 1 ? d.service : null });
    }, error => { if (alive) setPhase({ at: "problem", problem: problemOf(error), during: "pick", service: null, plan: null, zone: null }); });
    return () => { alive = false; };
  }, [bridge, pickNow]);
  // S5d keeps its promise while it is on screen: it looks again every hour by itself (App does the same once it's left).
  useEffect(() => {
    if (phase.at !== "none") return;
    const timer = setInterval(() => setPickNow(n => n + 1), 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [phase.at]);
  // Watching a plan is two ids in Settings, exactly as before; the read starts at once, with no confirm click.
  function choose(service: ServiceOption | null, plan: PlanOption, zone: string | null) {
    onSettings({ ...settingsRef.current, ...(service ? { serviceTypeId: service.id } : {}), planId: plan.id });
    onWatching?.(plan, zone, service?.name ?? null);
    setEvents([]);
    setPhase({ at: "reading", service, plan, zone, started: Date.now() });
  }
  // The read runs once Settings hold the plan (App's checks read Settings through a ref set as it renders).
  const reading = phase.at === "reading" ? phase : null;
  useEffect(() => {
    if (!reading || settings.planId !== reading.plan.id) return;
    let alive = true;
    const stop = bridge.onProgress(p => { if (alive) setEvents(e => [...e, p]); });
    read().then(() => { if (alive) setPhase({ at: "result", service: reading.service, plan: reading.plan, zone: reading.zone }); },
      error => { if (alive) setPhase({ at: "problem", problem: problemOf(error), during: "read", service: reading.service, plan: reading.plan, zone: reading.zone }); })
      .finally(stop);
    return () => { alive = false; stop(); };
  }, [reading?.plan.id, reading?.started, settings.planId, readNow]);

  const zone = "zone" in phase ? phase.zone : null;
  const shownPlan = "plan" in phase ? phase.plan : null;
  // Once read, the plan's real service times come from the check itself.
  const readTimes = result && shownPlan && result.capture.plan_id === shownPlan.id ? planTimes(result.capture.reads) : [];
  const readZone = result && shownPlan && result.capture.plan_id === shownPlan.id ? result.brief.time_zone : null;
  const planForWords = shownPlan ? { sort_date: shownPlan.sort_date || (result?.brief.plan.sort_date ?? ""), times: readTimes.length ? readTimes : shownPlan.times } : null;
  const day = useMemo(() => dayWords(planForWords, readZone ?? zone), [planForWords?.sort_date, planForWords?.times.join(), readZone, zone]);
  const title = useTitleFocus<HTMLHeadingElement>(phase.at);
  const titleRef = title;
  const serviceName = "service" in phase && phase.service ? nameOf(phase.service) : "";

  if (phase.at === "loading") {
    return <section className="fr" aria-labelledby="fr-title">{banner}
      <StepHead step={SERVICE.eyebrow} titleRef={title}>{SERVICE.findingTitle}…</StepHead>
      <p className="fr-note" role="status"><Icon name="spinner" small spin /> Reading the services your church has planned.</p>
    </section>;
  }

  if (phase.at === "which") return <WhichService pick={phase.pick} banner={banner} titleRef={title} onPick={s => choose(s, s.next!, phase.pick.time_zone)}
    onNotNow={() => { onDeferred(); onNext("today"); }} />;

  if (phase.at === "none") {
    const title = serviceName ? `Planning Center has no upcoming ${serviceName} plans yet` : "Planning Center has no upcoming plans yet";
    return <section className="fr" aria-labelledby="fr-title">{banner}
      <StepHead step={SERVICE.eyebrow} titleRef={titleRef}>{title}</StepHead>
      <p className="fr-note">{NOT_PLANNED.body}</p>
      <div className="fr-actions">
        <button type="button" className="btn btn-primary fr-primary" onClick={() => setPickNow(n => n + 1)}>{SERVICE.lookAgain}</button>
        <button type="button" className="fr-link" onClick={() => onNext("today")}>{SERVICE.goToday}</button>
      </div>
    </section>;
  }

  if (phase.at === "problem" && phase.during === "pick") {
    return <section className="fr" aria-labelledby="fr-title">{banner}
      <StepHead step={SERVICE.eyebrow} titleRef={title}>{SERVICE.findingTitle}</StepHead>
      <PickProblem stage="pick" problem={phase.problem} church={church} day={day} onTryAgain={() => setPickNow(n => n + 1)} onNotNow={() => onNext("today")} />
    </section>;
  }

  // Reading, its result, or a read that failed: the question with the plan Ozzie is watching under it.
  const plan = shownPlan!;
  const elapsed = reading ? Math.max(0, Math.floor((nowMs - reading.started) / 1000)) : 0;
  const lines = progressLines({ plan: planForWords ?? plan, zone: readZone ?? zone, church, events, rules, finished: phase.at === "result" });
  const shown = phase.at === "result" && result && result.capture.plan_id === plan.id ? result : null;
  return <section className="fr" aria-labelledby="fr-title">
    {!shown && banner}
    <StepHead step={SERVICE.eyebrow} titleRef={title}>{day.question}</StepHead>
    <p className="fr-watching"><span>{SERVICE.watching(planWhen(planForWords ?? plan, readZone ?? zone), timesText(planForWords ?? plan, readZone ?? zone), serviceName)}</span>
      {phase.at !== "reading" && <button type="button" className="fr-link" onClick={() => setSheet(true)}>{SERVICE.different}</button>}</p>
    {!shown && <>
      <ul className="fr-progress" aria-live="polite">{lines.map(l => <li key={l.stage} className={l.done ? "is-done" : "is-waiting"}>
        <Icon name={l.done ? "check" : "dot"} small /><span>{l.text}</span></li>)}</ul>
      {phase.at === "reading" && <p className="fr-small" aria-live="polite"><Icon name="spinner" small spin /> {elapsed >= 90 ? SERVICE.still : SERVICE.usually}{events.length === 0 && elapsed >= 5 ? ` ${elapsed} seconds so far.` : ""}</p>}
      {phase.at === "reading" && elapsed >= 90 && <div className="fr-actions"><button type="button" className="fr-link" onClick={() => onNext("today")}>{SERVICE.goToday}</button></div>}
    </>}
    {phase.at === "problem" && <ReadProblem problem={phase.problem} church={church} day={day}
      onTryAgain={() => { setEvents([]); setPhase({ at: "reading", service: phase.service, plan, zone: phase.zone, started: Date.now() }); setReadNow(n => n + 1); }}
      onToday={() => onNext("today")} />}
    {phase.at === "result" && !shown && <p className="fr-note" role="status"><Icon name="spinner" small spin /> Putting the answer together…</p>}
    {shown && <Result view={shown} day={day} serviceName={serviceName} intervalMinutes={intervalMinutes} aiOffered={aiOffered} onNext={onNext} />}
    {sheet && <ChooseDifferent bridge={bridge} current={{ service: "service" in phase ? phase.service : null, plan }} zone={readZone ?? zone}
      onClose={() => setSheet(false)} onChoose={(service, next) => { setSheet(false); choose(service, next, zone); }}
      onAddress={(found) => { setSheet(false); onSettings({ ...settingsRef.current, ...found }); setEvents([]);
        setPhase({ at: "reading", service: null, plan: { id: found.planId, sort_date: "", title: null, series_title: null, times: [] }, zone, started: Date.now() }); }} />}
  </section>;
}

function WhichService({ pick, banner, titleRef, onPick, onNotNow }: {
  pick: ServicePick; banner?: ReactNode; titleRef: React.RefObject<HTMLHeadingElement | null>; onPick: (s: ServiceOption) => void; onNotNow: () => void;
}) {
  const [all, setAll] = useState(false);
  const planned = pick.services.filter(s => s.next || (s.problem && s.problem !== "not-read"));
  const nothing = pick.services.filter(s => !s.next && !s.problem);
  const shown = all ? planned : planned.slice(0, 8);
  return <section className="fr" aria-labelledby="fr-title">{banner}
    <StepHead step={SERVICE.eyebrow} titleRef={titleRef}>{SERVICE.whichTitle}</StepHead>
    <p className="fr-note">{SERVICE.whichBody}</p>
    <ul className="fr-services">{shown.map(s => <li key={s.id}>
      <button type="button" className="fr-service" disabled={!s.next} onClick={() => onPick(s)}>
        <span className="fr-service-t">{nameOf(s)}</span>
        <span className="fr-service-d">{s.next ? planLine(s.next, pick.time_zone) : SERVICE.unreadable}</span>
      </button></li>)}</ul>
    {!all && planned.length > 8 && <div><button type="button" className="fr-link" onClick={() => setAll(true)}>{SERVICE.showAll(planned.length)}</button></div>}
    <p className="fr-small">{SERVICE.whichHelp}</p>
    {unreadServices(pick) && <p className="fr-small">{SERVICE.notRead}</p>}
    {nothing.length > 0 && <details className="fr-fold"><summary><Icon name="chev" small />{SERVICE.nothingFold(nothing.length)}</summary>
      <p>{nothing.map(nameOf).join(", ")}</p><p>{SERVICE.nothingBody}</p></details>}
    <div className="fr-actions"><button type="button" className="fr-link" onClick={onNotNow}>{SERVICE.notNow}</button></div>
  </section>;
}

function PickProblem({ problem, church, day, onTryAgain, onNotNow, stage = "read" }: {
  problem: Problem; church: string; day: DayWords; onTryAgain: () => void; onNotNow: () => void; stage?: "pick" | "read";
}) {
  const [copied, setCopied] = useState(false);
  const text = problem.kind === "refused" ? SERVICE_PROBLEM.refused(church) : problem.kind === "none" ? SERVICE_PROBLEM.none : problem.kind === "slow" ? SERVICE_PROBLEM.slow
    : problem.kind === "busy" ? SERVICE_PROBLEM.busy : problem.kind === "sign-in" ? SERVICE_PROBLEM.signIn
    : stage === "pick" ? SERVICE_PROBLEM.unreachable : SERVICE_PROBLEM.lost(day);
  return <div className="fr-failure" role="alert">
    <p>{text}</p>
    <div className="fr-row">
      <button type="button" className="btn btn-primary" onClick={onTryAgain}>{SERVICE.tryAgain}</button>
      {problem.kind === "refused" && <button type="button" className="btn btn-secondary" onClick={() => {
        void navigator.clipboard?.writeText(SERVICE_PROBLEM.request()).then(() => setCopied(true), () => undefined);
      }}>{SERVICE.copyRequest}</button>}
      {problem.kind !== "slow" && problem.kind !== "busy" && <button type="button" className="fr-link" onClick={onNotNow}>{SERVICE.notNow}</button>}
    </div>
    {copied && <p className="fr-small" role="status">{SERVICE.copied}</p>}
  </div>;
}

function ReadProblem({ problem, church, day, onTryAgain, onToday }: { problem: Problem; church: string; day: DayWords; onTryAgain: () => void; onToday: () => void }) {
  return <PickProblem problem={problem.kind === "none" ? { kind: "lost" } : problem} church={church} day={day} onTryAgain={onTryAgain} onNotNow={onToday} />;
}

const hours = (minutes: number) => minutes === 60 ? "every hour" : minutes % 60 === 0 ? `every ${minutes / 60} hours` : `every ${minutes} minutes`;
function Result({ view, day, serviceName, intervalMinutes, aiOffered, onNext }: {
  view: ResultView; day: DayWords; serviceName: string; intervalMinutes: number; aiOffered: boolean; onNext: (to: "ai" | "sunday" | "today") => void;
}) {
  const { brief, counts, lines } = view;
  const when = day.date ?? day.day;
  const checked = brief.checked_at ? new Date(brief.checked_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;
  const source = `Planning Center Services${checked ? ` · checked ${checked}` : ""}`;
  const people = scheduledCounts(view.capture);
  const partial = brief.sources.failed.length > 0;
  const next = aiOffered ? `Open ${day.page}` : SERVICE.nextAi;
  return <div className="fr-result" aria-live="polite">
    {counts.decisions > 0
      ? <>
        <p className="fr-answer">{counts.decisions === 1 ? "1 thing needs a decision" : `${counts.decisions} things need a decision`} for {when}.</p>
        <ul className="fr-decisions">{lines.slice(0, 3).map(l => <li key={l.key}><span>{l.text}</span><span className="fr-small">{source}</span></li>)}</ul>
        {counts.decisions > 3 && <p className="fr-note">And {counts.decisions - 3} more.</p>}
      </>
      : <>
        <p className="fr-answer">{people.scheduled === 0 ? `Nobody is scheduled for ${when} yet in Planning Center.` : `Everything Ozzie checks is covered for ${when}.`}</p>
        {people.scheduled > 0 && <p className="fr-note">{people.scheduled === 1 ? "1 person" : `${people.scheduled} people`} scheduled. {people.yes} said yes{people.waiting ? `, ${people.waiting} ${people.waiting === 1 ? "hasn't" : "haven't"} answered yet` : ""}.</p>}
        <p className="fr-small">{source}</p>
      </>}
    {view.others?.length ? <p className="fr-note">{othersLine(view.others, counts.decisions, view.total ?? counts.decisions)}</p> : null}
    {counts.looks > 0 && <p className="fr-note">Also {counts.looks === 1 ? "1 thing" : `${counts.looks} things`} worth a look. You'll see {counts.looks === 1 ? "it" : "them"} on {pageRef()}.</p>}
    {partial && <p className="fr-note">Part of {day.day} couldn't be checked, so this isn't a full picture.</p>}
    <p className="fr-note">{eyeLine()} at least {hours(intervalMinutes)} while it's open, and moves on to the next {serviceName || "service"} plan by itself after this one.</p>
    <div className="fr-actions"><button type="button" className="btn btn-primary fr-primary" onClick={() => onNext(aiOffered ? "sunday" : "ai")}>{next}</button></div>
  </div>;
}

/** "Choose a different one": the services when there are several, then the chosen service's next plans, then a pasted address. */
function ChooseDifferent({ bridge, current, zone, onClose, onChoose, onAddress }: {
  bridge: OnboardingBridge; current: { service: ServiceOption | null; plan: PlanOption }; zone: string | null;
  onClose: () => void; onChoose: (service: ServiceOption | null, plan: PlanOption) => void; onAddress: (found: { serviceTypeId: string; planId: string }) => void;
}) {
  const [pick, setPick] = useState<ServicePick | null>(null);
  const [service, setService] = useState<ServiceOption | null>(current.service);
  const [plans, setPlans] = useState<PlanOption[] | null>(null);
  const [address, setAddress] = useState("");
  useEffect(() => { void bridge.pickService().then(setPick, () => setPick({ services: [], time_zone: zone, more: false })); }, [bridge]);
  useEffect(() => {
    if (!service) { setPlans([]); return; }
    let alive = true;
    setPlans(null);
    void bridge.upcomingPlans(service.id).then(p => { if (alive) setPlans(p.slice(0, 12)); }, () => { if (alive) setPlans([]); });
    return () => { alive = false; };
  }, [service?.id]);
  const several = (pick?.services.filter(s => s.next).length ?? 0) > 1;
  const found = planFromAddress(address);
  const pz = pick?.time_zone ?? zone;
  return <Sheet title={SERVICE.sheetTitle} onClose={onClose} labelId="fr-different-title">
    {several && <ul className="fr-services">{pick!.services.filter(s => s.next).map(s => <li key={s.id}>
      <button type="button" className="fr-service" aria-pressed={service?.id === s.id} onClick={() => setService(s)}>
        <span className="fr-service-t">{nameOf(s)}</span><span className="fr-service-d">{planLine(s.next!, pz)}</span></button></li>)}</ul>}
    {plans === null ? <p className="fr-note" role="status"><Icon name="spinner" small spin /> Reading the next plans…</p>
      : <ul className="fr-plans">{plans.map(p => <li key={p.id}>
        <span>{[planWhen(p, pz), timesText(p, pz), p.title].filter(Boolean).join(" · ")}</span>
        <button type="button" className="btn btn-secondary" disabled={p.id === current.plan.id} onClick={() => onChoose(service, p)}>{SERVICE.watchThis}</button>
      </li>)}</ul>}
    <details className="fr-fold"><summary><Icon name="chev" small />{SERVICE.notListed}</summary>
      <div className="field">
        <label htmlFor="fr-plan-address">{SERVICE.pasteLabel}</label>
        <input id="fr-plan-address" className="input" value={address} autoComplete="off" spellCheck={false} placeholder="https://services.planningcenteronline.com/…"
          onChange={e => setAddress(e.target.value)} />
        {address && !(found.serviceTypeId && found.planId) && <p className="input-help" role="status">{SERVICE.pasteHelp}</p>}
      </div>
      <div className="fr-actions"><button type="button" className="btn btn-secondary" disabled={!(found.serviceTypeId && found.planId)}
        onClick={() => onAddress({ serviceTypeId: found.serviceTypeId!, planId: found.planId! })}>{SERVICE.pasteButton}</button></div>
    </details>
    <div className="fr-actions"><button type="button" className="fr-link" onClick={onClose}>{FIRST_RUN.back}</button></div>
  </Sheet>;
}
