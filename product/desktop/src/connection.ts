import { invoke } from "@tauri-apps/api/core";
export type UserInfoReason = "transport-failure" | "access-denied" | "provider-failure" | "invalid-json" | "organization-id-missing" | "organization-id-invalid" | "unclassified";
export type OrganizationDiagnostic = { version: 1 } & (
  { stage: "userinfo"; reason: UserInfoReason } |
  { stage: "organization-binding"; reason: "organization-mismatch" }
);
/** What the saved connection was granted: Services alone (the default), or also Calendar, People and Groups. */
export type ConnectionScopes = "services" | "services-and-operations";
export type ConnectionStatus = {
  state: "disconnected" | "waiting" | "checking" | "connected" | "stored-unchecked" | "cancelled" | "expired" | "failed";
  organization: string; checked_at_ms: number | null; source: string; problem: unknown;
  organization_diagnostic?: OrganizationDiagnostic;
  /** Present only once this session has verified the saved connection. */
  scopes?: ConnectionScopes;
  /** True when one-click sign-in let Planning Center name this organization. */
  found?: boolean;
};
const ASKED = "ozzie.operations-asked";
/**
 * Whether the last sign-in on this Mac asked for Calendar, People and Groups. A per-device note
 * only, so What happened can tell "Planning Center didn't grant it" from "turned off in Settings".
 */
export const operationsAsked = {
  get: (): boolean => { try { return typeof localStorage !== "undefined" && localStorage.getItem(ASKED) === "1"; } catch { return false; } },
  set: (asked: boolean) => { try { if (typeof localStorage !== "undefined") localStorage.setItem(ASKED, asked ? "1" : "0"); } catch { /* per-device convenience only */ } },
};
export const connection = {
  status: () => invoke<ConnectionStatus | null>("connection_status"),
  /** `operations` asks Planning Center for Calendar, People and Groups too. Ozzie still only reads. */
  connect: (client_id: string, organization: string, registered: boolean, operations = false) => invoke<ConnectionStatus>("connect_planning_center",
    operations ? { clientId: client_id, organization, registered, operations: true } : { clientId: client_id, organization, registered })
    .then(status => { operationsAsked.set(operations); return status; }),
  /**
   * One click: Ozzie's own registration ("Ozzie for Mac"); Planning Center names the organization after
   * sign-in. Only in builds that have that registration built in (`appAvailable`).
   */
  connectApp: (operations = false) => invoke<ConnectionStatus>("connect_planning_center_app", operations ? { operations: true } : {})
    .then(status => { operationsAsked.set(operations); return status; }),
  /** Whether this build can connect in one click. */
  appAvailable: () => invoke<boolean>("planning_center_app").catch(() => false),
  /** An empty `client_id` means Ozzie's own registration. */
  refresh: (client_id: string, organization: string, registered: boolean) => invoke<ConnectionStatus>("check_saved_connection", { clientId: client_id, organization, registered }),
  cancel: () => invoke<void>("cancel_connection"),
  disconnect: () => invoke<ConnectionStatus>("disconnect_planning_center"),
};
/** Fixed local copy only. Native/provider error text is never rendered. */
export function connectionProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
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
    case "organization-mismatch": return "The signed-in organization did not match the expected test organization. Nothing new was saved.";
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
