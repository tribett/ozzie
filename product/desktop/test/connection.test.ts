import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConnectionPage } from "../src/connection-page.js";
import { cleanYourName, connectionProblem, foundOrganization, organizationDiagnosticProblem, signNote, yourName, YOUR_NAME_MAX, type ConnectionStatus } from "../src/connection.js";

describe("private consumer status-only presentation", () => {
  it("starts disconnected with connection actions disabled until Public registration is confirmed", () => {
    const settings = { clientId: "", organization: "", serviceTypeId: "", planId: "" };
    const html = renderToStaticMarkup(React.createElement(ConnectionPage, { status: null, settings, onSettings: () => {}, onStatus: () => {} }));
    expect(html).toContain("Planning Center is disconnected.");
    expect(html).toMatch(/<button class="btn btn-primary" disabled="">Connect Planning Center<\/button>/);
    expect(html).toContain("Reads only.");
    expect(html).not.toMatch(/type="password"|access_token|refresh_token|code_verifier/);
  });
  it("shows fixed actionable storage errors and never echoes provider credential material", () => {
    expect(connectionProblem({ authentication: { store: "locked" } })).toContain("Unlock");
    expect(connectionProblem({ authentication: { store: "denied" } })).toContain("refused");
    expect(connectionProblem({ authentication: { store: "unavailable" } })).toContain("unavailable");
    expect(connectionProblem("fictional-secret-material")).not.toContain("fictional-secret-material");
    expect(connectionProblem(undefined)).toContain("could not be checked");
  });
});

describe("wording for a real church", () => {
  it("a different organization is said plainly, with what to do, and never calls the church a test organization", () => {
    const t = organizationDiagnosticProblem({ version: 1, stage: "organization-binding", reason: "organization-mismatch" });
    expect(t).toBe("You signed in to a different Planning Center organization than the one in Ozzie's settings. Sign in to your church's organization, or check the organization ID under Advanced. Nothing new was saved.");
    expect(t).not.toMatch(/\btest\b|expected/iu);
  });
});

describe("Your name for notes", () => {
  it("is tidied to one short line, and signs a finished note on this Mac, or leaves [Your name]", () => {
    expect(cleanYourName("  Pat \n Example\u200b ")).toBe("Pat Example");
    expect(cleanYourName("x".repeat(100))).toHaveLength(YOUR_NAME_MAX);
    expect(signNote("Thank you,\n[Your name]", " Pat ")).toBe("Thank you,\nPat");
    expect(signNote("Thank you,\n[Your name]", "  ")).toBe("Thank you,\n[Your name]");
  });
  it("is kept on this Mac in its own place, apart from the Church rules", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } });
    try {
      expect(yourName.get()).toBe("");
      yourName.set(" Pat  Example ");
      expect([...stored]).toEqual([["ozzie.your-name.v1", "Pat Example"]]);
      expect(yourName.get()).toBe("Pat Example");
      yourName.set("   ");
      expect(stored.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});

const connectedStatus = (over: Partial<ConnectionStatus> = {}): ConnectionStatus => ({
  state: "connected", organization: "513367", checked_at_ms: 1_000, source: "Planning Center /oauth/userinfo", problem: null, scopes: "services", ...over,
});

describe("one-click Planning Center connect", () => {
  const empty = { clientId: "", organization: "", serviceTypeId: "", planId: "" };
  it("leads with one Connect button and folds the IDs under Advanced when Ozzie's registration is built in", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPage, { status: null, settings: empty, onSettings: () => {}, onStatus: () => {}, oneClick: true }));
    expect(html).toMatch(/<button class="btn btn-primary">Connect Planning Center<\/button>/);
    expect(html).toContain("Ozzie finds your church&#x27;s organization itself");
    expect(html).toMatch(/<details class="listen-more"><summary><svg[^]*?<\/svg>Advanced: use your own Planning Center registration<\/summary>/);
    // The typed-ID button is secondary and still needs both IDs and the confirmation.
    expect(html).toMatch(/<button class="btn btn-secondary" disabled="">Connect with these IDs<\/button>/);
    // The rooms opt-in can sign in with Ozzie's registration, so it isn't greyed out for missing IDs.
    expect(html).toMatch(/<button class="btn btn-secondary">Also check rooms, follow-ups and group events<\/button>/);
  });
  it("opens Advanced when your own registration's ID is in use", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPage, {
      status: null, settings: { ...empty, clientId: "fictional-own-client", organization: "1001" }, onSettings: () => {}, onStatus: () => {}, oneClick: true,
    }));
    expect(html).toContain('<details class="listen-more" open="">');
  });
  it("says connected again rather than offering a first connect once connected", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPage, {
      status: connectedStatus({ found: true }), settings: { ...empty, organization: "513367" }, onSettings: () => {}, onStatus: () => {}, oneClick: true,
    }));
    expect(html).toContain(">Sign in again</button>");
    expect(html).toContain("Planning Center confirmed organization 513367");
  });
  it("remembers the organization Planning Center named, once per sign-in, with Ozzie's registration", () => {
    const status = connectedStatus({ found: true });
    const first = foundOrganization({ ...empty, clientId: "fictional-own-client" }, status, null);
    expect(first?.settings).toEqual({ clientId: "", organization: "513367", serviceTypeId: "", planId: "" });
    // Applied once: typing under Advanced afterwards isn't overwritten by the same sign-in.
    expect(foundOrganization({ ...empty, organization: "999" }, status, first!.key)).toBeNull();
    // A new sign-in (new check time) applies again.
    expect(foundOrganization(empty, { ...status, checked_at_ms: 2_000 }, first!.key)?.settings.organization).toBe("513367");
    // Review M, L7: a renewal changes the check time every two hours, never when the one-click sign-in was made, so
    // it never re-applies the organization over IDs typed under Advanced since.
    const found = { ...status, found_at_ms: 1_000 };
    const once = foundOrganization(empty, found, null)!;
    expect(foundOrganization({ ...empty, organization: "999" }, { ...found, checked_at_ms: 7_201_000 }, once.key)).toBeNull();
    // Another one-click sign-in is another time: applied again.
    expect(foundOrganization({ ...empty, organization: "999" }, { ...found, found_at_ms: 9_000_000, checked_at_ms: 9_000_000 }, once.key)?.settings.organization).toBe("513367");
  });
  it("keeps the chosen Sunday for the same organization and clears it for a different one", () => {
    const status = connectedStatus({ found: true });
    const same = foundOrganization({ clientId: "", organization: "513367", serviceTypeId: "1", planId: "2" }, status, null);
    expect(same?.settings).toMatchObject({ serviceTypeId: "1", planId: "2" });
    const other = foundOrganization({ clientId: "", organization: "1001", serviceTypeId: "1", planId: "2" }, status, null);
    expect(other?.settings).toMatchObject({ organization: "513367", serviceTypeId: "", planId: "" });
  });
  it("ignores anything but a connected, found, numeric organization", () => {
    expect(foundOrganization(empty, null, null)).toBeNull();
    expect(foundOrganization(empty, connectedStatus(), null)).toBeNull();
    expect(foundOrganization(empty, connectedStatus({ found: true, state: "checking" }), null)).toBeNull();
    expect(foundOrganization(empty, connectedStatus({ found: true, organization: "01" }), null)).toBeNull();
    expect(foundOrganization(empty, connectedStatus({ found: true, organization: "" }), null)).toBeNull();
  });
});
