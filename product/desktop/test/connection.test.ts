import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionPage } from "../src/connection-page.js";
import { connectionProblem } from "../src/connection.js";

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
