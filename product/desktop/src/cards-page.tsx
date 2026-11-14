// "Read visitor cards": a temporary, foreground-only review on this Mac.
// Card photos, recognized text and typed fields live only in the CardReview lifecycle and in memory
// for as long as this page is open and in front. Nothing is saved (no storage, files, recordings or
// logs), nothing goes to an AI model, and nothing is added to Planning Center. Leaving the page,
// switching away or closing the window discards everything; photos are revoked object URLs.
import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { fields, type CardView, type FieldName, type Reading } from "../../../core/src/card-review/lifecycle.js";
import { possibleMatches, reviewedList, sameNameCards, suggestFields } from "../../../core/src/card-fields.js";
import { CardReviewController } from "../../src/card-review/controller.js";
import { bindForeground, browserImages } from "../../src/card-review/browser.js";
import { Icon } from "./icons.js";

export type CardTextResult = { status: "read"; text: string } | { status: "not-available" };
/** Native, on this Mac: the photo's bytes go to the local recognizer on a pipe and its text comes back. Never to an AI model. */
export const cardReader = {
  read: (image: Uint8Array) => invoke<CardTextResult>("read_card_text", image),
  /** The review closed: stop any card still being read; its text is thrown away natively. */
  cancel: () => invoke<void>("cancel_card_reading"),
};

export type ReadState = "waiting" | "reading" | "read" | "by-hand" | "failed";
export type Recognizer = "unknown" | "available" | "not-available";
export interface CardsUi {
  reading: Readonly<Record<number, ReadState>>;
  suggested: Readonly<Record<number, readonly FieldName[]>>;
  recognizer: Recognizer;
  ended: "copied" | "discarded" | null;
  copied: number;
  copyProblem: boolean;
}
export const emptyUi: CardsUi = { reading: {}, suggested: {}, recognizer: "unknown", ended: null, copied: 0, copyProblem: false };

const LABEL: Record<FieldName, string> = { name: "Name", phone: "Phone", email: "Email", request: "Request — their exact words" };
const LIMIT: Record<FieldName, number> = { name: 256, phone: 256, email: 256, request: 2000 };
/** The person's two choices per field: what the card says, and whether it's hard to read. */
export const readingFor = (text: string, hard: boolean): Reading => hard ? "unclear" : text ? "typed" : "blank";

/** A fresh picker per choice, as in the shared card review; the chosen files are handed to `onFiles` once. */
function pickCards(controller: CardReviewController, doc: Document, onFiles: (ticket: number, files: File[]) => void): number | null {
  const input = doc.createElement("input");
  input.type = "file"; input.multiple = true; input.accept = "image/png,image/jpeg"; input.hidden = true;
  const reset = () => { input.value = ""; input.onchange = null; input.oncancel = null; input.remove(); };
  const ticket = controller.choose(reset);
  if (ticket === null) return null;
  input.onchange = () => onFiles(ticket, Array.from(input.files ?? []));
  input.oncancel = () => { controller.discard(ticket); };
  doc.body.append(input);
  try { input.click(); } catch { controller.discard(ticket); }
  return ticket;
}
/** The Mac's file panel briefly takes focus; wait for the window to come back before the review starts. */
const focused = (win: Window, doc: Document, ms = 1500) => new Promise<void>(resolve => {
  if (doc.hasFocus()) { resolve(); return; }
  const done = () => { win.removeEventListener("focus", done); clearTimeout(timer); resolve(); };
  const timer = setTimeout(done, ms);
  win.addEventListener("focus", done);
});

/**
 * Reads each card on this Mac, one at a time, and fills only what was read cleanly or flags what wasn't.
 * Results for a review that has closed (or a card that was removed) are dropped.
 */
export async function readCardsLocally({ controller, ticket, files, read, live, onState, onSuggested, onRecognizer }: {
  controller: CardReviewController; ticket: number; files: (File | null)[];
  read: (image: Uint8Array) => Promise<CardTextResult>; live: () => boolean;
  onState: (id: number, state: ReadState) => void; onSuggested: (id: number, fields: FieldName[]) => void;
  onRecognizer: (r: Recognizer) => void;
}): Promise<void> {
  for (let index = 0; index < files.length; index++) {
    const id = index + 1;
    const file = files[index] ?? null;
    files[index] = null;
    if (!live()) { files.fill(null); return; }
    if (!file || !controller.source(ticket, id)) continue;
    onState(id, "reading");
    let text: string | null = null;
    let unavailable = false;
    try {
      const result = await read(new Uint8Array(await file.arrayBuffer()));
      if (result.status === "not-available") unavailable = true; else text = typeof result.text === "string" ? result.text : null;
    } catch { text = null; }
    if (!live()) { files.fill(null); return; }
    if (unavailable) {
      onRecognizer("not-available");
      for (let rest = id; rest <= files.length; rest++) onState(rest, "by-hand");
      files.fill(null);
      return;
    }
    if (text === null) { onState(id, "failed"); continue; }
    onRecognizer("available");
    const suggestions = suggestFields(text);
    text = null;
    const filled: FieldName[] = [];
    for (const field of fields) {
      const s = suggestions[field];
      if (!s.text && !s.unclear) continue;
      if (controller.edit(ticket, { card: id, field, text: s.text, state: s.unclear ? "unclear" : "typed" }) === "ok") filled.push(field);
    }
    onSuggested(id, filled);
    onState(id, "read");
  }
}

/** The person confirms the whole card: fields nobody filled are blank on the card; unclear ones stay marked. */
export function checkCard(controller: CardReviewController, ticket: number, card: CardView) {
  for (const field of fields) {
    if (card.fields[field].state === "unreviewed") controller.edit(ticket, { card: card.id, field, text: "", state: "blank" });
  }
  const unclear = fields.some(field => card.fields[field].state === "unclear" || card.fields[field].state === "not-readable");
  return controller.review(ticket, { card: card.id, acknowledge: unclear });
}

/** The plain list, built from the review at the moment of copying. */
export function listFor(controller: CardReviewController): { text: string; count: number } {
  let text = "", count = 0;
  controller.render(view => {
    count = view.cards.length;
    text = reviewedList(view.cards.map(card => ({
      label: card.label,
      fields: Object.fromEntries(fields.map(f => [f, { text: card.fields[f].text, state: card.fields[f].state }])) as Record<FieldName, { text: string; state: Reading }>,
    })));
  });
  return { text, count };
}

async function writeClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  try {
    const area = document.createElement("textarea");
    area.value = text; area.readOnly = true; area.style.position = "fixed"; area.style.opacity = "0";
    document.body.append(area); area.select();
    const ok = document.execCommand("copy");
    area.value = ""; area.remove();
    return ok;
  } catch { return false; }
}

const joined = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** What to look at first: possible matches with people already in this Sunday's check, repeated names, and unclear readings. */
export function lookFirst(cards: readonly CardView[], people: Readonly<Record<string, string>>): { card: number; text: string }[] {
  const out: { card: number; text: string }[] = [];
  for (const card of cards) {
    const name = card.fields.name.text.trim();
    const matches = name ? possibleMatches(name, people).map(id => people[id]!) : [];
    if (matches.length) out.push({ card: card.id, text: `${card.label}: “${name}” may already be in this Sunday's check as ${joined([...new Set(matches)])}. Ozzie won't combine them. Check Planning Center before adding anyone.` });
  }
  for (const group of sameNameCards(cards.map(c => ({ id: c.id, name: c.fields.name.text })))) {
    out.push({ card: group[0]!, text: `Cards ${joined(group.map(String))} have the same name. They may be the same person.` });
  }
  for (const card of cards) {
    const hard = fields.filter(f => card.fields[f].state === "unclear" || card.fields[f].state === "not-readable");
    if (hard.length) out.push({ card: card.id, text: `${card.label}: the ${joined(hard.map(f => f === "request" ? "request" : f))} ${hard.length === 1 ? "is" : "are"} hard to read. Worth a look against the photo.` });
  }
  return out;
}

export function CardsPage({ people, workspace }: { people: Readonly<Record<string, string>>; workspace: string }) {
  return <CardsHost key={workspace} people={people} workspace={workspace} />;
}

function CardsHost({ people, workspace }: { people: Readonly<Record<string, string>>; workspace: string }) {
  const [controller, setController] = useState<CardReviewController | null>(null);
  const [, redraw] = useState(0);
  const [ticket, setTicket] = useState<number | null>(null);
  const [ui, setUi] = useState<CardsUi>(emptyUi);
  const files = useRef<(File | null)[]>([]);
  const current = useRef<number | null>(null);
  const recognizer = useRef<Recognizer>("unknown");
  useLayoutEffect(() => {
    const review = new CardReviewController(workspace, browserImages());
    let open = false;
    const stopReading = () => { void cardReader.cancel().catch(() => undefined); };
    const unsubscribe = review.subscribe(() => {
      const now = ["choosing", "loading", "active"].includes(review.status);
      // Closing (finish, discard, interruption) lets go of the files and stops any reading in progress.
      if (!now) files.current.fill(null);
      if (open && !now) stopReading();
      open = now;
      flushSync(() => redraw(v => v + 1));
    });
    const unbind = bindForeground(review, window, document);
    setController(review);
    return () => { files.current.fill(null); files.current = []; current.current = null; unsubscribe(); unbind(); stopReading(); };
  }, [workspace]);
  if (!controller) return <div className="col"><p role="status">Preparing a temporary review.</p></div>;

  const begin = async (t: number, chosen: File[]) => {
    await focused(window, document);
    files.current = [...chosen];
    chosen.length = 0;
    const result = await controller.select(t, [...files.current] as File[]);
    if (result !== "ok" || current.current !== t) { files.current.fill(null); return; }
    const byHand = recognizer.current === "not-available";
    setUi(u => ({ ...u, reading: Object.fromEntries(files.current.map((_, i) => [i + 1, byHand ? "by-hand" : "waiting"])) }));
    if (byHand) { files.current.fill(null); return; }
    await readCardsLocally({
      controller, ticket: t, files: files.current, read: cardReader.read,
      live: () => current.current === t && controller.status === "active",
      onState: (id, state) => setUi(u => ({ ...u, reading: { ...u.reading, [id]: state } })),
      onSuggested: (id, list) => setUi(u => ({ ...u, suggested: { ...u.suggested, [id]: list } })),
      onRecognizer: r => { recognizer.current = r; setUi(u => ({ ...u, recognizer: r })); },
    });
  };
  const start = () => {
    setUi(u => ({ ...emptyUi, recognizer: u.recognizer }));
    const t = pickCards(controller, document, (t, chosen) => { void begin(t, chosen); });
    current.current = t;
    setTicket(t);
  };
  const copy = async () => {
    if (ticket === null) return;
    const { text, count } = listFor(controller);
    const ok = text ? await writeClipboard(text) : false;
    if (!ok) { setUi(u => ({ ...u, copyProblem: true })); return; }
    // The list is on the clipboard either way; if the review closed meanwhile, still say it was copied.
    if (controller.finish(ticket) !== "finished") controller.discard();
    setUi(u => ({ ...u, ended: "copied", copied: count, copyProblem: false }));
  };
  return <CardsReview controller={controller} ticket={ticket} ui={ui} people={people} onChoose={start}
    onCopy={() => { void copy(); }}
    onDiscard={() => { if (ticket !== null) controller.discard(ticket); setUi(u => ({ ...u, ended: "discarded" })); }}
    onEdited={(id, field) => setUi(u => ({ ...u, suggested: { ...u.suggested, [id]: (u.suggested[id] ?? []).filter(f => f !== field) } }))} />;
}

/** The page body. Rendered by the host above and by the tests with a controller on fixed fictional data. */
export function CardsReview({ controller, ticket, ui, people, onChoose, onCopy, onDiscard, onEdited }: {
  controller: CardReviewController; ticket: number | null; ui: CardsUi; people: Readonly<Record<string, string>>;
  onChoose: () => void; onCopy: () => void; onDiscard: () => void; onEdited: (card: number, field: FieldName) => void;
}) {
  let cards: CardView[] = [];
  controller.render(view => { cards = [...view.cards]; });
  const status = controller.status;
  const open = status === "choosing" || status === "loading" || status === "active";
  const active = status === "active" && ticket !== null;
  const reading = Object.values(ui.reading).filter(s => s === "waiting" || s === "reading").length;
  const total = Object.keys(ui.reading).length;
  const allChecked = cards.length > 0 && cards.every(c => c.reviewed);
  const first = active ? lookFirst(cards, people) : [];
  return <div className="col cards">
    <p className="eyebrow">Visitor cards</p>
    <h1 className="h1">Read visitor cards</h1>
    <p className="lede">Choose photos of several cards at once. Each card stays beside its photo while you check it, then you copy the list or discard it.</p>
    <div className="limits" id="cards-limits">
      <p className="limits-t"><Icon name="lock" small />A temporary review on this Mac</p>
      <p>Switching to another app, leaving this page or closing Ozzie discards these cards right away. Keep your original photos. Nothing here is saved in Ozzie, sent to an AI model or added to Planning Center.</p>
    </div>
    {ui.recognizer === "not-available"
      ? <p className="panel-info"><Icon name="info" small />This Mac can't read card text, so please type each card.</p>
      : <p className="small">If this Mac can read the card text, I'll fill in what I can read clearly and mark what I can't. Every field still needs a person to check it.</p>}

    {!open && <div className="row">
      <button type="button" className="btn btn-primary" aria-describedby="cards-limits" onClick={onChoose}>Choose card photos</button>
      <span className="small">PNG or JPEG · up to 8 at a time · 8 MB each</span>
    </div>}
    <p className="small" role="status" aria-live="polite">{status === "choosing" ? "Choose the card photos in the window that opened."
      : status === "loading" ? "Opening the photos on this Mac…"
        : active && reading > 0 ? `Reading card ${Math.min(total - reading + 1, total)} of ${total} on this Mac…`
          : active ? `${cards.length} ${cards.length === 1 ? "card" : "cards"} open for checking.` : ""}</p>
    {status === "error" && <p role="alert" className="problem">Those photos couldn't be opened. Choose PNG or JPEG photos: up to 8 at a time, 8 MB each.</p>}
    {ui.ended === "copied" && !open && <div className="panel-ok" role="status"><Icon name="check" />
      <p>Copied {ui.copied === 1 ? "1 card" : `${ui.copied} cards`}. Paste the list where your church keeps visitor records. This review is closed and nothing from it was kept in Ozzie. The list is on this Mac's clipboard until you copy something else; if you use Universal Clipboard or a clipboard history app, it may be there too.</p></div>}
    {status === "closed" && ui.ended !== "copied" && (ui.ended === "discarded" || total > 0) && <p className="panel-sunken">{ui.ended === "discarded" ? "Discarded. Nothing from these cards was kept." : "This review is closed and nothing from it was kept. Switching away from Ozzie or leaving this page closes it."} Choose the photos again to start over.</p>}

    {active && first.length > 0 && <section className="panel-info cards-first" aria-labelledby="first-title">
      <Icon name="eye" />
      <div className="stack-tight">
        <h2 id="first-title" className="bold">Look at these first</h2>
        <ul className="list">{first.map((f, i) => <li key={i}><Icon name="dot" small /><a href={`#card-${f.card}`}>{f.text}</a></li>)}</ul>
      </div>
    </section>}

    {active && cards.map(card => <CardItem key={`${ticket}-${card.id}`} card={card} controller={controller} ticket={ticket!}
      state={ui.reading[card.id] ?? "by-hand"} suggested={ui.suggested[card.id] ?? []} people={people} onEdited={onEdited} />)}

    {open && <footer className="cards-end">
      {active && <button type="button" className="btn btn-primary" disabled={!allChecked || reading > 0} onClick={onCopy}>Copy the reviewed list</button>}
      <button type="button" className="btn btn-secondary" onClick={onDiscard}>Discard these cards</button>
      {active && !allChecked && <span className="small">Check every card against its photo before copying.</span>}
      {ui.copyProblem && <p role="alert" className="problem">The list couldn't be copied. Nothing was discarded; try again.</p>}
    </footer>}
  </div>;
}

function CardItem({ card, controller, ticket, state, suggested, people, onEdited }: {
  card: CardView; controller: CardReviewController; ticket: number; state: ReadState; suggested: readonly FieldName[];
  people: Readonly<Record<string, string>>; onEdited: (card: number, field: FieldName) => void;
}) {
  const [large, setLarge] = useState(false);
  const busy = state === "waiting" || state === "reading";
  const name = card.fields.name.text.trim();
  const matches = name ? possibleMatches(name, people).map(id => people[id]!) : [];
  const unclear = fields.some(f => card.fields[f].state === "unclear" || card.fields[f].state === "not-readable");
  const empty = fields.some(f => card.fields[f].state === "unreviewed");
  const edit = (field: FieldName, text: string, hard: boolean) => {
    controller.edit(ticket, { card: card.id, field, text, state: readingFor(text, hard) });
    onEdited(card.id, field);
  };
  const src = controller.source(ticket, card.id);
  return <article className={`cr cards-item${large ? " is-large" : ""}`} id={`card-${card.id}`} aria-labelledby={`card-${card.id}-t`}>
    <div className="cards-photo">
      <div className="cr-img">{src && <img src={src} alt={`${card.label} photo`} onError={() => { controller.discard(ticket); }} />}</div>
      <button type="button" className="btn btn-quiet btn-sm" aria-pressed={large} onClick={() => setLarge(!large)}>{large ? "Smaller photo" : "See the photo larger"}</button>
    </div>
    <div className="cards-fields">
      <div className="find-top">
        <h2 id={`card-${card.id}-t`} className="bold">{card.label}</h2>
        {card.reviewed ? <span className="badge b-ok"><Icon name="check" small />Checked by you</span> : <span className="badge b-muted">Needs a person to check</span>}
        {busy && <span className="small"><Icon name="spinner" small spin /> {state === "reading" ? "Reading on this Mac…" : "Waiting to be read"}</span>}
        {state === "failed" && <span className="small">This card couldn't be read. Please type it.</span>}
      </div>
      {matches.length > 0 && <p className="panel-info"><Icon name="user" small />
        <span>Possible match: {matches.join(", ")} {matches.length === 1 ? "is" : "are"} already in this Sunday's check. Ozzie won't combine them.</span></p>}
      {fields.map(field => {
        const value = card.fields[field];
        const hard = value.state === "unclear" || value.state === "not-readable";
        const id = `card-${card.id}-${field}`;
        const fromMac = suggested.includes(field);
        const note = fromMac && hard && !value.text ? "This Mac couldn't read this clearly. Type what you see on the card."
          : fromMac && hard ? "Some of this didn't read clearly. Compare every word with the photo."
            : fromMac ? "Read by this Mac. Compare it with the photo."
              : hard ? "You marked this hard to read." : field === "request" ? "Keep their exact words. Don't summarize or fix them." : "";
        const props = {
          id, className: "input", value: value.text, maxLength: LIMIT[field], disabled: busy, autoComplete: "off", spellCheck: false,
          "aria-describedby": note ? `${id}-note` : undefined,
          onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => edit(field, e.target.value, hard),
        };
        return <div className="cards-field" key={field}>
          <div className="cards-field-top">
            <label htmlFor={id} className="field-l">{LABEL[field]}</label>
            <span className={`cards-tag${card.reviewed ? " is-ok" : ""}`}>{card.reviewed ? "Checked" : "Needs a person to check"}</span>
            {hard && <span className="badge b-look"><Icon name="eye" small />Worth a look</span>}
          </div>
          {field === "request" ? <textarea {...props} rows={3} /> : <input {...props} />}
          <label className="confirmation small"><input type="checkbox" checked={hard} disabled={busy} onChange={e => edit(field, value.text, e.target.checked)} /><span>Hard to read on the card</span></label>
          {note && <p className="input-help" id={`${id}-note`}>{note}</p>}
        </div>;
      })}
      <div className="cr-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || card.reviewed} onClick={() => { checkCard(controller, ticket, card); }}>
          {card.reviewed ? "Checked" : unclear ? "Looks right — keep the unclear parts marked" : empty ? "Looks right — empty fields are blank on the card" : "Looks right — I checked this card"}</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => { controller.remove(ticket, card.id); }}>Remove this card</button>
      </div>
    </div>
  </article>;
}
