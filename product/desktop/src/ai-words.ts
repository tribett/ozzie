// Every word on the AI screens (onboarding spec §3 S6–S10 and §4.4), in one place, so the screens and their tests share
// them. Sentences are chosen by closed codes only (onboarding-native-contract.md N5–N7): nothing a native reply or an AI
// company wrote is ever shown. `{Day}` in the spec is the watched service's real day (day-words.tsx `useDay`).
import type { Company, DownloadRefusal, KeyProvider, KeyVerdict, LocalAdvice, LocalApp, LocalVerdict, ModelEnd, ModelPhase, ModelRemoved, ModelSize, OtherAi, PaidEnd,
  Provider } from "./onboarding-bridge.js";
import { answersLeft, calendarDay, monthLimitText, NO_PLAN_TEXT, noPlan, paused, pausedLine, pausedWhen, resetDay, type ManagedAccount, type ModelStatus } from "./model.js";

/** The three companies Ozzie knows, by their product and company names (spec S8a's cards). */
export const COMPANY: Readonly<Record<Company, { product: string; company: string; article: "a" | "an" }>> = Object.freeze({
  openai: { product: "ChatGPT", company: "OpenAI", article: "an" },
  anthropic: { product: "Claude", company: "Anthropic", article: "an" },
  gemini: { product: "Gemini", company: "Google", article: "a" },
});
export const APP_NAME: Readonly<Record<LocalApp, string>> = Object.freeze({ ollama: "Ollama", "lm-studio": "LM Studio" });

// ---- Shared ------------------------------------------------------------------------------------------------------

export const AI = {
  back: "Back",
  notNow: "Not now",
  later: "I'll do this later",
  checkSetup: "Check my setup",
  close: "Close",
  namesLine: "Whichever you choose, the AI never sees the names Ozzie reads from Planning Center. It sees stand-ins like [Volunteer A], and Ozzie puts the names back on this Mac.",
  seeSent: "See exactly what is sent",
  sentTitle: "What the AI sees",
  sentInstructions: "The instructions Ozzie gives:",
  sentNote: "The note:",
  sentAfter: "Names, email addresses, phone numbers and background checks are taken out on this Mac before anything is sent, and checked again before it leaves.",
  /**
   * After a working route: first run goes on to the watched service's page; elsewhere the button names the page it goes
   * back to, by its name in the sidebar ("Back to Settings", "Back to Today").
   */
  next: (page: string) => `Next: open ${page}`,
  backTo: (page: string) => `Back to ${page}`,
  browserFailed: "Your browser didn't open. Press the button again. If nothing happens, choose a default web browser in System Settings › Desktop & Dock, then try again.",
  loading: "Checking which AI Ozzie uses…",
  statusFailed: "Ozzie couldn't check which AI it uses just now. Everything else in Ozzie still works.",
  howTitle: "See how this works",
  how: "Ozzie keeps your key in this Mac's Keychain, under Ozzie's own entry. The key never passes through Ozzie's pages, and it is sent only to the company it belongs to.",
} as const;

/**
 * Where something needs AI and no AI works (Ask, the who-could-help look; rewording's own words are model.ts
 * `REWORD_NEEDS_AI`): one sentence and one step on, to "How should Ozzie use AI?" (walk-through, 2026-11-18).
 */
export const NEEDS_AI = {
  button: "Choose how Ozzie uses AI",
  badge: "Needs AI",
  ask: "Ask Ozzie needs AI, but everything else in Ozzie works without it.",
  look: "Asking Ozzie to look at who could help needs AI, but everything else in Ozzie works without it.",
} as const;

// ---- S6 How should Ozzie use AI? ---------------------------------------------------------------------------------

export const CHOICE = {
  eyebrow: "One more choice (optional)",
  title: "How should Ozzie use AI?",
  body: (day: string) => `Everything you just saw works without AI. AI can also reword a note, answer your questions about ${day}, and look at who could help with a role. Choose one, or leave it for now.`,
  /** In Settings there is no "just saw": the same offer, said of Ozzie as a whole. */
  bodySettings: (day: string) => `Everything else in Ozzie works without AI. AI can reword a note, answer your questions about ${day}, and look at who could help with a role.`,
  ozzie: "Ozzie's AI",
  /** Card 1's cost line from the server's offer: never a hard-coded price. */
  ozzieCost: (price: string, answers: string) => `Ready to use, nothing to set up. ${price} for ${lowerFirst(answers).replace(/ a month$/u, "")}. Cancel any time.`,
  ozzieClosed: "Not open for sign-up yet. The free ways work today.",
  /** The offer couldn't be read: Ozzie doesn't say sign-up is closed (review L9). */
  ozzieUnreachable: "Can't check just now. The free ways work today.",
  ozzieLooking: "Checking whether it's open for sign-up…",
  own: "Your church's own AI",
  ownCost: "Ozzie charges nothing. Pay an AI company a few dollars yourself, or use free AI on this Mac.",
  none: "No AI for now",
  noneCost: "Free. Everything you just saw keeps working.",
  noneCostSettings: "Free. Everything else in Ozzie keeps working.",
  small: "You can change this any time in Settings.",
  /** First run's quiet way out: not an answer, so "Finish setting up" keeps the choice (review M1). */
  later: "Decide later",
  noneFailed: "Ozzie couldn't turn AI off just now. Nothing changed. Try again.",
} as const;
const lowerFirst = (s: string) => s ? s[0]!.toLowerCase() + s.slice(1) : s;

// ---- S7 Your church's own AI -------------------------------------------------------------------------------------

export const OWN = {
  title: "Your church's own AI",
  key: "A key from an AI company",
  keyCost: "You pay the company directly, usually a few dollars a month or less. Answers are quick and good.",
  mac: "AI on this Mac",
  macCost: "Free, and nothing leaves this Mac. Slower, and simpler answers.",
} as const;

// ---- S8a Which AI company? ---------------------------------------------------------------------------------------

/** "The smallest amount you can add is $5.", only where the company's own page states it (native's `min_topup`). */
const smallest = (min: string | null | undefined) => min ? ` The smallest amount you can add is ${min}.` : "";
/** Google's free plan is never suggested for church facts (contract N5 `free_plan_not_for_church_data`); unknown data counts as that too. */
const billingFirst = (c: Company, p: Provider | null) => c === "gemini" && (p === null || p.free_plan_not_for_church_data);
export const COMPANIES = {
  title: "Which AI company?",
  body: "Choose one you've heard of. You'll make a key there (a long password for apps) and paste it here.",
  /** No company has passed this release's live test (decision 19): no card is shown. */
  noneChecked: "Ozzie is still checking these companies. AI on this Mac works today.",
  useMac: "Use AI on this Mac",
  /** Back to the companies from a key that can't be used with this one (review F3). */
  another: "Choose another company",
  easiest: "Easiest to start",
  /** A key for this company is kept on this Mac (native `own_key_saved`): it can be used again without pasting (2026-11-18). */
  kept: "Key on this Mac",
  card: (c: Company) => `${COMPANY[c].product} (${COMPANY[c].company})`,
  cost: (c: Company, p: Provider | null) => `${billingFirst(c, p) ? "Pay as you go, with billing turned on." : "Pay as you go."}${smallest(p?.min_topup)}`,
  more: "More choices",
  other: "Another AI company",
  otherCost: "For a company with an OpenAI-style address. You'll need its address and model name.",
  subscription: "A ChatGPT Plus or Claude Pro subscription is separate: it doesn't include a key. You'll add a few dollars of credit with the company for Ozzie to use.",
} as const;

// ---- S8b The company's three steps ----------------------------------------------------------------------------------

/**
 * One of the three steps: its sentence, the button that opens the company's page, and a simple drawing of that page with
 * the button to press circled (a drawing, not the real page, as S3's: `drawn` is the circled button's word, `alt` says it
 * is a drawing). `note`: Google's own terms about its free plan, said under step 2 and never as a suggestion.
 */
export interface KeyStep { text: string; button: string; page: "sign-in" | "billing" | "keys"; drawn: string; alt: string; note?: string }
const drawing = (c: Company, page: string, what: string) => `A drawing of ${COMPANY[c].company}'s ${page} page, not the real page. ${what} is circled.`;
/** Google's only sign of a paid project the person can see (verify-gemini.md): Ozzie itself can't tell. */
const PAID_TIER = "On Google's API keys page, your project should show a paid tier, not “Set up billing”.";
export const KEY = {
  title: (c: KeyProvider) => c === "other" ? "Use another AI company" : `Use ${COMPANY[c].product}'s company, ${COMPANY[c].company}`,
  /** S8a's explanation of a key, said again where the key is made (review M13). */
  intro: (c: KeyProvider) => `A key is a long password for apps. Ozzie keeps it on this Mac and sends it only to ${who(c).name}.`,
  /** Under each step's drawing, visible: it is a drawing (re-check Low). */
  drawingCaption: "A drawing of the page. Yours may look a little different.",
  steps(c: Company, p: Provider | null): KeyStep[] {
    const credit = `Add a little credit.${smallest(p?.min_topup)}`;
    switch (c) {
      case "openai": return [
        // OpenAI's own docs (verify-openai.md, 2026-11-17): a work account with single sign-on may not carry over; the
        // smallest purchase is $5; auto-reload is on unless switched off.
        { text: "Sign in at OpenAI's developer site. Your ChatGPT sign-in usually works there.", button: "Open OpenAI's sign-in page", page: "sign-in",
          drawn: "Sign in", alt: drawing(c, "sign-in", "The button to sign in") },
        { text: "Add a payment card, then buy credit. The smallest purchase is $5. OpenAI turns on automatic top-ups by default: switch off “auto-reload” unless your church wants it.",
          button: "Open OpenAI's billing page", page: "billing", drawn: "Buy credits", alt: drawing(c, "billing", "The button to buy credits") },
        { text: "Make a key: choose Create new secret key, then Copy. OpenAI shows the key only once, so copy it before you close that window.", button: "Open OpenAI's keys page",
          page: "keys", drawn: "Create new secret key", alt: drawing(c, "keys", "The Create new secret key button") },
      ];
      case "anthropic": return [
        { text: "Sign in at Anthropic's developer site, the Claude Console. You can use the same email as for Claude.", button: "Open Anthropic's sign-in page", page: "sign-in",
          drawn: "Sign in", alt: drawing(c, "sign-in", "The button to sign in") },
        { text: credit, button: "Open Anthropic's billing page", page: "billing", drawn: "Buy credits", alt: drawing(c, "billing", "The button to buy credits") },
        // The note about workspaces and when the key expires is native's own (providers.json key_note), shown as sent.
        { text: `Make a key: choose Create key, then copy the key it shows.${p?.key_note ? ` ${p.key_note}` : ""} Anthropic shows the key only once, so copy it before you close that window.`,
          button: "Open Anthropic's keys page", page: "keys", drawn: "Create key", alt: drawing(c, "keys", "The Create key button") },
      ];
      case "gemini": return [
        { text: "Sign in at Google AI Studio with your Google account.", button: "Open Google's sign-in page", page: "sign-in",
          drawn: "Sign in", alt: drawing(c, "sign-in", "The button to sign in") },
        // Ozzie never suggests Google's free plan for church facts: billing comes first, and Google's terms say why.
        billingFirst(c, p)
          ? { text: `Turn on billing before you make the key.${smallest(p?.min_topup)} ${PAID_TIER}`, button: "Open Google's billing page", page: "billing",
            drawn: "Set up billing", alt: drawing(c, "billing", "The button to set up billing"), ...(p?.free_plan_line ? { note: `Google's terms say, in short: ${p.free_plan_line}` } : {}) }
          : { text: credit, button: "Open Google's billing page", page: "billing", drawn: "Set up billing", alt: drawing(c, "billing", "The button to set up billing") },
        { text: "Make a key: open API keys in the left menu, then choose Create API key, then copy the key.", button: "Open Google's keys page", page: "keys",
          drawn: "Create API key", alt: drawing(c, "keys", "The Create API key button") },
      ];
    }
  },
  /** How the key gets to Ozzie: the native window (contract N5), or, where this build has none, what was copied. */
  askWindow: "Ozzie will ask for the key: click in the box, then press Command and V together.",
  /** Under the key box, for Google only (decision 22): Google gives Ozzie no sign of which plan a key is on. */
  geminiPlan: "Ozzie can't tell whether this key is on Google's free plan. On the free plan, Google may use what is sent to improve its products.",
  askClipboard: "Copy the key first. When you press Paste my key, Ozzie takes what you copied.",
  otherSteps: [
    "At the AI company's website, make a key for apps (it may be called an API key) and copy it.",
    "Type the company's address for apps and the model name below. The company's own help pages give both.",
  ],
  address: "The company's address for apps",
  addressHelp: "It starts with https://, such as https://api.example.com/v1",
  addressProblem: "Ozzie needs the company's https address, such as https://api.example.com/v1. Planning Center's address can't be used.",
  modelName: "Model name",
  paste: "Paste my key",
  /** A key for this company is kept on this Mac (live in the release app, 2026-11-18): it leads, the guide stays below. */
  keptLede: (c: Company) => `A key for ${COMPANY[c].company} is already on this Mac. Ozzie can check that it still works and use it.`,
  useKept: "Use the key already on this Mac",
  pasteDifferent: "Paste a different key",
  /** After a working key the guide folds away under this (live in the release app, 2026-11-18). */
  stepsAgain: "See the steps again",
  checkAgain: "Check this key again",
  checking: (c: KeyProvider) => `Checking with ${who(c).name}…`,
  /** A monthly figure only when native gives one (`typical_month`); none is worked out here. */
  cost: (c: Company, typical: string | null) =>
    `You pay ${COMPANY[c].company} directly.${typical ? ` For a typical church that's ${/^(?:under|about|less|free)\b/iu.test(typical) ? "" : "about "}${typical}${/\bmonth\b/iu.test(typical) ? "" : " a month"}.` : ""}`,
  sends: (c: KeyProvider, day: string, retention: string | null) =>
    `What Ozzie sends ${who(c).name}: your question or the note to reword, and the facts it needs about ${day} (roles, times, team names), with stand-ins like [Volunteer A] instead of names. Never the names Ozzie read from Planning Center, and never email addresses, phone numbers or background checks.${retention ? ` ${retention}` : ""}`,
} as const;

// ---- S8c What the check said about the key --------------------------------------------------------------------------

/** How a sentence names the company: OpenAI, or "the AI company" for Another AI company. */
export interface Who { name: string; Name: string; their: string }
export const who = (p: KeyProvider): Who => p === "other"
  ? { name: "the AI company", Name: "The AI company", their: "the company's" }
  : { name: COMPANY[p].company, Name: COMPANY[p].company, their: `${COMPANY[p].company}'s` };
/** Companies whose keys Ozzie recognises but has no card for (native names them in `looks_like`, contract 14). */
const OTHER_AI: Record<OtherAi, { name: string; article: string }> = { openrouter: { name: "OpenRouter", article: "an" }, xai: { name: "xAI", article: "an" }, groq: { name: "Groq", article: "a" } };
const isOtherAi = (v: unknown): v is OtherAi => typeof v === "string" && Object.hasOwn(OTHER_AI, v);
const aKey = (p: KeyProvider | OtherAi) => p === "other" ? "a key for the company you chose" : isOtherAi(p) ? `${OTHER_AI[p].article} ${OTHER_AI[p].name} key`
  : `${COMPANY[p].article} ${COMPANY[p].company} key`;

/** One verdict's words: the sentence, its tone, an extra button, and whether "Check this key again" helps. */
export interface KeySaid {
  text: string; tone: "ok" | "problem";
  /** A company page to open, or "use-other": check the key with the company its shape belongs to. */
  extra: { label: string; page: "keys" | "billing" | "settings" } | { label: string; useOther: Company } | null;
  again: boolean;
  /** No way on with this company for now: offer the company list and AI on this Mac (review F3). */
  elsewhere?: boolean;
}
/**
 * The sentence for each key verdict (spec S8c, plus the contract's "empty", "too-many-checks" and "unavailable"). Null:
 * nothing to say ("cancelled"). `host`: Another AI company's address as the person typed it, for "wrong-address".
 */
export function keySaid(verdict: KeyVerdict, p: KeyProvider, looksLike?: Company | OtherAi, host?: string | null, kept = false): KeySaid | null {
  const w = who(p), preset = p !== "other";
  // The key already on this Mac (`kept`): it stays there whatever the check says, so nothing says it wasn't kept.
  if (kept && preset) switch (verdict) {
    case "refused": return { text: `${w.Name} no longer accepts the key on this Mac. Make a new key on ${w.their} keys page, then press ${KEY.pasteDifferent}.`, tone: "problem",
      extra: { label: `Open ${w.their} keys page`, page: "keys" }, again: false };
    case "unreachable": return { text: `Ozzie couldn't reach ${w.name} just now. Check that this Mac is online, then try again. The key stays on this Mac.`, tone: "problem", extra: null, again: true };
    case "too-many-checks": return { text: "Ozzie has checked keys 10 times in the last hour, so it's pausing to be safe. Try again in an hour. The key stays on this Mac.", tone: "problem", extra: null, again: false };
    case "failed": return { text: `${w.Name} didn't take Ozzie's check just now. This is on Ozzie's side, not your key's. Try again later, or see Check my setup.`, tone: "problem", extra: null, again: true };
    case "choice-changed": return { text: `The key on this Mac works, but you chose something else while Ozzie was checking it, so Ozzie didn't switch to ${w.name}. The key stays on this Mac.`,
      tone: "problem", extra: null, again: false };
    default: break;
  }
  const page = (label: string, at: "keys" | "billing" | "settings") => preset ? { label, page: at } : null;
  const problem = (text: string, extra: KeySaid["extra"] = null, again = false): KeySaid => ({ text, tone: "problem", extra, again });
  switch (verdict) {
    case "works": return { text: preset ? `It works. Ozzie will use your ${w.name} account. The key is kept safely on this Mac.`
      : "It works. Ozzie will use your account with the AI company. The key is kept safely on this Mac.", tone: "ok", extra: null, again: false };
    case "refused": return problem(`${w.Name} didn't accept this key. Part of it may be missing. Copy it again from ${w.their} keys page and paste it here.`, page(`Open ${w.their} keys page`, "keys"));
    // One wording for every company (review): never "no credit yet"; only OpenAI documents that new credit can take minutes.
    case "no-credit": return problem(`${preset ? `Your ${w.name} account` : "Your account with the AI company"} has no credit left, or has reached a spending limit. Add credit or raise the limit on their billing page, then press Check this key again.${p === "openai" ? " If you just added credit, this can take a few minutes." : ""}`,
      page(`Open ${w.their} billing page`, "billing"), true);
    // Contract 14: OpenAI says the account must belong to an organization first.
    case "needs-organization": return problem(p === "openai"
      ? "Your OpenAI account isn't set up to use keys yet. On OpenAI's site, finish creating or joining an organization, then press Check this key again."
      : `${preset ? `Your ${w.name} account` : "Your account with the AI company"} isn't set up to use keys yet. On ${w.their} site, finish setting it up, then press Check this key again.`,
      page(`Open ${w.their} settings`, "settings"), true);
    // Review F2: Google's free plan isn't offered in this country.
    case "needs-billing": return problem(p === "gemini"
      ? "Google's free plan isn't offered in your country. Turn on billing for this project, then press Check this key again."
      : `${w.Name} needs billing turned on for this account. Turn it on, then press Check this key again.`, page(`Open ${w.their} billing page`, "billing"), true);
    case "unreachable": return problem(`Ozzie couldn't reach ${w.name} just now. Check that this Mac is online, then try again. Your key wasn't saved yet.`, null, true);
    // Another AI company has no handoff to a preset: the sentence says where to go instead (re-check Low).
    // A key of a company Ozzie recognises but doesn't offer as a card (native re-check Low 3): only through Another AI company.
    case "wrong-kind": return isOtherAi(looksLike)
      ? problem(p === "other" ? "That doesn't look like a whole key. A key is one long line with no spaces. Copy it again."
        : `This looks like ${aKey(looksLike)}, not ${aKey(p)}. To use it, go back, choose ${COMPANIES.other}, and give ${OTHER_AI[looksLike].name}'s address.`)
      : looksLike && p === "other"
      ? problem(`This looks like ${aKey(looksLike)}. Go back, choose ${COMPANIES.card(looksLike)}, and paste it there.`)
      : looksLike && looksLike !== p
      ? problem(`This looks like ${aKey(looksLike)}, not ${aKey(p)}.`, { label: `Use it with ${COMPANY[looksLike].company}`, useOther: looksLike })
      : problem("That doesn't look like a whole key. A key is one long line with no spaces. Copy it again.");
    case "not-a-key": return problem("That doesn't look like a whole key. A key is one long line with no spaces. Copy it again.");
    // Another service's secret (a GitHub or Slack token, a Stripe or AWS key): refused before it was sent anywhere (native NM2).
    case "not-an-ai-key": return problem(`This doesn't look like ${aKey(p)}. Nothing was sent. Copy the key from ${preset ? `${w.their} keys page` : "the company's website"}, then paste it here.`,
      page(`Open ${w.their} keys page`, "keys"));
    // OpenAI: a project limited to some models (verify-openai.md).
    case "model-unavailable": if (p === "openai") return problem("This key's project can't use the model Ozzie asks for. In OpenAI's settings, allow all models for the project, or make a key in the default project.",
      page("Open OpenAI's settings", "settings"), true);
      return problem(`This key works, but this ${w.name} account can't use the AI model Ozzie needs yet. New accounts sometimes need a day, or a verified organization on ${w.their} page.`, page(`Open ${w.their} settings`, "settings"), true);
    case "slow-down": return problem(`${w.Name} asked Ozzie to wait. Try again in a minute.`, null, true);
    case "daily-limit": return problem(p === "gemini" ? "This key has used today's free limit. Try again tomorrow, or add billing in Google AI Studio." : `This key has used today's limit at ${w.name}. Try again tomorrow.`, null, true);
    case "not-saved": return problem("The key works, but this Mac didn't let Ozzie keep it. Unlock this Mac, then press Check this key again.", null, true);
    case "empty": return problem(preset ? `Ozzie didn't get a key. Copy the key from ${w.their} keys page, then press Paste my key again.`
      : "Ozzie didn't get a key. Copy the key from the company's website, then press Paste my key again.");
    case "too-many-checks": return problem("Ozzie has checked keys 10 times in the last hour, so it's pausing to be safe. Try again in an hour. Your key wasn't saved yet.");
    // The company refused Ozzie's check request in a way none of the above covers (contract N5): Ozzie's side, not the key's.
    // Anthropic: the key isn't tied to a workspace (contract N5's suggested sentence).
    // Worded generically: Anthropic's own text for it isn't documented (contract 13).
    case "needs-workspace": return problem("Anthropic refused this key for this workspace. Make a new key on Anthropic's keys page and choose a workspace for it.", page("Open Anthropic's keys page", "keys"));
    // Another company's address answered "not found" with nothing about a model: the address is likely wrong; the key wasn't checked.
    case "wrong-address": return problem(`${host || "That address"} answered, but not as an AI service Ozzie can use at that address. Check the address in your AI company's instructions, then try again.`);
    // A company this release's live test hasn't passed (decision 19): native refuses it whatever the key.
    case "not-verified-yet": return problem(`${w.Name} isn't ready in Ozzie yet. Choose another company, or AI on this Mac.`);
    case "failed": return problem(`${w.Name} didn't take Ozzie's check just now, so your key wasn't saved. This is on Ozzie's side, not your key's. Try again later, or see Check my setup.`, null, true);
    // Native's re-check of each company's docs (2026-11-17). None of these says the key wasn't accepted.
    // Another AI company: native names whose administrator's key it is (review L-3a), so the right company's page is named.
    case "admin-key": return !preset
      ? problem(looksLike && !isOtherAi(looksLike)
        ? `That's ${aKey(looksLike).replace(/ key$/u, " admin key")}. It can't be used for AI requests. Make a regular key on ${COMPANY[looksLike].company}'s keys page.`
        : "That's an admin key. It can't be used for AI requests. Make a regular key on the keys page of the company that made it.")
      : problem(`That's an admin key. It can't be used for AI requests. Make a regular key on ${w.their} keys page.`, page(`Open ${w.their} keys page`, "keys"));
    // Anthropic's sign-in token (`sk-ant-oat`, `sk-ant-sid`): a whole token, not a key cut short (review L-3b). Never sent.
    case "sign-in-token": return problem("That's a sign-in token from Claude, not a key for apps. Nothing was sent. Make a key on Anthropic's keys page, then paste it here.",
      p === "anthropic" ? page("Open Anthropic's keys page", "keys") : null);
    // The key worked, but another choice of AI was made while it was checked: nothing switched, nothing kept (review M-2).
    case "choice-changed": return problem(`The key works, but you chose something else while Ozzie was checking it, so Ozzie didn't switch to ${w.name} and didn't keep the key. To use it, paste it again.`);
    case "region": return problem(`${w.Name} isn't available from where this Mac connects. If you use a VPN, turn it off and try again.`, null, true);
    case "restricted-key": return problem("This key is limited and can't ask for answers. Make a new key and leave its permissions on All.", page(`Open ${w.their} keys page`, "keys"));
    case "provider-busy": return problem(`${w.Name} is busy right now. Your key was not checked. Try again in a minute.`, null, true);
    case "needs-project-setup": return problem(p === "gemini"
      ? "Google needs you to finish setting up this project before the key works. Open Google's API keys page and follow what it asks."
      : `${w.Name} needs you to finish setting up your account before the key works. Open ${w.their} keys page and follow what it asks.`, page(`Open ${w.their} keys page`, "keys"), true);
    // Review F3: Google may issue only this kind of key now, so the ways on are another company or this Mac.
    case "auth-conflict": return { ...problem(p === "gemini"
      ? "Google didn't accept this kind of key at the address Ozzie uses. For now, choose another company, or AI on this Mac."
      : `${w.Name} didn't accept this kind of key at the address Ozzie uses. For now, choose another company, or AI on this Mac.`), elsewhere: true };
    // Only if native's own question about a Google key of an unknown shape was skipped (contract 13): nothing was sent.
    case "confirm-unknown-shape": return problem(p === "gemini"
      ? "This doesn't look like the Google keys Ozzie knows, so it wasn't sent. Copy the key from Google's API keys page and try again."
      : `This doesn't look like ${aKey(p)}, so it wasn't sent. Copy the key from ${preset ? `${w.their} keys page` : "the company's website"} and try again.`, page(`Open ${w.their} keys page`, "keys"));
    // "Use the key already on this Mac", but none is kept for this company any more (removed in Keychain Access, say).
    case "no-kept-key": return problem(`There's no ${w.name} key on this Mac any more. Make one on ${w.their} keys page, then press ${KEY.paste}.`, page(`Open ${w.their} keys page`, "keys"));
    case "cancelled": return null;
    case "unavailable": return problem("Ozzie couldn't check the key just now, so nothing was saved. Try again in a minute.");
  }
}

// ---- S9 AI on this Mac -------------------------------------------------------------------------------------------

/** A model's size as "2.0 GB"; null when the app doesn't say. */
export const sizeText = (bytes: number | null) => bytes === null ? null : `${(bytes / 1e9).toFixed(1)} GB`;
/** A model's name as a person reads it: "llama3.2:latest" as "llama3.2". */
export const modelName = (id: string) => id.replace(/:latest$/u, "");
export const MAC = {
  title: "AI on this Mac",
  looking: "Looking for AI on this Mac…",
  found: (app: LocalApp, n: number) => `Found ${APP_NAME[app]} on this Mac, with ${n} AI model${n === 1 ? "" : "s"} ready.`,
  ollamaClosed: "Ollama is on this Mac but isn't open.",
  openApp: (app: LocalApp) => `Open ${APP_NAME[app]}`,
  /** Without native's own `start_hint` for LM Studio. */
  lmServerOff: "LM Studio is on this Mac, but its server isn't turned on. In LM Studio, turn on its local server, then press Look again.",
  /** With native's `start_hint`, which says how that app's server starts. */
  lmOn: "LM Studio is on this Mac.",
  ollamaNoModels: "Ollama is open but has no AI models yet.",
  lmNoModels: "LM Studio's server is on, but it has no AI models yet. In LM Studio, download a model, then press Look again.",
  nothing: "Ozzie didn't find AI on this Mac.",
  /** After Look again (or "I've opened Ollama") still finds nothing, in the polite status line: the look did happen. */
  stillNothing: "Ozzie still doesn't find AI on this Mac.",
  looked: (at: string | null) => `${at ? `Looked at ${at}.` : "Looked just now."} Ozzie still doesn't find AI on this Mac.`,
  lookAgain: "Look again",
  lookFailed: "Ozzie couldn't look for AI on this Mac just now. Nothing changed. Press Look again.",
  openFailed: (app: LocalApp) => `Ozzie couldn't open ${APP_NAME[app]}. Open it yourself from Applications, then press Look again.`,
  /**
   * Null: native couldn't tell this Mac's memory (`advice` "unknown"), so nothing is said about it. "too-small": no model
   * Ozzie offers fits (an 8 GB Mac: the small model, the only one that fits there, never finished an answer that needed a
   * lookup in Ozzie's tests, 2026-11-18). The large model fits from 32 GB but hasn't been tested with Ozzie.
   */
  memory(advice: LocalAdvice, gb: number): string | null {
    switch (advice) {
      case "unknown": return null;
      case "too-small": return `This Mac has ${gb} GB of memory. AI on this Mac needs a Mac with 16 GB of memory or more.`;
      case "medium": return `This Mac has ${gb} GB of memory: a medium model will work well.`;
      case "large": return `This Mac has ${gb} GB of memory: a medium model will work well. The large one fits too, but it hasn't been tested with Ozzie yet.`;
    }
  },
  /** Under "needs 16 GB or more": the other two ways, each a button (the AI choice's own). */
  tooSmallWays: "You can use a key from an AI company instead, or no AI for now: everything else in Ozzie works without it.",
  useKey: "Use a key from an AI company",
  /** On a Mac too small for the models Ozzie offers, the way for someone who already runs a model of their own. */
  ownStill: "If you already run a model of your own in Ollama or LM Studio, open it, then press Look again.",
  row: (id: string, bytes: number | null) => [modelName(id), sizeText(bytes)].filter(Boolean).join(" · "),
  recommended: "Recommended for this Mac",
  tooBig: "Too big for this Mac's memory",
  check: "Check that it answers",
  /** Under the list: the check needs a model (review M6). */
  pickHint: "Choose a model above, then press Check that it answers.",
  /** Native waits up to two minutes for the first question and one for the second (local_ai.rs). */
  checking: (id: string) => `Asking ${modelName(id)} a test question. This can take up to three minutes…`,
  /**
   * Shown with the person's own Ollama models, before the check: Ollama gives a model 4k by default under 24 GB of
   * graphics memory (its docs), and the check's question didn't fit there (live, 2026-11-18). The setting's name and
   * "8k" are its app's. Never with a model Ozzie set up itself: Ozzie's copy carries its own room.
   */
  ollamaRoom: "Before you check, open Ollama's Settings and set Context length to 8k or more, so it can read a whole question.",
  chosenNotChecked: "Chosen, not checked yet",
  guide: [
    { text: "Download Ollama, a free app that runs AI on your Mac.", button: "Open ollama.com" },
    { text: "Open the downloaded file, move Ollama into Applications, then open it. If your Mac asks whether to open it, choose Open. A small llama picture appears at the top of your screen.", button: "I've opened Ollama" },
  ],
  /**
   * Step 3 of the install guide, and Ollama open with no models in a build whose native side offers no models of its
   * own: once Ollama answers, Ozzie offers the model that suits this Mac and downloads it (owner's request, 2026-11-18).
   */
  getModel: (bytes: number | null) => `Then press Look again. Ozzie offers the model that suits this Mac${bytes ? ` (about ${sizeText(bytes)})` : ""}, downloads it from Ollama's library and sets it up for you.`,
  /** An Ask on a 16 GB Mac with qwen3:8b took 22 seconds for a small church's facts and 52 for a larger church's (2026-11-18). */
  honest: "AI on this Mac is private and free. It is slower than an AI company's, an answer can take a minute, and its answers are simpler. Ozzie works the same either way.",

  // ---- Models Ozzie downloads and sets up itself (owner's request, 2026-11-18; contract N6 "Download and set up") ----
  setupLede: "Ozzie can download a model that suits this Mac and set it up for you.",
  /** "Medium, 5.2 GB": the size word and the download's size, from native. */
  catalogueRow: (size: ModelSize, bytes: number) => `${SIZE_WORD[size]}, ${sizeText(bytes)}`,
  onThisMac: "On this Mac",
  needsSpace: "Not enough free space",
  /** A model Ozzie set up or downloaded before it stopped offering it (providers.json `offered`): shown only to remove it. */
  notOffered: "Not offered any more",
  /** Settings › AI help, when AI on this Mac is a model Ozzie no longer offers (native status `not_offered`, review L-4). */
  notOfferedInUse: (id: string | null) => `Ozzie no longer sets up ${id ? modelName(id) : "this model"}: in Ozzie's tests it never finished an answer that needed one of Ozzie's lookups. Ozzie keeps using it until you choose another model or another way to use AI.`,
  notOfferedLine: (id: string) => `Ozzie no longer sets up ${modelName(id)}: in Ozzie's tests it never finished an answer that needed one of Ozzie's lookups. You can remove it from this Mac.`,
  /** The chosen model isn't on this Mac yet: what happens, how long for its size (`downloadTime`), and that nothing about the church goes. */
  willDownload: (id: string, bytes: number) => `It downloads ${modelName(id)} (${sizeText(bytes)}) from Ollama's library onto this Mac, then sets it up and checks that it answers. On a typical church connection this takes ${downloadTime(bytes)}, longer on slow Wi-Fi. Nothing about your church is sent.`,
  /** It is on this Mac already: no download. */
  willSetUp: (id: string) => `${modelName(id)} is already on this Mac. Ozzie sets it up with room for longer questions, then checks that it answers. Nothing about your church is sent.`,
  /** Native's free space where Ollama keeps models, when a model doesn't fit there (`DISK_HEADROOM`: 3 GB). */
  space: (freeBytes: number) => `Ollama's folder on this Mac has ${sizeText(freeBytes)} free. A model needs its own size and about 3 GB more, so your Mac keeps room to work.`,
  download: "Download and set up",
  setUp: "Set up",
  stop: "Stop the download",
  /** Closing the window hides it; Ozzie keeps running in the menu bar (always_on.rs), and the download with it. */
  keepsGoing: "You can close this window: Ozzie keeps downloading while it runs in the menu bar. Quitting Ozzie stops the download.",
  /** The polite status line, one per step (never per byte, so a screen reader hears each step once). */
  step(phase: ModelPhase, id: string): string {
    const m = modelName(id);
    switch (phase) {
      case "starting": return `Starting the download of ${m} from Ollama's library…`;
      case "downloading": return `Downloading ${m}…`;
      case "verifying": return `Downloaded. Ollama is making sure every part of ${m} arrived whole…`;
      case "finishing": return `Downloaded. Ollama is putting ${m} in place…`;
      case "setting-up": return `Setting up ${m} with room for Ozzie's longer questions…`;
      case "checking": return MAC.checking(id);
    }
  },
  /** Under the bar: "1.2 of 5.2 GB downloaded". */
  amount: (done: number, total: number) => `${(done / 1e9).toFixed(1)} of ${sizeText(total)} downloaded`,
  progressLabel: (id: string) => `Downloading ${modelName(id)}`,
  // Removing (only Ozzie's copy, and the model when Ozzie downloaded it).
  remove: "Remove this model from this Mac",
  removeTitle: (id: string) => `Remove ${modelName(id)} from this Mac?`,
  /**
   * "Up to": Ollama deletes only the files no other model of the person's uses (its source, `RemoveNamed`), so less is
   * freed when one shares them (review L-7). Ozzie's copy is said plainly as the version it set up.
   */
  removeBody: (id: string, ozzieDownloaded: boolean, bytes: number) => ozzieDownloaded
    ? `Ozzie deletes ${modelName(id)}, which it downloaded, and the version of it Ozzie set up for longer questions. This frees up to ${sizeText(bytes)}. If Ozzie uses it now, Ozzie stops using AI.`
    : `Ozzie deletes the version of ${modelName(id)} it set up for longer questions. ${modelName(id)} itself stays in Ollama, because Ozzie didn't download it. If Ozzie uses it now, Ozzie stops using AI.`,
  removeYes: "Remove it from this Mac",
  removeKeep: "Keep it",
  /** Ollama lists other models the person brought: the way to them, under the three. */
  yourModels: "Or use a model you already have",
} as const;
/** The size words the catalogue's rows lead with. */
const SIZE_WORD: Readonly<Record<ModelSize, string>> = Object.freeze({ small: "Small", medium: "Medium", large: "Large" });
/**
 * How long a download takes, honestly for its size (review L-7): plain arithmetic at a modest church connection of 50
 * megabits a second reaching this Mac (assumed, about 6 MB a second), rounded up to five minutes. 2.5 GB is about 10
 * minutes, 5.2 GB about 15, 13.8 GB about 40; an hour or more is said so.
 */
export function downloadTime(bytes: number): string {
  const minutes = Math.max(5, Math.ceil(bytes * 8 / 50e6 / 60 / 5) * 5);
  return minutes >= 60 ? "an hour or more" : `about ${minutes} minutes`;
}
/**
 * How a download ended, other than "done" (whose words are the check's, `localSaid`). `complete`: the job ended at
 * setting up (a Stop that landed after Ollama said success: the model is on this Mac, only not set up; review L-5).
 * Every byte having come isn't enough: Ollama still checks the files and writes the manifest then (review L-1).
 */
export function downloadSaid(end: Exclude<ModelEnd, "done">, id: string, complete = false): string {
  const m = modelName(id);
  switch (end) {
    case "cancelled": return complete
      ? `The download had already finished when Stop was pressed, so ${m} is on this Mac but not set up yet. Press Set up to finish.`
      // Ollama's docs: "Cancelled pulls are resumed from where they left off".
      : "The download is stopped. Ollama keeps what came so far, so pressing Download and set up again picks up from there.";
    case "no-space": return "This Mac ran out of space for the download. Free up some space, or choose a smaller model, then press Download and set up again.";
    case "offline": return "Ollama couldn't reach its library. Check that this Mac is online, then press Download and set up again.";
    case "not-found": return `Ollama's library doesn't have ${m} just now. Choose another model.`;
    case "stopped": return "Ollama stopped answering, so the download stopped. Open Ollama, then press Download and set up again.";
    case "stalled": return "The download hasn't moved for two minutes, so Ozzie stopped it. Check this Mac's internet connection, then press Download and set up again. Ollama picks up where it left off.";
    case "failed": return "Ollama couldn't finish the download. Press Download and set up again in a minute.";
    // Ollama's create in its current shape is from 0.5.5; an older Ollama refuses it.
    case "not-set-up": return `${m} is on this Mac, but Ozzie couldn't set it up. This Ollama may be too old: download the latest from ollama.com, then press Set up.`;
  }
}
/**
 * A download and set-up that ended while no AI on this Mac screen was open (the person pressed Back, or closed the
 * window as the screen says they can): one line on Today (review M-1). Null for a Stop, which only that screen can press.
 */
export function endedAwaySaid(end: ModelEnd, verdict: LocalVerdict | null, id: string): { text: string; ok: boolean } | null {
  const m = modelName(id);
  if (end === "cancelled") return null;
  if (end === "done" && verdict === "answers") return { ok: true, text: `${m} is downloaded and set up, and it answered Ozzie's check. Ozzie uses AI on this Mac now. Nothing leaves this Mac.` };
  if (end === "done" && verdict === "choice-changed") return { ok: true, text: `${m} is downloaded and set up on this Mac, but you chose another way to use AI since, so Ozzie didn't switch to it.` };
  return { ok: false, text: `Setting up ${m} on this Mac didn't finish. Open AI on this Mac to see why.` };
}
export const ENDED_AWAY = { open: "Open AI on this Mac", close: "Close" } as const;
/** Why "Download and set up" couldn't start. */
export function refusedSaid(refusal: DownloadRefusal): string {
  switch (refusal) {
    case "busy": return "Ozzie is already downloading a model. Wait for it to finish, or stop it first.";
    case "not-running": return "Ollama isn't answering just now. Open Ollama, then press Look again.";
    case "too-big": return "That model is too big for this Mac's memory. Choose a smaller one.";
    case "no-room": return "This Mac doesn't have enough free space for that model. Free up some space, or choose a smaller one.";
    case "not-offered": return "Ozzie doesn't set up that model any more. Choose another one.";
    case "not-in-catalogue":
    case "unavailable": return "Ozzie couldn't start the download just now. Nothing changed. Try again in a minute.";
  }
}
/** How removing ended. `routeCleared`: AI on this Mac was that model, so Ozzie won't use AI now. */
export function removedSaid(removed: ModelRemoved, id: string, routeCleared: boolean): { text: string; ok: boolean } {
  switch (removed) {
    case "removed": return { ok: true, text: `${modelName(id)} is removed from this Mac.${routeCleared ? " Ozzie won't use AI now." : ""}` };
    case "none": return { ok: true, text: `There was nothing of Ozzie's to remove for ${modelName(id)}.${routeCleared ? " Ozzie won't use AI now." : ""}` };
    case "stopped": return { ok: false, text: "Ollama isn't answering, so nothing was removed. Open Ollama, then try again." };
    case "failed": return { ok: false, text: "Ollama didn't remove all of it just now. Open Ollama, then try again." };
    case "busy": return { ok: false, text: "Wait for the download to finish, then try again." };
  }
}
/**
 * What "Check that it answers" found (spec S9, plus the contract's "too-slow", "not-found" and "unavailable"). `smallRoom`:
 * native's `small_room` on "answers" (B-2): the success stands, and `advice` says how to give the model more room, in
 * the words of `small-context`.
 */
export function localSaid(verdict: LocalVerdict, app: LocalApp, id: string, day: string, seconds?: number, smallRoom = false): { lines: string[]; tone: "ok" | "problem"; advice?: string } {
  const problem = (text: string) => ({ lines: [text], tone: "problem" as const });
  switch (verdict) {
    case "answers": return { tone: "ok", lines: [
      seconds === undefined ? "It answers." : `It answers. A typical answer took ${seconds} second${seconds === 1 ? "" : "s"} on this Mac.`,
      `Ozzie will use ${modelName(id)} on this Mac. Nothing leaves this Mac.`],
      ...(smallRoom ? { advice: app === "ollama"
        ? "Ollama gives this model less room than Ozzie's longer questions need, so those could be cut short. To give it room, set Context length to 8k or more in Ollama's Settings."
        : "LM Studio gives this model less room than Ozzie's longer questions need, so those could be cut short. To give it room, in LM Studio's My Models, press the gear next to this model, set its context length to 8192 or more, then load the model again." } : {}) };
    case "no-tools": return problem(`It answered, but it can't use Ozzie's lookups, so it can't answer questions about ${day}. Choose another model.`);
    // The app said it gave the model room for the whole question, and the model still missed its start.
    case "lost-start": return problem(`It answered, but it lost the start of the question, so it can't hold everything about ${day} on this Mac. Choose a larger model, or a key from an AI company.`);
    // Too little room in the app (or the app didn't say): its own setting is the fix (Ollama's and LM Studio's docs).
    case "small-context": return problem(app === "ollama"
      ? "It lost the start of the question. Ollama keeps only the end of a question longer than its context length. In Ollama's Settings, set Context length to 8k or more, then press Check that it answers again. Or choose a key from an AI company."
      : "It didn't get the whole question. LM Studio gives a model only as much of a question as its context length allows. In LM Studio's My Models, press the gear next to this model, set its context length to 8192 or more, load the model again, then press Check that it answers again. Or choose a key from an AI company.");
    case "thinks-too-long": return problem(`It spent its whole answer thinking and never finished, so it would be too slow for questions about ${day} on this Mac. Choose another model, or a key from an AI company.`);
    // Asked for the check word, it used the lookup instead (review M2): whether it read the whole question is unknown.
    // Choosing another model leads (review L-5): the same model asked again often answers the same way.
    case "lookup-instead": return problem(`It used one of Ozzie's lookups when asked for a single word, so Ozzie couldn't tell whether it can hold everything about ${day} on this Mac. Choose another model, or press Check that it answers again.`);
    // `seconds` comes with too-slow only when the first question was answered (two minutes) and the second wasn't (one).
    case "too-slow": return problem(`${seconds === undefined ? "It didn't answer within two minutes." : "It answered the first question, but didn't answer the second within a minute."} This Mac may be too busy, or the model too large for it. Try again when this Mac is less busy, or use a key from an AI company.`);
    case "stopped": return problem(`${APP_NAME[app]} stopped answering. Open ${APP_NAME[app]}, then try again.`);
    case "not-found": return problem(`${APP_NAME[app]} doesn't list that model any more. Press Look again, then choose a model.`);
    // It answered, but another choice of AI was made while it was checked: Ozzie didn't switch to it (review M-2).
    case "choice-changed": return problem(`${modelName(id)} answers, but you chose something else while Ozzie was checking it, so Ozzie didn't switch to it. To use it, press Check that it answers again.`);
    case "unavailable": return problem("Ozzie couldn't check AI on this Mac just now. Nothing changed. Try again in a minute.");
  }
}

// ---- S10 Ozzie's AI ----------------------------------------------------------------------------------------------

export const OZZIE = {
  title: "Ozzie's AI",
  body: "AI that's ready to use, with nothing to set up.",
  plan: (price: string) => `Personal · ${price}`,
  answers: (answers: string) => `${answers}. Asking Ozzie who could help with a role is one answer.`,
  checks: [
    "When the month's answers run out, AI pauses until the next month. Everything else in Ozzie keeps working, and nothing extra is charged.",
    "Cancel any time. Payments aren't refunded, except where the law requires. When you cancel, Ozzie's AI keeps working until the end of the month you've paid for.",
    "Every request goes only to AI services that keep nothing, and never with the names Ozzie reads from Planning Center.",
    "For one person, on up to 3 of their Macs. Plans for teams are coming.",
  ],
  pay: (price: string) => `Pay ${price} in my browser`,
  small: "You'll sign in with your email (no password) and pay on Stripe's page. Paying means you agree to the terms.",
  terms: "Read the terms",
  closed: "Ozzie's AI isn't open for sign-up yet. The free ways work today.",
  unreachable: "Ozzie couldn't check whether Ozzie's AI is open just now. The free ways work today.",
  waitTitle: "Waiting for you in your browser",
  /** After paying, the website asks once more before this Mac is connected (its "Payment received" page, "Connect this Mac"). */
  waitLede: "Finish in your browser: after paying, choose Connect this Mac.",
  waitSteps: ["Type your email, then the code Ozzie's website emails you.", "Pay on Stripe's page.", "On the page that says Payment received, choose Connect this Mac. Ozzie's AI turns on here by itself."],
  /** Paid but the tab was closed before Connect this Mac, or the site said it couldn't confirm the payment (its account page). */
  waitHelpTitle: "Paid, but the page is gone?",
  waitHelp: "Paid, but closed the page before choosing Connect this Mac, or Ozzie's website said it couldn't confirm the payment? Wait until your account page shows Personal (usually a few minutes), then press Open the page again and choose Connect this Mac. You won't be charged again.",
  openAgain: "Open the page again",
  cancel: "Cancel",
  stillThere: "Still there? Ozzie waits about 5 more minutes.",
  /** "Ozzie's AI is on. About 400 answers this month; it starts again on December 17." from the offer and the account. */
  on(answers: string | null, day: string | null): string {
    const month = answers ? answers.replace(/ a month$/u, " this month") : null;
    return month && day ? `Ozzie's AI is on. ${month}; it starts again on ${day}.` : month ? `Ozzie's AI is on. ${month}.` : "Ozzie's AI is on.";
  },
  received: "Payment received. Turning on Ozzie's AI…",
  receivedSlow: "Your payment went through, but Ozzie's AI isn't on yet. This can take a few minutes; Ozzie keeps checking.",
  /** After 30 minutes of reading the account, Ozzie stops and says so (re-check Low). */
  receivedStopped: "Ozzie stopped checking after 30 minutes. If you finished paying, press Check again.",
  /** The quiet way on while the plan is applied (review M4): Ozzie goes on reading the account after this screen closes. */
  carryOn: (where: string) => `${where} (Ozzie keeps checking)`,
  checkAgain: "Check again",
  tryAgain: "Try again",
  another: "Choose another way",
  cancelledLine: "No payment was taken.",
  // S10d
  seePlan: "See my plan",
  updateCard: "Update my card in my browser",
  paymentFailed: "Ozzie's AI is off because the last payment didn't go through. Everything else still works.",
  ended: (day: string | null) => day ? `Ozzie's AI ended on ${day}. Everything else in Ozzie keeps working.` : "Ozzie's AI has ended. Everything else in Ozzie keeps working.",
  startAgain: "Start it again",
  start: "Start Ozzie's AI",
  reconnect: "This Mac's connection to Ozzie's AI has ended, so it's off on this Mac. Connect again to keep using it; an account that already has a plan isn't charged again.",
  connectAgain: "Connect this Mac again in my browser",
  notConnected: "Ozzie's AI is chosen, but this Mac isn't connected to it yet. Everything else in Ozzie still works.",
  notKnown: "This Mac is connected. Ozzie couldn't check this month's answers just now.",
  disconnect: "Disconnect this Mac",
  stop: "Stop paying for Ozzie's AI",
  stopTitle: "Stop paying for Ozzie's AI?",
  stopBody: (day: string | null) => `Cancelling stops the next payment. Ozzie's AI keeps working until ${day ?? "the end of the month you've paid for"}. What's been paid isn't refunded, except where the law requires.`,
  stopYes: "Cancel it in my browser",
  stopKeep: "Keep Ozzie's AI",
  /** A page on Ozzie's website that the browser couldn't open: the address to type instead. */
  browserFailed: (address: string) => `Your browser didn't open. Go to ${address} in your browser.`,
} as const;
/**
 * How a paid connect ended, in the app (spec S10c, plus the contract's other closed codes). Every ending also offers
 * "Choose another way" (review M4). The plan may not be on the account yet when a payment has just gone through, so
 * nothing here says it is: the person waits until the account page shows it (review M10).
 */
export function paidSaid(end: PaidEnd): string {
  const paidAlready = "If you finished paying, wait until your account page shows Personal, then press Try again and choose Connect this Mac. You won't be charged again.";
  switch (end) {
    // Stripe's back button or the site's "No payment was taken": nothing was paid.
    case "payment-cancelled": return "No payment was taken, and nothing changed.";
    // Cancelled here, or "Don't connect" on the site: payment may already have gone through, so it says what is still true.
    case "cancelled": return `This Mac isn't connected to Ozzie's AI. ${paidAlready}`;
    case "expired": return `Ozzie stopped waiting. ${paidAlready}`;
    // A paid connect that heard nothing back in its 30 minutes (contract N7): never "couldn't reach" (review M2).
    case "not-finished": return `Ozzie stopped waiting after 30 minutes. ${paidAlready}`;
    case "browser-unavailable": return "Your browser didn't open. Press Try again. If nothing happens, choose a default web browser in System Settings › Desktop & Dock, then try again.";
    case "busy": return "Ozzie was already waiting for you in your browser. Press Try again to start fresh.";
    case "refused": return `Ozzie's website didn't accept that sign-in, so this Mac isn't connected yet. ${paidAlready}`;
    case "keychain": return `This Mac didn't let Ozzie keep the connection. Unlock this Mac (type your Mac password if it asks). ${paidAlready}`;
    case "unreachable": return `Ozzie couldn't reach its website just now. Check that this Mac is online. ${paidAlready}`;
  }
}
/** Ozzie's AI's state in Settings (spec S10d), from the account and why it has no plan. */
export type OzzieState = { kind: "on" | "near" | "paused" | "payment-failed" | "ended" | "no-plan"; text: string };
/** `now` and `zone` place a pause's end (`paused_until`) on this Mac's clock; both default to this Mac's. */
export function ozzieState(a: ManagedAccount, reason: "payment-failed" | "cancelled" | "none" | null, now = Date.now(), zone?: string): OzzieState {
  if (noPlan(a)) {
    if (reason === "payment-failed") return { kind: "payment-failed", text: OZZIE.paymentFailed };
    if (reason === "cancelled") return { kind: "ended", text: OZZIE.ended(resetDay(a)) };
    return { kind: "no-plan", text: NO_PLAN_TEXT };
  }
  const day = resetDay(a);
  if (paused(a)) return { kind: "paused", text: day ? `Ozzie's AI is paused until ${day}: this month's answers are used. Everything else in Ozzie still works.`
    : "Ozzie's AI is paused: this month's answers are used. Everything else in Ozzie still works." };
  // Paused before the month is used (the account's own daily ceiling): until when, from the account, never "in a minute".
  const when = pausedWhen(a, now, zone);
  if (when) return { kind: "paused", text: pausedLine(when) };
  if (a.warning === "three-quarters" || a.warning === "nine-tenths") {
    const part = a.warning === "three-quarters" ? "three quarters" : "nine tenths";
    return { kind: "near", text: `Ozzie's AI has used about ${part} of this month's answers. When they run out, AI pauses until ${day ?? "next month"}. Everything else keeps working, and nothing extra is charged.` };
  }
  const n = answersLeft(a);
  return { kind: "on", text: `${n === 1 ? "About 1 answer" : `About ${n} answers`} left this month.${day ? ` They start again on ${day}.` : ""}` };
}

// ---- The own key's monthly limit (spec S8, "The monthly limit") ----------------------------------------------------

/** "OpenAI, Anthropic and Google": the companies in the cards' order, then any other as "another AI company". */
function keptNames(kept: readonly KeyProvider[]): string {
  const others = kept.filter(p => p === "other").length;
  const names = [...(Object.keys(COMPANY) as Company[]).filter(c => kept.includes(c)).map(c => COMPANY[c].company),
    ...(others === 1 ? ["another AI company"] : others > 1 ? ["other AI companies"] : [])];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");
}

export const LIMIT = {
  used: (used: number, limit: number, resets: string | null) =>
    `${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} AI requests used this month.${resets ? ` The count starts again on ${resets}.` : ""}`,
  paused: (resets: string | null) => monthLimitText(resets),
  change: "Change the limit",
  label: "AI requests a month",
  help: "From 100 to 20,000. 1,000 requests is about 300 answers.",
  save: "Save the limit",
  keep: "Keep the limit",
  invalid: "Choose a number from 100 to 20,000.",
  failed: "Ozzie couldn't save the limit just now. Nothing changed. Try again.",
  /** Settings' own way to remove the church's key (contract N5 `remove_own_key`), apart from "No AI for now". */
  remove: "Remove my key from this Mac",
  /** The same, when more than one company's key is kept (review L-4; seen live with OpenAI and Anthropic kept). */
  removeMany: "Remove my keys from this Mac",
  removeTitle: "Remove the key from this Mac?",
  /** `inUse`: the church's own key is the AI Ozzie uses now, so AI stops with it; otherwise what Ozzie uses doesn't change. */
  removeBody: (p: KeyProvider, inUse: boolean) => inUse
    ? `Ozzie forgets the key and stops using AI. To use ${p === "other" ? "the company" : COMPANY[p].company} again later, you'll paste a key again.`
    : "Ozzie forgets any key of your church's that it kept on this Mac. To use an AI company later, you'll paste a key again.",
  removeYes: "Yes, remove the key",
  removeKeep: "Keep my key",
  removed: "The key is removed from this Mac.",
  // More than one company's key is kept: removing takes every one of them, so each word says so (live, 2026-11-18).
  removeTitleMany: "Remove your keys from this Mac?",
  removeBodyMany: (kept: readonly KeyProvider[], inUse: boolean) =>
    `Ozzie forgets the keys for ${keptNames(kept)}${inUse ? " and stops using AI" : ""}. To use one again later, you'll paste a key again.`,
  removeYesMany: "Yes, remove the keys",
  removeKeepMany: "Keep my keys",
  removedMany: "The keys are removed from this Mac.",
  removeNone: "There's no key on this Mac.",
  removeRefused: "This Mac didn't let Ozzie remove the key. Unlock this Mac, then try again. Nothing else changed.",
  removeFailed: "This Mac didn't let Ozzie remove the key just now. Unlock this Mac, then try again.",
  noKey: (p: KeyProvider) => `Ozzie doesn't have ${p === "other" ? "the company's" : `${COMPANY[p].company}'s`} key on this Mac yet, so AI is off.`,
  oldKey: "A key saved the old way, in Terminal, isn't tied to the company's address, so Ozzie doesn't use it. Paste the key here instead and Ozzie keeps it safely on this Mac.",
  addKey: "Paste my key",
  localNotChecked: "AI on this Mac is chosen, but Ozzie hasn't checked that it answers yet.",
  localChecked: (at: string) => `Answered Ozzie's check on ${at}. Nothing leaves this Mac.`,
  checkLocal: "Check that it answers",
  // "No AI for now" from Settings (contract N5 `set_no_ai`): no route, and what stays on this Mac or on the account.
  /** `many`: more than one company's key is kept, so it agrees with "Remove my keys from this Mac" beside it (live, 2026-11-18). */
  noneOwn: (many: boolean) => many
    ? "Ozzie won't use AI now. Your keys are still on this Mac. To remove them, choose Remove my keys from this Mac."
    : "Ozzie won't use AI now. Your key is still on this Mac. To remove it, choose Remove my key from this Mac.",
  noneLocal: "Ozzie won't use AI now. Nothing was removed from this Mac.",
  noneOzzie: "Ozzie won't use AI now. Your plan for Ozzie's AI isn't cancelled: to stop paying for it, choose See my plan.",
  /** After a key from another company works: the earlier key stays until removed (contract item 10). */
  earlierKey: (p: KeyProvider) => `Your ${p === "other" ? "earlier AI company's" : COMPANY[p].company} key is still kept on this Mac. You can remove it in Settings.`,
} as const;
export const monthDay = (s: ModelStatus) => s.month ? calendarDay(s.month.resets_on) : null;

// ---- §4.4 The AI line --------------------------------------------------------------------------------------------

/** The model on this Mac, from native's fixed local label "AI model on this Mac (llama3.2:latest)": a model id only. */
export const localModel = (label: string): string | null => /^AI model on this Mac \(([\w.:/@+-]{1,120})\)$/u.exec(label)?.[1] ?? null;
/** "AI: ChatGPT, your key" and its trouble, if any: " · paused", " · not answering", " · not checked yet". */
export function aiLine(status: ModelStatus | null, now = Date.now()): { text: string; trouble: "paused" | "not answering" | "not checked yet" | "not offered any more" | null } {
  if (!status || status.route === "none" || !["own", "managed", "local"].includes(status.route)) return { text: "AI: none", trouble: null };
  if (status.route === "own") {
    const p = status.provider && Object.hasOwn(COMPANY, status.provider) ? status.provider : null;
    const text = `AI: ${p ? COMPANY[p].product : "another AI company"}, your key`;
    return { text, trouble: status.setup === "month-limit" ? "paused" : status.configured && status.setup === "ready" ? null : "not answering" };
  }
  if (status.route === "managed") {
    const a = status.account;
    const trouble = status.managed !== "connected" || !status.configured ? "not answering"
      : a && (noPlan(a) || paused(a) || pausedWhen(a, now) !== null) ? "paused" : null;
    return { text: "AI: Ozzie's AI", trouble };
  }
  const id = localModel(typeof status.label === "string" ? status.label : "");
  return { text: id ? `AI: on this Mac (${modelName(id)})` : "AI: on this Mac",
    // A model Ozzie no longer offers keeps working; the line says so in its row's words (review L-4).
    trouble: status.setup === "not-checked" ? "not checked yet" : !(status.configured && status.setup === "ready") ? "not answering"
      : status.not_offered ? "not offered any more" : null };
}
export const LINE = { change: "Change", check: "Check" } as const;
