// "Read visitor cards": a temporary review on this Mac, kept in memory until the leader discards it (owner decision
// 2026-11-16, audit item 20). Card photos, recognized text and typed fields live only in the CardReview lifecycle and in
// memory (the lines this Mac read sit beside it in a ref that is emptied whenever the review closes) for as long as Ozzie
// is open: switching to another app, going to another page or closing the window keeps them. They end at "Discard these
// cards" (asked once), when Ozzie closes, when Ozzie switches to another church or when Planning Center is disconnected
// (`KeptCards`); KEPT_ENDS says which of those ask first (review P, M1 and L4). After the window was off
// screen (closed or minimized, the screen locked, the Mac asleep) they wait behind "Show the cards", so they aren't on screen for
// whoever comes back to the Mac. Nothing is saved (no storage, files, recordings or logs), nothing goes to an AI model,
// and nothing is added to Planning Center; photos are revoked object URLs. App.tsx keeps this page mounted once opened,
// hidden when another page is shown, and hears only how many cards are open.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { fields, type CardView, type FieldName, type Reading } from "../../../core/src/card-review/lifecycle.js";
import { followUpFor, possibleMatches, readLines, reviewedList, sameNameCards, suggestFields, type ReadLine, type ReviewedCard } from "../../../core/src/card-fields.js";
import { CardReviewController } from "../../src/card-review/controller.js";
import { browserImages } from "../../src/card-review/browser.js";
import { Icon } from "./icons.js";

/** `unclearLines`: the lines of `text` (from 0) the reader couldn't read clearly. */
export type CardTextResult = { status: "read"; text: string; unclearLines: number[] } | { status: "not-available" };
const lineNumbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every(n => Number.isSafeInteger(n) && n >= 0);
/**
 * Native, on this Mac: the photo's bytes go to the local recognizer (Apple Vision in Ozzie's own
 * sandboxed reader) on a pipe and its text comes back. Never to an AI model.
 */
export const cardReader = {
  /** The page opened: get the reader ready (a minute or two the first time on a Mac). No card is involved. */
  prepare: () => invoke<"ready" | "not-available">("prepare_card_reader"),
  read: (image: Uint8Array) => invoke<CardTextResult>("read_card_text", image),
  /** The review closed: stop any card still being read; its text is thrown away natively. */
  cancel: () => invoke<void>("cancel_card_reading"),
};

export type ReadState = "waiting" | "reading" | "read" | "by-hand" | "failed";
/**
 * Where a field's words came from: "read" by this Mac from a labeled line ("read-more" when there
 * is more writing after a request), "chosen" by the person from the lines this Mac read, or "typed"
 * (typed or changed by hand). Field names only; never card content.
 */
export type FieldSource = "read" | "read-more" | "chosen" | "typed";
export type Sources = Readonly<Record<number, Readonly<Partial<Record<FieldName, FieldSource>>>>>;
/** "preparing": the first preparation on this Mac is taking a while. */
export type Recognizer = "unknown" | "preparing" | "available" | "not-available";
/** How long the preparation runs before the page says it's getting ready (it usually takes under a second). */
const SLOW_PREPARE_MS = 1500;
export interface CardsUi {
  reading: Readonly<Record<number, ReadState>>;
  source: Sources;
  recognizer: Recognizer;
  ended: "copied" | "discarded" | null;
  copied: number;
  /** How many prepared follow-ups the copied list held (a count only). */
  followUps: number;
  copyProblem: boolean;
  /** Why the Mac refused the photos just chosen; cleared by the next choice. */
  refused: PickProblem | null;
}
export const emptyUi: CardsUi = { reading: {}, source: {}, recognizer: "unknown", ended: null, copied: 0, followUps: 0, copyProblem: false, refused: null };

const LABEL: Record<FieldName, string> = { name: "Name", phone: "Phone", email: "Email", request: "Request — their exact words" };
const SHORT: Record<FieldName, string> = { name: "Name", phone: "Phone", email: "Email", request: "Request" };
const LIMIT: Record<FieldName, number> = { name: 256, phone: 256, email: 256, request: 2000 };
/** The person's two choices per field: what the card says, and whether it's hard to read. */
export const readingFor = (text: string, hard: boolean): Reading => hard ? "unclear" : text ? "typed" : "blank";

/**
 * Native, on this Mac: Ozzie's own photo window, offering only PNG, JPEG and HEIC (the kinds the reader opens; HEIC is
 * how an iPhone saves photos). It takes nothing from the page, so the page can never name a file to read; the Mac checks
 * every chosen file (a plain file, a PNG, JPEG or HEIC by its bytes, within the limits) and replies with the photos only:
 * no names, no paths
 * (src-tauri/src/card_picker.rs).
 */
export const cardPhotos = { choose: () => invoke<unknown>("choose_card_photos") };

/** Photos the review couldn't open, said the same wherever it happens. */
export const UNREADABLE = "Those photos couldn't be opened. Choose PNG, JPEG or HEIC (iPhone photos): up to 8 at a time, 8 MB each.";
/** Why the Mac refused a choice. Closed codes only; never a file name. */
export type PickProblem = "not-a-photo" | "too-large" | "too-many-pixels" | "too-much-together" | "too-many" | "unreadable" | "unavailable";
export const PICK_PROBLEM: Record<PickProblem, string> = {
  "not-a-photo": "That isn't a photo Ozzie can read. Choose a PNG, JPEG or HEIC (iPhone photos) picture of each card.",
  "too-large": "That photo is over 8 MB. Choose photos of 8 MB or less: PNG, JPEG or HEIC (iPhone photos).",
  // Native refuses a picture over 40 million pixels of any kind (card_picker.rs; a 48-megapixel iPhone photo).
  "too-many-pixels": "That photo is larger than Ozzie can read (over 40 megapixels). On an iPhone, take a new photo of the card at the usual size, or take a screenshot of the photo.",
  "too-much-together": "Those photos are over 24 MB together. Choose fewer at a time.",
  "too-many": "That's more than 8 photos. Choose up to 8 at a time.",
  unreadable: UNREADABLE,
  unavailable: "The window for choosing photos couldn't open. Try again.",
};
const pickProblem = (code: unknown): PickProblem =>
  typeof code === "string" && Object.hasOwn(PICK_PROBLEM, code) ? code as PickProblem : "unreadable";

const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
/**
 * The photos in the Mac's reply, in the order chosen: per photo a kind byte (1 PNG, 2 JPEG, 3 HEIC), its length in 4 bytes and
 * its bytes. Files are named only "Card 1" and so on. Empty when nothing was chosen; null for a reply that isn't that.
 */
export function cardPhotoFiles(reply: unknown): File[] | null {
  const bytes = reply instanceof Uint8Array ? reply : reply instanceof ArrayBuffer ? new Uint8Array(reply) : null;
  if (!bytes) return null;
  const files: File[] = [];
  for (let at = 0; at < bytes.length;) {
    if (files.length === MAX_PHOTOS || at + 5 > bytes.length) return null;
    const kind = bytes[at]!;
    const length = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4).getUint32(0);
    at += 5;
    const ext = kind === 1 ? "png" : kind === 2 ? "jpg" : kind === 3 ? "heic" : null;
    if (ext === null || length < 1 || length > MAX_PHOTO_BYTES || at + length > bytes.length) return null;
    files.push(new File([bytes.slice(at, at + length)], `Card ${files.length + 1}.${ext}`,
      { type: kind === 1 ? "image/png" : kind === 2 ? "image/jpeg" : "image/heic" }));
    at += length;
  }
  return files;
}

/**
 * "Choose card photos": opens the Mac's photo window for a new review. The chosen photos go to `onFiles` once;
 * cancelling closes the review quietly; a refusal closes it and goes to `onRefused`.
 */
export function pickCards(controller: CardReviewController, choose: () => Promise<unknown>,
  onFiles: (ticket: number, files: File[]) => void, onRefused: (problem: PickProblem) => void): number | null {
  const ticket = controller.choose(() => {});
  if (ticket === null) return null;
  choose().then(reply => {
    const files = cardPhotoFiles(reply);
    if (files?.length) { onFiles(ticket, files); return; }
    controller.discard(ticket);
    if (files === null) onRefused("unreadable");
  }, (code: unknown) => {
    controller.discard(ticket);
    // Another photo window is already open: that one carries on.
    if (code !== "busy") onRefused(pickProblem(code));
  });
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
 * Reads each card on this Mac, one at a time, and fills only what was read cleanly from a labeled
 * line or flags what wasn't. Every line it read goes to `onRead` for the person to place themselves.
 * Results for a review that has closed (or a card that was removed) are dropped.
 */
export async function readCardsLocally({ controller, ticket, files, read, live, onState, onSuggested, onRead, onRecognizer }: {
  controller: CardReviewController; ticket: number; files: (File | null)[];
  read: (image: Uint8Array) => Promise<CardTextResult>; live: () => boolean;
  onState: (id: number, state: ReadState) => void; onSuggested: (id: number, fields: Partial<Record<FieldName, FieldSource>>) => void;
  onRead: (id: number, lines: ReadLine[]) => void; onRecognizer: (r: Recognizer) => void;
}): Promise<void> {
  for (let index = 0; index < files.length; index++) {
    const id = index + 1;
    const file = files[index] ?? null;
    files[index] = null;
    if (!live()) { files.fill(null); return; }
    if (!file || !controller.source(ticket, id)) continue;
    onState(id, "reading");
    let text: string | null = null;
    let unclearLines: number[] = [];
    let unavailable = false;
    try {
      const result = await read(new Uint8Array(await file.arrayBuffer()));
      if (result.status === "not-available") unavailable = true;
      else if (typeof result.text === "string" && lineNumbers(result.unclearLines)) ({ text, unclearLines } = result);
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
    const suggestions = suggestFields(text, unclearLines);
    const lines = readLines(text, unclearLines);
    text = null;
    const filled: Partial<Record<FieldName, FieldSource>> = {};
    for (const field of fields) {
      const s = suggestions[field];
      if (!s.text && !s.unclear) continue;
      if (controller.edit(ticket, { card: id, field, text: s.text, state: s.unclear ? "unclear" : "typed" }) === "ok") filled[field] = s.more ? "read-more" : "read";
    }
    onRead(id, lines);
    onSuggested(id, filled);
    onState(id, "read");
  }
}

/**
 * The person puts a line this Mac read into a field: name, phone and email take the line, the request
 * gets it added on a new line. A line too long for the field is refused, never cut. Returns where the
 * field's words now come from, or null when nothing changed.
 */
export function placeLine(controller: CardReviewController, ticket: number, card: CardView, field: FieldName, line: ReadLine,
  source: FieldSource | undefined): FieldSource | null {
  const current = card.fields[field];
  const add = field === "request" && current.text !== "";
  const text = add ? `${current.text}\n${line.text}` : line.text;
  if ([...text].length > LIMIT[field]) return null;
  const unclear = line.unclear || (add && current.state === "unclear");
  if (controller.edit(ticket, { card: card.id, field, text, state: unclear ? "unclear" : "typed" }) !== "ok") return null;
  return add && source === "typed" ? "typed" : "chosen";
}

/** Escape returns an enlarged photo to its usual size. */
export const escapeCloses = (open: boolean, close: () => void) => (e: { key: string; stopPropagation(): void }) => {
  if (open && e.key === "Escape") { e.stopPropagation(); close(); }
};

/** The person confirms the whole card: fields nobody filled are blank on the card; unclear ones stay marked. */
export function checkCard(controller: CardReviewController, ticket: number, card: CardView) {
  for (const field of fields) {
    if (card.fields[field].state === "unreviewed") controller.edit(ticket, { card: card.id, field, text: "", state: "blank" });
  }
  const unclear = fields.some(field => card.fields[field].state === "unclear" || card.fields[field].state === "not-readable");
  return controller.review(ticket, { card: card.id, acknowledge: unclear });
}

/** A card as the copied list and its prepared follow-up see it; fields a person typed say so. */
const reviewed = (card: CardView, source: Sources = {}): ReviewedCard => ({
  label: card.label,
  fields: Object.fromEntries(fields.map(f => [f, {
    text: card.fields[f].text, state: card.fields[f].state, ...(source[card.id]?.[f] === "typed" ? { by: "person" as const } : {}),
  }])) as Record<FieldName, { text: string; state: Reading; by?: "person" }>,
});

/** The plain list, built from the review at the moment of copying. */
export function listFor(controller: CardReviewController, source: Sources = {}): { text: string; count: number; followUps: number } {
  let text = "", count = 0, followUps = 0;
  controller.render(view => {
    const cards = view.cards.map(card => reviewed(card, source));
    count = cards.length;
    followUps = cards.filter(card => followUpFor(card)).length;
    text = reviewedList(cards);
  });
  return { text, count, followUps };
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

/** What to look at first: possible matches with people already in the latest check, repeated names, and unclear readings. */
export function lookFirst(cards: readonly CardView[], people: Readonly<Record<string, string>>, source: Sources = {}): { card: number; text: string }[] {
  const out: { card: number; text: string }[] = [];
  for (const card of cards) {
    const name = card.fields.name.text.trim();
    const matches = name ? possibleMatches(name, people).map(id => people[id]!) : [];
    if (matches.length) out.push({ card: card.id, text: `${card.label}: “${name}” has the same name as ${joined([...new Set(matches)])} in the latest check. Worth a look: only the name matches, which doesn't show it's the same person. Ozzie won't combine them. Check Planning Center before adding anyone.` });
  }
  for (const group of sameNameCards(cards.map(c => ({ id: c.id, name: c.fields.name.text })))) {
    out.push({ card: group[0]!, text: `Cards ${joined(group.map(String))} have the same name. They may be the same person.` });
  }
  for (const card of cards) {
    // A request with more writing after it on the card isn't hard to read: it may go on.
    const more = source[card.id]?.request === "read-more" && card.fields.request.state === "unclear";
    const hard = fields.filter(f => (card.fields[f].state === "unclear" || card.fields[f].state === "not-readable") && !(more && f === "request"));
    if (hard.length) out.push({ card: card.id, text: `${card.label}: the ${joined(hard.map(f => f === "request" ? "request" : f))} ${hard.length === 1 ? "is" : "are"} hard to read. Worth a look against the photo.` });
    if (more) out.push({ card: card.id, text: `${card.label}: there's more writing on the card after the request. Worth a look: check whether it belongs to it.` });
  }
  return out;
}

/**
 * Kept while Ozzie is open (audit item 20): the review is never interrupted by switching apps or pages, only discarded
 * by the leader or by the page going away (Ozzie quitting). The core lifecycle is told the window is always in front,
 * so its own foreground rule never closes it.
 */
export function bindKeep(controller: CardReviewController, win: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
  const pagehide = () => { controller.discard(); };
  win.addEventListener("pagehide", pagehide);
  return () => { win.removeEventListener("pagehide", pagehide); controller.dispose(); };
}
export const keptImages = () => ({ ...browserImages(), foreground: () => true });

export const KEPT_TITLE = "Kept on this Mac until you discard them";
/** All the box says up front, beside its title (owner's polish pass, 2026-11-18); when the cards end is under KEPT_MORE. */
export const KEPT_PROMISE = "Nothing here is saved in Ozzie, sent to an AI model or added to Planning Center. Keep your original photos.";
export const KEPT_MORE = "When these cards end";
export const KEPT_BODY = "These cards stay in Ozzie's memory while it is open: switching to another app, going to another page or closing the window keeps them. If the window was closed or minimized, the screen locked or the Mac slept, they wait behind Show the cards. They end when:";
/** Every way the cards end, and which ask first: native app_menu.rs and always_on.rs (quitting), updates-view.tsx
 *  (updating), connection.ts `switchCopy` (switching churches). Nothing holds the Mac's own exits. */
export const KEPT_ENDS = [
  "You choose Discard these cards.",
  "You choose Quit Ozzie or press Command-Q. Ozzie asks first.",
  "You choose Update Ozzie and reopen it. Ozzie asks first.",
  "Ozzie switches to another church, or you disconnect Planning Center. Ozzie asks first.",
  "You sign out of this Mac, restart or shut it down, choose Quit from the Dock, or Ozzie stops any other way. These don't ask.",
] as const;
export const SHOW_CARDS = "Show the cards";
export const veiledText = (n: number) => `${n === 1 ? "1 visitor card is" : `${n} visitor cards are`} still open, kept in memory only. They're hidden because Ozzie's window was off screen.`;
export const DISCARD_ASK = (n: number) => `Discard ${n === 1 ? "this card" : `these ${n} cards`}? Nothing from ${n === 1 ? "it" : "them"} is kept anywhere.`;

/** Tests only: a review already open with cards read, in place of the empty one the page makes. */
type GivenReview = { controller: CardReviewController; ticket: number };

/** Which church the open visitor cards belong to (`church`), and how many times they have been ended for a change of church. */
export type CardsAt = { church: string | null; epoch: number };
/**
 * The cards as the church Ozzie uses changes (review P, L4). They are kept by the church in use natively, never by an ID
 * typed in Settings. Cards read with no church in use belong to none, so the first church signed in to keeps them, and
 * from then on they are that church's. No church's names were beside them meanwhile: names are offered as possible
 * matches only from a check of the church in use (`namesBeside`), never from a saved copy of the last church's check
 * that may still be on screen while none is. A change to another church ends
 * them; it only ever comes from "Switch Ozzie to this church?", which says so first, because native code asks whenever
 * a sign-in would replace the church it last used (core native-auth connections.rs), and Disconnect, which forgets that
 * church, ends them itself after its own question (`discarded`). No church in use for a moment (a sign-in under way, a
 * Keychain write) keeps them. With nothing open, the next cards belong to the church in use now. Returns `at` itself when
 * nothing changes.
 */
export function cardsAt(at: CardsAt, inUse: string | null, open: boolean): CardsAt {
  if (inUse === at.church) return at;
  if (!open) return { ...at, church: inUse };
  if (inUse === null) return at;
  if (at.church === null) return { ...at, church: inUse };
  return { church: inUse, epoch: at.epoch + 1 };
}
/** A check on screen, as the cards may use it: whose church it is, and the names it read. */
export type ShownCheck = { organization: string; names: Readonly<Record<string, string>> };
export const MATCHES_NEED_CHURCH = "Connect Planning Center to see possible matches with the people in the latest check.";
export const MATCHES_NEED_CHECK = "Possible matches appear once Ozzie has run a check for the church it's using.";
export const MATCHES_NEED_SIGN_IN = "Sign in to Planning Center again in Settings to see possible matches.";
export const MATCHES_NOT_IN_EXAMPLE = "While the example is on, no names are offered as possible matches: its people are made up.";
const NO_NAMES: Readonly<Record<string, string>> = Object.freeze({});
/**
 * The names a card may be compared with (review G): only those a check of the church Ozzie uses now read. None while no
 * church is in use (a saved copy of the last church's check may be on screen then), none from a check of any other
 * church whatever Settings names, and none while the example is on (the cards are real, its people made up). `why`
 * says why none are offered: "Connect Planning Center" only while it is `disconnected`, since native code also names no
 * church in use while it checks a sign-in, at launch or on a refresh (review K, L5); "Sign in … again" when the sign-in
 * failed in a way only a new sign-in mends (`signInAgain`, connection.ts `needsSignIn`; review M, L5).
 */
export function namesBeside(check: ShownCheck | null, inUse: string | null, example: boolean, disconnected: boolean, signInAgain = false): { names: Readonly<Record<string, string>>; why: string | null } {
  if (example) return { names: NO_NAMES, why: MATCHES_NOT_IN_EXAMPLE };
  if (inUse === null) return { names: NO_NAMES, why: disconnected ? MATCHES_NEED_CHURCH : signInAgain ? MATCHES_NEED_SIGN_IN : MATCHES_NEED_CHECK };
  if (!check || check.organization !== inUse) return { names: NO_NAMES, why: MATCHES_NEED_CHECK };
  return { names: check.names, why: null };
}
/**
 * The visitor cards page as App keeps it: mounted once opened, ended (a new, empty review) when `cardsAt` says the church
 * changed or `discarded` goes up (Disconnect, after its question). Names beside the cards come only from a check of the
 * church the cards belong to while it is in use (`namesBeside`). It reads no setting and no ID typed in Settings.
 */
export function KeptCards({ check, example, inUse, disconnected, signInAgain = false, discarded = 0, onScreen = true, onOpenCards, review }: {
  /** The check on screen, if any. */
  check: ShownCheck | null;
  /** Whether the fictional example is on. */
  example: boolean;
  /** The church Ozzie uses now (native), or null while none is. */
  inUse: string | null;
  /** Whether the native status says Planning Center is disconnected (not a sign-in being checked). */
  disconnected: boolean;
  /** Whether the sign-in failed in a way only a new sign-in mends (connection.ts `needsSignIn`). */
  signInAgain?: boolean;
  /** How many times the leader chose to disconnect with cards open: each one ends them. */
  discarded?: number;
  onScreen?: boolean;
  onOpenCards?: ((count: number) => void) | undefined;
  review?: GivenReview | undefined;
}) {
  const [open, setOpen] = useState(0);
  const [at, setAt] = useState<CardsAt>(() => ({ church: inUse, epoch: 0 }));
  // Decided while rendering, so cards of one church are never drawn, even for a frame, while another is in use.
  const next = cardsAt(at, inUse, open > 0);
  if (next !== at) setAt(next);
  const told = useCallback((n: number) => { setOpen(n); onOpenCards?.(n); }, [onOpenCards]);
  const beside = namesBeside(check, next.church === inUse ? inUse : null, example, disconnected, signInAgain);
  return <CardsPage people={beside.names} noMatches={beside.why} workspace={`cards-${next.epoch}-${discarded}`} onScreen={onScreen} onOpenCards={told} review={review} />;
}
export function CardsPage({ people, noMatches = null, workspace, onScreen = true, onOpenCards, review }: {
  people: Readonly<Record<string, string>>; workspace: string;
  /** Why no names are offered as possible matches, when none are (`namesBeside`). */
  noMatches?: string | null;
  /** Whether Ozzie's window is on screen: once it wasn't, open cards wait behind Show the cards. */
  onScreen?: boolean;
  /** How many cards are open (a count only), so quitting can ask first. */
  onOpenCards?: ((count: number) => void) | undefined;
  review?: GivenReview | undefined;
}) {
  return <CardsHost key={workspace} people={people} noMatches={noMatches} workspace={workspace} onScreen={onScreen} onOpenCards={onOpenCards} given={review} />;
}

function CardsHost({ people, noMatches, workspace, onScreen, onOpenCards, given }: {
  people: Readonly<Record<string, string>>; noMatches: string | null; workspace: string; onScreen: boolean; onOpenCards?: ((count: number) => void) | undefined;
  given?: GivenReview | undefined;
}) {
  const [controller, setController] = useState<CardReviewController | null>(null);
  const [, redraw] = useState(0);
  const [ticket, setTicket] = useState<number | null>(given?.ticket ?? null);
  const [ui, setUi] = useState<CardsUi>(emptyUi);
  const files = useRef<(File | null)[]>([]);
  /** The lines this Mac read on each card of the open review. Emptied whenever the review closes. */
  const recognized = useRef(new Map<number, readonly ReadLine[]>());
  const current = useRef<number | null>(null);
  const recognizer = useRef<Recognizer>("unknown");
  const [veiled, setVeiled] = useState(false);
  useLayoutEffect(() => {
    const review = given?.controller ?? new CardReviewController(workspace, keptImages());
    let open = review.status === "active";
    const stopReading = () => { void cardReader.cancel().catch(() => undefined); };
    const unsubscribe = review.subscribe(() => {
      const now = ["choosing", "loading", "active"].includes(review.status);
      // Closing (finish, discard, interruption) lets go of the files and what was read, and stops any reading in progress.
      if (!now) { files.current.fill(null); recognized.current.clear(); }
      if (open && !now) stopReading();
      open = now;
      flushSync(() => redraw(v => v + 1));
    });
    const unbind = bindKeep(review, window);
    setController(review);
    return () => { files.current.fill(null); files.current = []; recognized.current.clear(); current.current = null; unsubscribe(); unbind(); stopReading(); };
  }, [workspace]);
  // Get this Mac's reader ready while the person finds their photos. It reads only Ozzie's own
  // practice picture; a card chosen meanwhile simply waits for it.
  useLayoutEffect(() => {
    let live = true;
    const slow = setTimeout(() => { if (live) setUi(u => u.recognizer === "unknown" ? { ...u, recognizer: "preparing" } : u); }, SLOW_PREPARE_MS);
    cardReader.prepare().then(status => {
      if (!live) return;
      const r: Recognizer = status === "ready" ? "available" : "not-available";
      recognizer.current = r;
      setUi(u => ({ ...u, recognizer: r }));
    }, () => { if (live) setUi(u => u.recognizer === "preparing" ? { ...u, recognizer: "unknown" } : u); })
      .finally(() => clearTimeout(slow));
    return () => { live = false; clearTimeout(slow); };
  }, []);
  // Open cards (a count only) for the question on quitting; the window off screen veils them until Show the cards.
  const status = controller?.status;
  const openCount = (() => { let n = 0; if (status === "active") controller!.render(v => { n = v.cards.length; }); return n; })();
  useEffect(() => { onOpenCards?.(openCount); }, [openCount, onOpenCards]);
  useEffect(() => () => onOpenCards?.(0), [onOpenCards]);
  useEffect(() => { if (!onScreen && openCount > 0) setVeiled(true); }, [onScreen, openCount]);
  if (!controller) return <div className="col"><p role="status">Preparing a temporary review.</p></div>;
  if (veiled && openCount > 0) return <div className="col cards">
    <p className="eyebrow">Visitor cards</p>
    <h1 className="h1">Read visitor cards</h1>
    <p className="lede">{veiledText(openCount)}</p>
    <div className="row"><button type="button" className="btn btn-primary" onClick={() => setVeiled(false)}>{SHOW_CARDS}</button></div>
  </div>;

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
      onSuggested: (id, filled) => setUi(u => ({ ...u, source: { ...u.source, [id]: filled } })),
      onRead: (id, lines) => { recognized.current.set(id, lines); },
      onRecognizer: r => { recognizer.current = r; setUi(u => ({ ...u, recognizer: r })); },
    });
  };
  const start = () => {
    recognized.current.clear();
    setUi(u => ({ ...emptyUi, recognizer: u.recognizer }));
    const t = pickCards(controller, cardPhotos.choose, (t, chosen) => { void begin(t, chosen); },
      problem => setUi(u => ({ ...u, refused: problem })));
    current.current = t;
    setTicket(t);
  };
  const copy = async () => {
    if (ticket === null) return;
    const { text, count, followUps } = listFor(controller, ui.source);
    const ok = text ? await writeClipboard(text) : false;
    if (!ok) { setUi(u => ({ ...u, copyProblem: true })); return; }
    // The list is on the clipboard either way; if the review closed meanwhile, still say it was copied.
    if (controller.finish(ticket) !== "finished") controller.discard();
    setUi(u => ({ ...u, ended: "copied", copied: count, followUps, copyProblem: false }));
  };
  return <CardsReview controller={controller} ticket={ticket} ui={ui} people={people} noMatches={noMatches} onChoose={start}
    lines={controller.status === "active" ? Object.fromEntries(recognized.current) : {}}
    onCopy={() => { void copy(); }}
    onDiscard={() => { if (ticket !== null) controller.discard(ticket); setUi(u => ({ ...u, ended: "discarded" })); }}
    onSource={(id, field, from) => setUi(u => ({ ...u, source: { ...u.source, [id]: { ...u.source[id], [field]: from } } }))}
    onRemoved={id => { recognized.current.delete(id); setUi(u => ({ ...u, source: Object.fromEntries(Object.entries(u.source).filter(([k]) => Number(k) !== id)) })); }} />;
}

/** The page body. Rendered by the host above and by the tests with a controller on fixed fictional data. */
export function CardsReview({ controller, ticket, ui, people, noMatches = null, lines, onChoose, onCopy, onDiscard, onSource, onRemoved, askingToDiscard = false }: {
  controller: CardReviewController; ticket: number | null; ui: CardsUi; people: Readonly<Record<string, string>>;
  /** Why no names are offered as possible matches, said once cards are open. */
  noMatches?: string | null | undefined;
  lines: Readonly<Record<number, readonly ReadLine[]>>;
  onChoose: () => void; onCopy: () => void; onDiscard: () => void;
  onSource: (card: number, field: FieldName, from: FieldSource) => void; onRemoved: (card: number) => void;
  /** Start with "Discard these cards?" asked (tests). */
  askingToDiscard?: boolean;
}) {
  const [discarding, setDiscarding] = useState(askingToDiscard);
  let cards: CardView[] = [];
  controller.render(view => { cards = [...view.cards]; });
  const status = controller.status;
  const open = status === "choosing" || status === "loading" || status === "active";
  const active = status === "active" && ticket !== null;
  const reading = Object.values(ui.reading).filter(s => s === "waiting" || s === "reading").length;
  const total = Object.keys(ui.reading).length;
  const allChecked = cards.length > 0 && cards.every(c => c.reviewed);
  const first = active ? lookFirst(cards, people, ui.source) : [];
  return <div className="col cards">
    <p className="eyebrow">Visitor cards</p>
    <h1 className="h1">Read visitor cards</h1>
    <p className="lede">Choose photos of several cards at once. Each card stays beside its photo while you check it, then you copy the list or discard it.</p>
    {/* The title and two short sentences up front; every way the cards end, before and while they're open, one click
        away in the app's usual fold (owner's polish pass, 2026-11-18). */}
    <div className="limits" id="cards-limits">
      <p className="limits-t" id="cards-limits-t"><Icon name="lock" small />{KEPT_TITLE}</p>
      <p id="cards-limits-promise">{KEPT_PROMISE}</p>
      <details className="listen-more limits-more">
        <summary><Icon name="chev" small />{KEPT_MORE}</summary>
        <p>{KEPT_BODY}</p>
        <ul>{KEPT_ENDS.map(end => <li key={end}>{end}</li>)}</ul>
      </details>
    </div>
    {ui.recognizer === "not-available"
      ? <p className="panel-info"><Icon name="info" small />This Mac can't read card text, so please type each card.</p>
      : <p className="small">If this Mac can read the card text, Ozzie fills in what it reads clearly and marks what it can't. Every field still needs a person to check it.</p>}
    {ui.recognizer === "preparing" && <p className="small" role="status"><Icon name="spinner" small spin /> Getting this Mac ready to read cards. The first time can take a minute or two; nothing from your cards is used for this.</p>}

    {!open && <div className="row">
      <button type="button" className="btn btn-primary" aria-describedby="cards-limits-t cards-limits-promise" onClick={onChoose}>Choose card photos</button>
      <span className="small">PNG, JPEG or HEIC (iPhone photos) · up to 8 at a time · 8 MB each</span>
    </div>}
    <p className="small" role="status" aria-live="polite">{status === "choosing" ? "Choose the card photos in the window that opened."
      : status === "loading" ? "Opening the photos on this Mac…"
        : active && reading > 0 ? `Reading card ${Math.min(total - reading + 1, total)} of ${total} on this Mac…`
          : active ? `${cards.length} ${cards.length === 1 ? "card" : "cards"} open for checking.` : ""}</p>
    {status === "error" && <p role="alert" className="problem">{UNREADABLE}</p>}
    {ui.refused && !open && status !== "error" && <p role="alert" className="problem">{PICK_PROBLEM[ui.refused]}</p>}
    {ui.ended === "copied" && !open && <div className="panel-ok" role="status"><Icon name="check" />
      <p><strong>Reviewed here; nothing saved to your church's tools.</strong> Copied {ui.copied === 1 ? "1 card" : `${ui.copied} cards`}. Paste the list where your church keeps visitor records.{ui.followUps > 0 && ` The list includes ${ui.followUps === 1 ? "1 prepared follow-up" : `${ui.followUps} prepared follow-ups`}. Choose who will follow up in your church tools; Ozzie won't contact anyone.`} This review is closed and nothing from it was kept in Ozzie. The list is on this Mac's clipboard until you copy something else; if you use Universal Clipboard or a clipboard history app, it may be there too.</p></div>}
    {status === "closed" && ui.ended !== "copied" && (ui.ended === "discarded" || total > 0) && <p className="panel-sunken">{ui.ended === "discarded" ? "Discarded. Nothing from these cards was kept." : "This review is closed and nothing from it was kept."} Choose the photos again to start over.</p>}

    {active && noMatches && <p className="small">{noMatches}</p>}
    {active && first.length > 0 && <section className="panel-info cards-first" aria-labelledby="first-title">
      <Icon name="eye" />
      <div className="stack-tight">
        <h2 id="first-title" className="bold">Look at these first</h2>
        <ul className="list">{first.map((f, i) => <li key={i}><Icon name="dot" small /><a href={`#card-${f.card}`}>{f.text}</a></li>)}</ul>
      </div>
    </section>}

    {active && cards.map(card => <CardItem key={`${ticket}-${card.id}`} card={card} controller={controller} ticket={ticket!}
      state={ui.reading[card.id] ?? "by-hand"} source={ui.source[card.id] ?? {}} lines={lines[card.id] ?? []} people={people}
      onSource={onSource} onRemoved={onRemoved} />)}

    {open && <footer className="cards-end">
      {active && <button type="button" className="btn btn-primary" disabled={!allChecked || reading > 0} onClick={onCopy}>Copy the reviewed list</button>}
      {!discarding && <button type="button" className="btn btn-secondary" onClick={() => active ? setDiscarding(true) : onDiscard()}>Discard these cards</button>}
      {discarding && <div className="decide" role="group" aria-labelledby="cards-discard-q">
        <p id="cards-discard-q" className="find-body">{DISCARD_ASK(cards.length)}</p>
        <div className="find-next">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { setDiscarding(false); onDiscard(); }}>Yes, discard {cards.length === 1 ? "it" : "them"}</button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setDiscarding(false)}>Keep {cards.length === 1 ? "it" : "them"}</button>
        </div>
      </div>}
      {active && !allChecked && <span className="small">Check every card against its photo before copying.</span>}
      {ui.copyProblem && <p role="alert" className="problem">The list couldn't be copied. Nothing was discarded; try again.</p>}
    </footer>}
  </div>;
}

function CardItem({ card, controller, ticket, state, source, lines, people, onSource, onRemoved }: {
  card: CardView; controller: CardReviewController; ticket: number; state: ReadState;
  source: Readonly<Partial<Record<FieldName, FieldSource>>>; lines: readonly ReadLine[];
  people: Readonly<Record<string, string>>; onSource: (card: number, field: FieldName, from: FieldSource) => void; onRemoved: (card: number) => void;
}) {
  const [large, setLarge] = useState(false);
  const busy = state === "waiting" || state === "reading";
  const name = card.fields.name.text.trim();
  const matches = name ? possibleMatches(name, people).map(id => people[id]!) : [];
  const unclear = fields.some(f => card.fields[f].state === "unclear" || card.fields[f].state === "not-readable");
  const empty = fields.some(f => card.fields[f].state === "unreviewed");
  const edit = (field: FieldName, text: string, hard: boolean) => {
    controller.edit(ticket, { card: card.id, field, text, state: readingFor(text, hard) });
  };
  const place = (field: FieldName, line: ReadLine) => {
    const from = placeLine(controller, ticket, card, field, line, source[field]);
    if (from) onSource(card.id, field, from);
  };
  const followUp = card.reviewed ? followUpFor(reviewed(card)) : null;
  const unlabeled = state === "read" && lines.length > 0 && !Object.keys(source).length && empty;
  const src = controller.source(ticket, card.id);
  return <article className={`cr cards-item${large ? " is-large" : ""}`} id={`card-${card.id}`} aria-labelledby={`card-${card.id}-t`}
    onKeyDown={escapeCloses(large, () => setLarge(false))}>
    <div className={`cards-photo${lines.length ? " has-read" : ""}`}>
      <div className="cr-img">{src && <img src={src} alt={`${card.label} photo`} onError={() => { controller.discard(ticket); }} />}</div>
      <button type="button" className="btn btn-quiet btn-sm" aria-pressed={large} onClick={() => setLarge(!large)}>
        {large ? "Smaller photo" : "See the photo larger"}<span className="sr-only"> ({card.label})</span></button>
      {lines.length > 0 && <section className="cards-read" aria-labelledby={`card-${card.id}-read`}>
        <h3 id={`card-${card.id}-read`} className="bold">What this Mac read on the card</h3>
        <p className="small">Ozzie fills a field by itself only from a line with a printed label, like “Phone:”. Put any other line where it belongs.</p>
        <ol className="cards-lines">{lines.map((line, i) => {
          const id = `card-${card.id}-line-${i + 1}`;
          const used = fields.filter(f => f === "request" ? card.fields.request.text.split("\n").includes(line.text) : card.fields[f].text === line.text);
          return <li key={line.line} className="cards-line">
            <span id={id} className="cards-line-t">{line.text}</span>
            {line.unclear && <><span className="badge b-look"><Icon name="eye" small />Worth a look</span><span className="small">Hard to read</span></>}
            {used.length > 0 && <span className="small">In {joined(used.map(f => SHORT[f]))}</span>}
            <select className="input" aria-label={`Use line ${i + 1} as`} aria-describedby={id} value="" disabled={busy}
              onChange={e => { const field = e.target.value as FieldName; if (fields.includes(field)) place(field, line); }}>
              <option value="">Use as…</option>
              {fields.map(f => {
                const add = f === "request" && card.fields.request.text !== "";
                const tooLong = [...(add ? `${card.fields.request.text}\n${line.text}` : line.text)].length > LIMIT[f];
                return <option key={f} value={f} disabled={tooLong}>{add ? "Request (add this line)" : SHORT[f]}</option>;
              })}
            </select>
          </li>;
        })}</ol>
      </section>}
    </div>
    <div className="cards-fields">
      <div className="find-top">
        <h2 id={`card-${card.id}-t`} className="bold">{card.label}</h2>
        {card.reviewed ? <span className="badge b-ok"><Icon name="check" small />Checked by you</span> : <span className="badge b-muted">Needs a person to check</span>}
        {busy && <span className="small"><Icon name="spinner" small spin /> {state === "reading" ? "Reading on this Mac…" : "Waiting to be read"}</span>}
        {state === "failed" && <span className="small">This card couldn't be read. Please type it.</span>}
      </div>
      {unlabeled && <p className="small">This Mac read this card but found no printed labels like “Name:”, so it filled nothing in. Put the lines it read where they belong, or type what you see.</p>}
      {matches.length > 0 && <p className="panel-info"><Icon name="user" small />
        <span><span className="badge b-look"><Icon name="eye" small />Worth a look</span> Possible match: {joined(matches)} in the latest check {matches.length === 1 ? "has" : "have"} the same name. Only the name matches, and a name alone doesn't show it's the same person. Ozzie won't combine them.</span></p>}
      {fields.map(field => {
        const value = card.fields[field];
        const hard = value.state === "unclear" || value.state === "not-readable";
        const id = `card-${card.id}-${field}`;
        const from = source[field];
        const fromMac = from === "read" || from === "read-more";
        const note = from === "read-more" ? "There's more writing on the card after these words. Check whether any of it belongs to their request, and compare every word with the photo."
          : fromMac && hard && !value.text ? "This Mac couldn't read this clearly. Type what you see on the card."
            : fromMac && hard ? "Ozzie couldn't read this clearly — check it against the card."
              : fromMac ? "Read by this Mac. Compare it with the photo."
                : from === "chosen" && hard ? "This Mac couldn't read that line clearly — check it against the card."
                  : from === "chosen" ? "You put this line here from what this Mac read. Compare it with the photo."
                    : hard ? "You marked this hard to read." : field === "request" ? "Keep their exact words. Don't summarize or fix them." : "";
        const props = {
          id, className: "input", value: value.text, maxLength: LIMIT[field], disabled: busy, autoComplete: "off", spellCheck: false,
          "aria-describedby": note ? `${id}-note` : undefined,
          onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { edit(field, e.target.value, hard); onSource(card.id, field, "typed"); },
        };
        return <div className="cards-field" key={field}>
          <div className="cards-field-top">
            <label htmlFor={id} className="field-l">{LABEL[field]}</label>
            <span className={`cards-tag${card.reviewed ? " is-ok" : ""}`}>{card.reviewed ? "Checked" : "Needs a person to check"}</span>
            {hard && <span className="badge b-look"><Icon name="eye" small />Worth a look</span>}
          </div>
          {field === "request" ? <textarea {...props} rows={3} /> : <input {...props} />}
          <label className="confirmation small"><input type="checkbox" checked={hard} disabled={busy} onChange={e => edit(field, value.text, e.target.checked)} />
            <span><span className="sr-only">{card.label} {field === "request" ? "request" : field}: </span>Hard to read on the card</span></label>
          {note && <p className="input-help" id={`${id}-note`}>{note}</p>}
        </div>;
      })}
      {followUp && <section className="cards-followup" aria-labelledby={`card-${card.id}-follow`}>
        <h3 id={`card-${card.id}-follow`} className="bold">Prepared follow-up</h3>
        <p className="small">Suggested because their words ask {followUp.asked === "asked to be contacted" ? "to be contacted" : followUp.asked.replace(/^asked /, "")}. Check that this is what they meant.</p>
        <blockquote className="cards-quote">“{followUp.words}”</blockquote>
        {followUp.details.map(d => <p key={d}>{d}</p>)}
        <p className="bold">Choose who will follow up in your church tools.</p>
        <p className="small">Ozzie won't call, text or email anyone. This goes in the list you copy; nothing is added to Planning Center.</p>
      </section>}
      <div className="cr-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || card.reviewed} onClick={() => { checkCard(controller, ticket, card); }}>
          {card.reviewed ? "Checked" : unclear ? "Looks right — keep the unclear parts marked" : empty ? "Looks right — empty fields are blank on the card" : "Looks right — I checked this card"}</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => { if (controller.remove(ticket, card.id) === "ok") onRemoved(card.id); }}>
          Remove this card<span className="sr-only"> ({card.label})</span></button>
      </div>
    </div>
  </article>;
}
