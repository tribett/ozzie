import { invoke } from "@tauri-apps/api/core";
export type UserInfoReason = "transport-failure" | "access-denied" | "provider-failure" | "invalid-json" | "organization-id-missing" | "organization-id-invalid" | "unclassified";
export type OrganizationDiagnostic = { version: 1 } & (
  { stage: "userinfo"; reason: UserInfoReason } |
  { stage: "organization-binding"; reason: "organization-mismatch" }
);
/**
 * What the saved connection was granted (native `Scopes::label`): Services alone (the default) or also Calendar, People and
 * Groups, then whether Check-Ins and Registrations were each granted too. Read it through `granted`.
 */
export type ConnectionScopes = `${"services" | "services-and-operations"}${"" | "+check-ins"}${"" | "+registrations"}`;
/** The products a checked connection was granted; null until the connection has been checked this session (or an unknown spelling). */
export function granted(status: Pick<ConnectionStatus, "scopes"> | null | undefined): { operations: boolean; checkIns: boolean; registrations: boolean } | null {
  const scopes: unknown = status?.scopes;
  if (typeof scopes !== "string") return null;
  const [base, ...more] = scopes.split("+");
  const canonical = `${base}${more.includes("check-ins") ? "+check-ins" : ""}${more.includes("registrations") ? "+registrations" : ""}`;
  if ((base !== "services" && base !== "services-and-operations") || canonical !== scopes) return null;
  return { operations: base === "services-and-operations", checkIns: more.includes("check-ins"), registrations: more.includes("registrations") };
}
/** Calendar, People and Groups were all granted. */
export const operationsGranted = (status: Pick<ConnectionStatus, "scopes"> | null | undefined) => granted(status)?.operations === true;
/** Check-Ins and Registrations, each asked for only when the person chooses it. */
export interface MoreProducts { checkIns?: boolean; registrations?: boolean }
/** The Check-Ins and Registrations choices a connection already has, so changing another choice keeps them. */
export const moreOf = (status: Pick<ConnectionStatus, "scopes"> | null | undefined): MoreProducts => {
  const g = granted(status);
  return { checkIns: g?.checkIns === true, registrations: g?.registrations === true };
};
const moreArgs = (more: MoreProducts) => ({ ...(more.checkIns ? { checkIns: true } : {}), ...(more.registrations ? { registrations: true } : {}) });
export type ConnectionStatus = {
  state: "disconnected" | "waiting" | "checking" | "connected" | "stored-unchecked" | "cancelled" | "expired" | "failed";
  organization: string; checked_at_ms: number | null; source: string; problem: unknown;
  organization_diagnostic?: OrganizationDiagnostic;
  /** Present only once this session has verified the saved connection. */
  scopes?: ConnectionScopes;
  /** True when one-click sign-in let Planning Center name this organization. */
  found?: boolean;
  /** "Switch Ozzie to this church?": another church's sign-in is saved on this Mac and waits for an answer. */
  switch?: SwitchQuestion;
  /** Sign-ins the person chose to leave that Ozzie couldn't sign out of yet, each with its reason. */
  unretired?: Unretired;
  /** The church Ozzie uses now, natively; Settings follow it when it changes. */
  in_use?: InUse;
  /** The church's name as Planning Center stated it at this connection's last sign-in or check. Shown only. */
  organization_name?: string;
  /** Native order of statuses: one older than what the page already applied is ignored. */
  revision?: number;
  /**
   * The church the last check asked for (Settings naming it) that Ozzie doesn't use without a new sign-in: native code
   * checked the church it last used instead (review S3, M1).
   */
  declined?: string;
  /**
   * How the last sign-in ended when it didn't connect (cancelled, expired, failed and why) while the church it replaced
   * went back into use; native code keeps it until the next sign-in or check starts (review S4, M1).
   */
  last_attempt?: ConnectionStatus;
  /** The church Ozzie last used, whose sign-in is no longer saved on this Mac; the church in Settings was checked instead. */
  missing?: string;
};
/**
 * Asked natively (core/native-auth connections.rs) after a sign-in Planning Center bound to another church, or about
 * one saved on this Mac from before. `from` stays the church Ozzie uses until the person switches; `others` are every
 * saved sign-in switching signs Ozzie out of. Organization IDs, churches' names as Planning Center stated them, a public
 * client ID (empty for Ozzie's own) and the question's native `id`, which an answer names.
 */
export type SwitchQuestion = {
  id: number; to: string; to_name?: string; from: string; from_name?: string; from_client: string; others: string[]; fresh: boolean;
};
/** "switch" and "stay" for a sign-in the person just made; "stay" and "sign-in" (sign in to that church instead) for one Ozzie found. */
export type SwitchDecision = "switch" | "stay" | "sign-in";
/** "unfinished": Ozzie closed before it finished signing out of it (found again at the next launch). */
export type RetireFailure = "revoke-failed" | "refused" | "locked" | "denied" | "unavailable" | "unfinished";
/** `ozzie_registration`: saved with Ozzie's own registration ("Ozzie for Mac"), or with one typed under Advanced. */
export type LeftBehind = { organization: string; name?: string; reason: RetireFailure; ozzie_registration?: boolean };
export type Unretired = { left: LeftBehind[] };
export type InUse = { organization: string; client_id: string; name?: string };
/** After an answer: the church Ozzie now uses, for Settings (`client_id` empty for Ozzie's own registration). */
export type SwitchAnswer = { status: ConnectionStatus; client_id: string; organization: string };
const ASKED = "ozzie.operations-asked";
/**
 * Whether the last sign-in on this Mac asked for Calendar, People and Groups. A per-device note
 * only, so What happened can tell "Planning Center didn't grant it" from "turned off in Settings".
 */
export const operationsAsked = {
  get: (): boolean => { try { return typeof localStorage !== "undefined" && localStorage.getItem(ASKED) === "1"; } catch { return false; } },
  set: (asked: boolean) => { try { if (typeof localStorage !== "undefined") localStorage.setItem(ASKED, asked ? "1" : "0"); } catch { /* per-device convenience only */ } },
};
const YOUR_NAME = "ozzie.your-name.v1";
export const YOUR_NAME_MAX = 60;
const PLACEHOLDER = "[Your name]";
/** A name as a note can carry it: one line, no invisible or control characters, at most YOUR_NAME_MAX characters. */
export const cleanYourName = (value: string) => value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Co}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, YOUR_NAME_MAX).trim();
/**
 * "Your name for notes" (Settings): kept on this Mac only, in its own place (not with the Church rules, which
 * the AI's facts are built from). It is never sent to an AI: notes are reworded with [Your name] in them, and
 * the name goes in afterwards on this Mac, the way people's names are restored. Empty keeps [Your name].
 */
export const yourName = {
  get: (): string => { try { return typeof localStorage === "undefined" ? "" : cleanYourName(localStorage.getItem(YOUR_NAME) ?? ""); } catch { return ""; } },
  set: (name: string) => {
    try {
      if (typeof localStorage === "undefined") return;
      const clean = cleanYourName(name);
      if (clean) localStorage.setItem(YOUR_NAME, clean); else localStorage.removeItem(YOUR_NAME);
    } catch { /* per-device convenience only */ }
  },
};
/** Local only, after any rewording: [Your name] in a finished note becomes the person's own name, or stays when none is set. */
export const signNote = (text: string, name: string) => text.split(PLACEHOLDER).join(cleanYourName(name) || PLACEHOLDER);

export const connection = {
  status: () => invoke<ConnectionStatus | null>("connection_status"),
  /** `operations` asks Planning Center for Calendar, People and Groups too; `more` for Check-Ins and Registrations. Ozzie still only reads. */
  connect: (client_id: string, organization: string, registered: boolean, operations = false, more: MoreProducts = {}) => invoke<ConnectionStatus>("connect_planning_center",
    { clientId: client_id, organization, registered, ...(operations ? { operations: true } : {}), ...moreArgs(more) })
    .then(status => { operationsAsked.set(operations); return status; }),
  /**
   * One click: Ozzie's own registration ("Ozzie for Mac"); Planning Center names the organization after
   * sign-in. Only in builds that have that registration built in (`appAvailable`).
   */
  connectApp: (operations = false, more: MoreProducts = {}) => invoke<ConnectionStatus>("connect_planning_center_app",
    { ...(operations ? { operations: true } : {}), ...moreArgs(more) })
    .then(status => { operationsAsked.set(operations); return status; }),
  /** Whether this build can connect in one click. */
  appAvailable: () => invoke<boolean>("planning_center_app").catch(() => false),
  /** An empty `client_id` means Ozzie's own registration. */
  refresh: (client_id: string, organization: string, registered: boolean) => invoke<ConnectionStatus>("check_saved_connection", { clientId: client_id, organization, registered }),
  cancel: () => invoke<void>("cancel_connection"),
  disconnect: () => invoke<ConnectionStatus>("disconnect_planning_center"),
  /**
   * The person's answer to "Switch Ozzie to this church?". Only the answer is sent: which sign-ins are signed out is
   * decided natively from the question it showed.
   */
  answerSwitch: (decision: SwitchDecision, question: number) => invoke<SwitchAnswer>("answer_church_switch", { decision, question }),
  /** Tries again to sign out of the sign-ins already chosen to leave. */
  retrySignOut: () => invoke<ConnectionStatus>("retry_church_sign_out"),
  /** Removes from this Mac, without a revoke, the sign-ins Planning Center refused to sign Ozzie out of. */
  removeRefused: () => invoke<ConnectionStatus>("remove_refused_sign_ins"),
};
/** Fixed local copy only. Native/provider error text is never rendered. */
export function connectionProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes('"switch-unchecked"') || known.includes('"keep-unchecked"')) {
    // A Keychain cause never reached Planning Center (review S, N3).
    if (known.includes('"locked"')) return "The Mac’s credential storage is locked, so Ozzie couldn't check that sign-in. Nothing changed. Unlock it, then try again.";
    if (known.includes('"denied"')) return "The Mac didn't allow Ozzie to read that sign-in. Nothing changed. Allow access in macOS, then try again.";
    if (known.includes('"store"')) return "The Mac’s credential storage is unavailable, so Ozzie couldn't check that sign-in. Nothing changed. Try again in a moment.";
    return "Ozzie couldn't check that church's sign-in with Planning Center just now, so nothing changed. Try again.";
  }
  if (known.includes('"switch-pending"')) return "Answer the question about switching churches first.";
  if (known.includes('"no-question"')) return "That question was already answered or replaced. The current one is shown here.";
  if (known.includes('"left-church"')) return "Ozzie was asked to stop using that church, so it doesn't check it again.";
  if (known.includes('"sign-in-instead"')) return "Ozzie doesn't switch to a sign-in it found. To use that church, sign in to it instead.";
  if (known.includes('"locked"')) return "Unlock the Mac’s credential storage, then try again.";
  if (known.includes('"denied"')) return "The Mac refused access to its credential storage. Allow access in macOS, then try again.";
  if (known.includes('"registration-required"')) return "Save a Public Planning Center registration with the exact return address before connecting.";
  if (known.includes('"organization-unverified"')) return "The expected organization could not be verified. Nothing new was saved.";
  if (known.includes('"invalid-token"')) return "No usable saved connection was found. Connect again in your browser.";
  if (known.includes('"browser-unavailable"')) return "The sign-in browser could not open. Try again after checking the default browser.";
  if (known.includes('"expired"')) return "Sign-in expired. Start a new connection.";
  if (known.includes('"scope-mismatch"')) return "Planning Center granted different access than Ozzie asked for, so nothing was saved. Try connecting again.";
  if (known.includes('"not-revoked"')) return "A Sunday check is still stopping, so access hasn't been revoked yet. Try disconnecting again in a moment.";
  if (known.includes('"busy"')) return "The previous connection check is still stopping. Try again shortly.";
  if (known.includes('"store"')) return "The Mac’s credential storage is unavailable. The connection could not be saved or checked.";
  return "The connection could not be checked. If you were disconnecting, revocation is unconfirmed; try again.";
}

const genericOrganizationProblem = "The expected organization could not be verified. Nothing new was saved.";
const userInfoReasons: readonly string[] = ["transport-failure", "access-denied", "provider-failure", "invalid-json", "organization-id-missing", "organization-id-invalid", "unclassified"];
/** Validate untrusted IPC metadata without invoking getters or rendering provider text. */
export function parseOrganizationDiagnostic(value: unknown): OrganizationDiagnostic | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(fields);
    if (keys.length !== 3 || !["version", "stage", "reason"].every(key => keys.includes(key))) return undefined;
    if (!["version", "stage", "reason"].every(key => fields[key]?.enumerable && "value" in fields[key])) return undefined;
    const version: unknown = fields.version?.value;
    const stage: unknown = fields.stage?.value;
    const reason: unknown = fields.reason?.value;
    if (version !== 1) return undefined;
    if (stage === "organization-binding" && reason === "organization-mismatch") return { version: 1, stage, reason };
    if (stage === "userinfo" && typeof reason === "string" && userInfoReasons.includes(reason)) return { version: 1, stage, reason: reason as UserInfoReason };
    return undefined;
  } catch {
    return undefined;
  }
}
/** Every sentence is local and fixed; metadata carries no identity or provider payload. */
export function organizationDiagnosticProblem(value: unknown): string {
  const diagnostic = parseOrganizationDiagnostic(value);
  if (!diagnostic) return genericOrganizationProblem;
  switch (diagnostic.reason) {
    case "transport-failure": return "The organization check with Planning Center could not finish. Nothing new was saved.";
    case "access-denied": return "Planning Center did not allow the organization check. Nothing new was saved.";
    case "provider-failure": return "Planning Center could not complete the organization check. Nothing new was saved.";
    case "invalid-json": return "Planning Center’s reply could not be used to check the organization. Nothing new was saved.";
    case "organization-id-missing": return "Planning Center did not identify an organization. Nothing new was saved.";
    case "organization-id-invalid": return "Planning Center did not provide a usable organization identity. Nothing new was saved.";
    case "organization-mismatch": return "You signed in to a different Planning Center organization than the one in Ozzie's settings. Sign in to your church's organization, or check the organization ID under Advanced. Nothing new was saved.";
    case "unclassified": return genericOrganizationProblem;
  }
}
export function connectionStatusProblem(status: ConnectionStatus): string {
  if (status.state === "failed" && status.organization_diagnostic !== undefined) {
    if (status.problem === "organization-unverified" || status.problem === "provider-failure") return organizationDiagnosticProblem(status.organization_diagnostic);
    return genericOrganizationProblem;
  }
  return connectionProblem(status.problem);
}

/**
 * After a one-click sign-in, the settings to keep: the organization Planning Center named, with Ozzie's
 * own registration (an empty client ID). A different organization clears the chosen Sunday, which
 * belonged to the old one. Applied once per sign-in (`key`), so typing under Advanced afterwards sticks.
 */
export function foundOrganization<S extends { clientId: string; organization: string; serviceTypeId: string; planId: string }>(
  settings: S, status: ConnectionStatus | null, applied: string | null,
): { settings: S; key: string } | null {
  if (status?.state !== "connected" || status.found !== true || !/^[1-9]\d{0,31}$/.test(status.organization)) return null;
  const key = `${status.organization}@${status.checked_at_ms ?? ""}`;
  if (key === applied) return null;
  const same = settings.organization === status.organization;
  return { key, settings: { ...settings, clientId: "", organization: status.organization, ...(same ? {} : { serviceTypeId: "", planId: "" }) } };
}

const orgId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,31}$/.test(value);
const publicClient = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && !/\p{Cc}/u.test(value);
const plain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const orgIds = (value: unknown): string[] | null => Array.isArray(value) && value.length >= 1 && value.length <= 20 && value.every(orgId) ? [...value] : null;
const SPACE = /^[\p{Cc}\p{Zs}\p{Zl}\p{Zp}]$/u, DROPPED = /^[\p{Cf}\p{Co}\p{Cs}]$/u;
/**
 * A church's name as display text, by the one rule native code applies too (core/native-auth oauth.rs `church_name`;
 * both sides' tests run core/test/church-name-parity.json): control, space and line or paragraph separator characters
 * become one space; format (bidirectional, zero-width, soft hyphen, tags), private-use and surrogate characters are
 * dropped; spaces collapse and trim; at most 120 code points. Anything else, or nothing left, is no name, and the
 * organization number is shown instead. A name never makes a question or the church in use unreadable (review S2, M1).
 */
export function churchName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let cleaned = "";
  for (const ch of raw) {
    if (SPACE.test(ch)) { if (cleaned && !cleaned.endsWith(" ")) cleaned += " "; }
    else if (!DROPPED.test(ch)) cleaned += ch;
  }
  const name = [...cleaned.replace(/ +$/u, "")].slice(0, 120).join("").replace(/ +$/u, "");
  return name || undefined;
}
const named = <K extends string>(key: K, raw: unknown): { [P in K]?: string } => {
  const name = churchName(raw);
  return (name ? { [key]: name } : {}) as { [P in K]?: string };
};
/** Validates the untrusted IPC question; anything malformed shows no question. A church's name is never a reason. */
export function parseSwitchQuestion(value: unknown): SwitchQuestion | undefined {
  try {
    if (!plain(value)) return undefined;
    const { id, to, to_name, from, from_name, from_client, others, fresh } = value;
    const list = orgIds(others);
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return undefined;
    if (!orgId(to) || !orgId(from) || to === from || !publicClient(from_client) || typeof fresh !== "boolean") return undefined;
    if (!list || !list.includes(from) || list.includes(to)) return undefined;
    return { id, to, from, from_client, others: list, fresh, ...named("to_name", to_name), ...named("from_name", from_name) };
  } catch {
    return undefined;
  }
}
const retireFailures: readonly string[] = ["revoke-failed", "refused", "locked", "denied", "unavailable", "unfinished"];
export function parseUnretired(value: unknown): Unretired | undefined {
  try {
    if (!plain(value) || !Array.isArray(value.left) || value.left.length < 1 || value.left.length > 20) return undefined;
    const left: LeftBehind[] = [];
    for (const entry of value.left as unknown[]) {
      if (!plain(entry)) return undefined;
      const { organization, name, reason, ozzie_registration } = entry;
      if (!orgId(organization) || typeof reason !== "string" || !retireFailures.includes(reason)) return undefined;
      left.push({ organization, reason: reason as RetireFailure, ...named("name", name),
        ...(typeof ozzie_registration === "boolean" ? { ozzie_registration } : {}) });
    }
    return { left };
  } catch {
    return undefined;
  }
}
export function parseInUse(value: unknown): InUse | undefined {
  try {
    if (!plain(value)) return undefined;
    const { organization, client_id, name } = value;
    if (!orgId(organization) || !publicClient(client_id)) return undefined;
    return { organization, client_id, ...named("name", name) };
  } catch {
    return undefined;
  }
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** "Fictional Grace Church (organization 1001)", or "organization 1001" when there's no name to show. */
export const churchLabel = (id: string, name?: string) => {
  const shown = churchName(name);
  return shown ? `${shown} (organization ${id})` : `organization ${id}`;
};
/** The short form for buttons and repeat mentions: the church's name, or "organization 1001". The same name for both churches keeps the numbers. */
export const churchShort = (id: string, name?: string, otherName?: string) => {
  const shown = churchName(name);
  return !shown ? `organization ${id}` : shown === churchName(otherName) ? `${shown} (${id})` : shown;
};
/** "organization 1001", or "Fictional Grace Church (organization 1001) and organization 3003". */
export const churchList = (churches: readonly { organization: string; name?: string | undefined }[]) => {
  const labels = churches.map(c => churchLabel(c.organization, c.name));
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
};

/** Church rules of the church Ozzie uses now (`from`) and kept from before for the one it offers (`to`). */
export type RulesAtStake = { from: boolean; to: boolean };
/** One choice under the question: what the button says and the answer it sends. The first is the primary one. */
export type SwitchAction = { label: string; decision: SwitchDecision };
/**
 * What the question says, all fixed local copy around churches' names and organization numbers. The buttons name the
 * person's choice and its effect; what each one does is said before either is pressed.
 *  - A sign-in the person just made: switch (primary) or keep.
 *  - A sign-in Ozzie found saved on this Mac: keep (primary), or sign in to that church instead. Ozzie never switches to
 *    a found sign-in as it is, and the wording doesn't suggest the person made it (review S2, L3).
 */
export function switchCopy(question: SwitchQuestion, rules: RulesAtStake = { from: false, to: false }) {
  const { to, to_name, from, from_name, others, fresh } = question;
  const toShort = churchShort(to, to_name, from_name), fromShort = churchShort(from, from_name, to_name);
  const keepLine = (what: string) => `Keeping ${fromShort} checks its sign-in with Planning Center first. Then Planning Center stops accepting the ${what} sign-in for ${toShort}, and it's removed from this Mac.`;
  if (!fresh) {
    return {
      title: `Ozzie found a saved sign-in for ${churchLabel(to, to_name)} on this Mac`,
      lead: `Ozzie works with one church at a time, and it's using ${churchLabel(from, from_name)}. Ozzie doesn't switch to a sign-in it found; to use ${toShort}, sign in to it.`,
      effects: [
        keepLine("saved"),
        `Signing in to ${toShort} opens Planning Center in your browser. After you sign in, Ozzie asks before it stops using ${fromShort}.`,
      ],
      actions: [
        { label: `Keep Ozzie on ${fromShort}`, decision: "stay" },
        { label: `Sign in to ${toShort} instead`, decision: "sign-in" },
      ] as SwitchAction[],
    };
  }
  const several = others.length > 1;
  const leaving = churchList(others.map(organization => ({ organization, name: organization === from ? from_name : undefined })));
  const rulesLine = rules.from
    ? `Church rules for ${fromShort}'s teams and rooms (kids teams, background checks, Sunday leads, room rules and what you told Ozzie about its findings) stay with ${fromShort} and don't apply to ${toShort}.${rules.to ? ` The ones you set for ${toShort} before come back.` : ` You can set them for ${toShort} in Church rules.`}`
    : rules.to ? `Church rules you set for ${toShort}'s teams and rooms before come back.` : null;
  return {
    title: churchName(to_name) ? `Switch Ozzie to ${churchName(to_name)}?` : "Switch Ozzie to this church?",
    lead: `You signed in to Planning Center for ${churchLabel(to, to_name)}. Ozzie works with one church at a time, and it's still using ${churchLabel(from, from_name)}.`,
    effects: [
      `Switching checks ${toShort}'s sign-in with Planning Center first. Then Planning Center stops accepting Ozzie's ${several ? "sign-ins" : "sign-in"} for ${leaving}, and ${several ? "they're" : "it's"} removed from this Mac. Your church's information in Planning Center doesn't change.`,
      `Saved recordings of ${fromShort}'s Sundays stay on this Mac. Ozzie shows them only while it uses ${fromShort}.`,
      ...(rulesLine ? [rulesLine] : []),
      `What runs automatically stays set up. Ozzie checks ${toShort} on its schedule once you choose which of its Sundays to check.`,
      keepLine("new"),
    ],
    actions: [
      { label: `Switch Ozzie to ${toShort}`, decision: "switch" },
      { label: `Keep Ozzie on ${fromShort}`, decision: "stay" },
    ] as SwitchAction[],
  };
}

/** Why an answer changed nothing, in fixed words naming the church concerned. */
export function switchProblem(error: unknown, question: SwitchQuestion): string {
  const known = JSON.stringify(error) ?? "";
  const toShort = churchShort(question.to, question.to_name, question.from_name);
  const fromShort = churchShort(question.from, question.from_name, question.to_name);
  const broken = known.includes('"invalid-token"') || known.includes('"organization-unverified"');
  const keychain = (who: string) => known.includes('"locked"') ? `The Mac’s credential storage is locked, so Ozzie couldn't check ${who}'s sign-in. Nothing changed. Unlock it, then try again.`
    : known.includes('"denied"') ? `The Mac didn't allow Ozzie to read ${who}'s sign-in. Nothing changed. Allow access in macOS, then try again.`
      : known.includes('"store"') ? `The Mac’s credential storage is unavailable, so Ozzie couldn't check ${who}'s sign-in. Nothing changed. Try again in a moment.` : null;
  if (known.includes('"sign-in-instead"')) return `Ozzie doesn't switch to a sign-in it found. To use ${toShort}, choose Sign in to ${toShort} instead.`;
  if (known.includes('"keep-unchecked"')) {
    return keychain(fromShort) ?? (broken
      ? `${capital(fromShort)}'s sign-in no longer works with Planning Center, so nothing changed. You can switch to ${toShort} now and sign in to ${fromShort} again afterwards; Ozzie asks before signing out of either.`
      : `Ozzie couldn't reach Planning Center to check ${fromShort}'s sign-in, so nothing changed. Try again when this Mac is online.`);
  }
  if (known.includes('"switch-unchecked"')) {
    return keychain(toShort) ?? (broken
      ? `${capital(toShort)}'s sign-in no longer works with Planning Center, so nothing changed. Keep ${fromShort}, or sign in to ${toShort} again.`
      : `Ozzie couldn't reach Planning Center to check ${toShort}'s sign-in, so nothing changed. Try again when this Mac is online.`);
  }
  return connectionProblem(error);
}

/** What can still be true of a sign-in Ozzie removed without signing out of it at Planning Center. */
const STAYS_ACTIVE = "it may stay active at Planning Center until it expires or an administrator disconnects it there (Account Settings, Integrations";
/**
 * After Disconnect removed a saved sign-in it couldn't read that named another church (native: disconnected with
 * `organization-unverified`), it wasn't signed out at Planning Center: say so. Empty for any other status.
 */
export function disconnectNote(status: Pick<ConnectionStatus, "state" | "problem"> | null): string {
  if (status?.state !== "disconnected" || status.problem !== "organization-unverified") return "";
  return "Ozzie removed the saved sign-in from this Mac but didn't sign out of it at Planning Center, because it named another church. " +
    `${STAYS_ACTIVE.charAt(0).toUpperCase()}${STAYS_ACTIVE.slice(1)}).`;
}
/** One sign-in the person chose to leave that's still saved: why, and what to do. */
export function leftBehindCopy(entry: LeftBehind): string {
  const which = churchLabel(entry.organization, entry.name);
  const stays = "That sign-in stays saved on this Mac until Ozzie signs out of it.";
  switch (entry.reason) {
    case "refused": {
      const listed = entry.ozzie_registration === true ? ", where it's listed as Ozzie for Mac"
        : entry.ozzie_registration === false ? ", where it's listed under the registration typed in Ozzie's Advanced settings" : "";
      return `Planning Center wouldn't sign Ozzie out of ${which}, so that sign-in is still saved on this Mac. Trying again may not help. Ozzie can remove it from this Mac, but ${STAYS_ACTIVE}${listed}).`;
    }
    case "revoke-failed": return `Ozzie couldn't sign out of ${which} yet because Planning Center couldn't be reached. ${stays} Try again when this Mac is online.`;
    case "locked": return `Ozzie couldn't sign out of ${which} yet because the Mac's credential storage is locked. ${stays} Unlock it, then try again.`;
    case "denied": return `Ozzie couldn't sign out of ${which} yet because the Mac didn't allow Ozzie to read the sign-ins it needed. ${stays} Allow access in macOS, then try again.`;
    case "unavailable": return `Ozzie couldn't sign out of ${which} yet because the Mac's credential storage is unavailable. ${stays} Try again in a moment.`;
    case "unfinished": return `Ozzie hadn't finished signing out of ${which} when it last closed. ${stays} Try again now.`;
  }
}
/** How the last sign-in ended, when native code reports one that ended without connecting; anything else shows nothing. */
export function parseLastAttempt(value: unknown): ConnectionStatus | undefined {
  if (!plain(value)) return undefined;
  const { state, organization, problem, organization_diagnostic } = value;
  if (state !== "cancelled" && state !== "expired" && state !== "failed") return undefined;
  return { state, organization: typeof organization === "string" ? organization : "", checked_at_ms: null, source: "", problem: problem ?? null,
    ...(plain(organization_diagnostic) ? { organization_diagnostic: organization_diagnostic as OrganizationDiagnostic } : {}) };
}
/**
 * Why the last sign-in didn't connect, in the words the sign-in form used for it before, and that the church in use is
 * still the one Ozzie uses (review S4, M1).
 */
export function attemptCopy(attempt: ConnectionStatus, inUse: { organization: string; name?: string | undefined }): string {
  const still = `Ozzie still uses ${churchLabel(inUse.organization, inUse.name)}.`;
  if (attempt.state === "cancelled") return `Sign-in was cancelled on this Mac. ${still}`;
  if (attempt.state === "expired") return `Sign-in expired before it finished. ${still}`;
  return `${connectionStatusProblem(attempt) || "The sign-in couldn't be checked, so nothing changed."} ${still}`;
}
/** The church Ozzie last used has no saved sign-in any more, so it uses the church in Settings (review S4, L3). */
export function missingCopy(missing: string, inUse: { organization: string; name?: string | undefined }): string {
  return `The sign-in for ${churchShort(missing)}, the church Ozzie used last, is no longer on this Mac, so Ozzie now uses ${churchLabel(inUse.organization, inUse.name)}.`;
}
/** The church native code reports a check didn't use, when it is well formed. */
export const parseDeclined = (value: unknown): string | undefined => orgId(value) ? value : undefined;
/**
 * Settings named a church Ozzie doesn't use without a new sign-in, so it kept the church it uses (review S3, M1 and L1).
 * `inUse`: the church checked instead, as the status names it.
 */
export function declinedCopy(declined: string, inUse: { organization: string; name?: string | undefined }, declinedName?: string): string {
  return `Ozzie still uses ${churchLabel(inUse.organization, inUse.name)}. To use ${churchShort(declined, declinedName, inUse.name)} instead, sign in to it.`;
}
/** The two ways forward: trying again for what may still work, removing what Planning Center refused. */
export function leftBehindActions(unretired: Unretired) {
  const retry = unretired.left.filter(l => l.reason !== "refused");
  const refused = unretired.left.filter(l => l.reason === "refused");
  return {
    retryLabel: retry.length ? `Try signing out of ${churchList(retry)} again` : null,
    removeLabel: refused.length ? `Remove ${refused.length === 1 ? "that sign-in" : "those sign-ins"} from this Mac anyway` : null,
  };
}

type ChurchSettings = { clientId: string; organization: string; serviceTypeId: string; planId: string };
/**
 * "Sign in to X instead": the sign-in to start, with the registration Ozzie uses now, as any sign-in starts (the IDs
 * typed under Advanced, else one click). Settings never take X here: they follow only once a sign-in for X has
 * connected and the person chose to switch (review S3, M1 and L3). Null when no sign-in can start.
 */
export function signInInstead(settings: { clientId: string }, to: string, registered: boolean, builtIn: boolean):
  { clientId: string; organization: string; registered: boolean } | "one-click" | null {
  if (!orgId(to)) return null;
  if (settings.clientId.trim()) return { clientId: settings.clientId, organization: to, registered };
  return builtIn ? "one-click" : null;
}
/** After an answer, the church Ozzie now uses. A different church clears the chosen Sunday, which belonged to the old one. */
export function switchSettings<S extends ChurchSettings>(settings: S, answer: { client_id: string; organization: string }): S {
  if (!orgId(answer.organization) || !publicClient(answer.client_id)) return settings;
  const same = settings.organization === answer.organization;
  return { ...settings, clientId: answer.client_id, organization: answer.organization, ...(same ? {} : { serviceTypeId: "", planId: "" }) };
}
/**
 * While the question is open, Settings keeps the church Ozzie still uses, so automatic checks and the check on the next
 * launch stay on it. IDs typed under Advanced for the new church come back with a switch. Null when nothing changes.
 */
export function pendingSettings<S extends ChurchSettings>(settings: S, question: SwitchQuestion | undefined): S | null {
  if (!question || (settings.organization === question.from && settings.clientId === question.from_client)) return null;
  return { ...settings, clientId: question.from_client, organization: question.from };
}
/** Whether a status is no older than the newest one the page applied (native `revision`). One without a revision always is. */
export const fresher = (status: ConnectionStatus | null, newest: number) => status?.revision === undefined || status.revision >= newest;
/**
 * Settings follow the church Ozzie uses natively whenever that changes (an answer, a launch, or a window reopened), and
 * not otherwise, so IDs being typed under Advanced aren't undone while Ozzie runs. `last`: the church in use last seen
 * in this window. `seen`: the church in use last seen on this Mac, whose Sunday Settings hold, since a Sunday is chosen
 * from the church in use and a change of church clears it. So at a launch after IDs were typed for another church (or
 * after Ozzie closed mid-answer), Settings go back to the church native code uses, keeping the chosen Sunday when it is
 * that church's (review S3, L1). Returns the settings to apply (null: none) and the church in use to remember.
 */
export function followInUse<S extends ChurchSettings>(settings: S, inUse: InUse | undefined, last: string | null, seen: string | null = null): { settings: S | null; last: string | null } {
  if (!inUse) return { settings: null, last };
  const key = `${inUse.organization}|${inUse.client_id}`;
  if (key === last) return { settings: null, last };
  const same = settings.organization === inUse.organization && settings.clientId === inUse.client_id;
  if (same) return { settings: null, last: key };
  if (key === seen && orgId(inUse.organization) && publicClient(inUse.client_id)) {
    return { settings: { ...settings, clientId: inUse.client_id, organization: inUse.organization }, last: key };
  }
  return { settings: switchSettings(settings, inUse), last: key };
}
const SEEN = "ozzie.church-in-use-seen.v1";
/** The church in use last seen on this Mac (`followInUse`'s `seen`), as `organization|client`. Kept on this Mac only. */
export const seenInUse = {
  get(): string | null {
    try {
      const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(SEEN);
      if (raw === null) return null;
      const [organization, client, ...rest] = raw.split("|");
      return rest.length === 0 && orgId(organization) && publicClient(client) ? raw : null;
    } catch {
      return null;
    }
  },
  set(key: string) { try { if (typeof localStorage !== "undefined") localStorage.setItem(SEEN, key); } catch { /* per-device convenience only */ } },
};

