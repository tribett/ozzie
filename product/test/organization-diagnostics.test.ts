import { describe, expect, it } from "vitest";
import { connectionStatusProblem, organizationDiagnosticProblem, parseOrganizationDiagnostic, type ConnectionStatus } from "../desktop/src/connection.js";

const generic = "The expected organization could not be verified. Nothing new was saved.";
const mismatch = { version: 1, stage: "organization-binding", reason: "organization-mismatch" };

describe("organization check diagnostics", () => {
  it("uses only exact version/stage/reason pairs to choose fixed local copy", () => {
    expect(parseOrganizationDiagnostic(mismatch)).toEqual(mismatch);
    expect(organizationDiagnosticProblem(mismatch)).toBe("The signed-in organization did not match the expected test organization. Nothing new was saved.");
    for (const invalid of [null, {}, { ...mismatch, version: 2 }, { ...mismatch, stage: "userinfo" }, { ...mismatch, reason: "fictional-secret-canary" }, { ...mismatch, body: "fictional-body-canary" }]) {
      expect(parseOrganizationDiagnostic(invalid)).toBeUndefined();
      expect(organizationDiagnosticProblem(invalid)).toBe(generic);
    }
  });
});

const copyCases = [
  ["transport-failure", "The organization check with Planning Center could not finish. Nothing new was saved."],
  ["access-denied", "Planning Center did not allow the organization check. Nothing new was saved."],
  ["provider-failure", "Planning Center could not complete the organization check. Nothing new was saved."],
  ["invalid-json", "Planning Center’s reply could not be used to check the organization. Nothing new was saved."],
  ["organization-id-missing", "Planning Center did not identify an organization. Nothing new was saved."],
  ["organization-id-invalid", "Planning Center did not provide a usable organization identity. Nothing new was saved."],
  ["unclassified", generic],
] as const;

describe("fixed organization copy and exact schema", () => {
  it.each(copyCases)("maps userinfo/%s to plain local text", (reason, copy) => {
    const value = { version: 1, stage: "userinfo", reason };
    expect(parseOrganizationDiagnostic(value)).toEqual(value);
    expect(organizationDiagnosticProblem(value)).toBe(copy);
    expect(copy).not.toMatch(/userinfo|transport-failure|invalid-json|organization-id|organization-binding|\b(?:skills|sessions|agent|log|connector|harness)\b/);
  });
  it("rejects every cross-stage pair and unknown version, reason or extra field", () => {
    for (const [reason] of copyCases) {
      expect(organizationDiagnosticProblem({ version: 1, stage: "organization-binding", reason })).toBe(generic);
    }
    for (const value of [
      { ...mismatch, version: "1" }, { ...mismatch, version: 0 }, { ...mismatch, version: 1.1 },
      { ...mismatch, stage: "future-stage" }, { ...mismatch, stage: "Userinfo" },
      { version: 1, stage: "userinfo", reason: "organization-mismatch" },
      { version: 1, stage: "userinfo", reason: "toString" },
      { ...mismatch, reason: null }, { ...mismatch, version: null },
      { ...mismatch, organization_id: 987654321 }, { ...mismatch, body: "fictional-body-name-secret-canary" },
      [mismatch], "fictional-body-name-secret-canary", undefined, true, 1,
      Object.create(mismatch), Object.assign(new Date(0), mismatch),
      { ...mismatch, [Symbol("fictional-extra-canary")]: "fictional-secret-canary" },
    ]) {
      expect(parseOrganizationDiagnostic(value)).toBeUndefined();
      expect(organizationDiagnosticProblem(value)).toBe(generic);
    }
  });
  it("does not invoke hostile getters/toJSON or serialize cyclic provider objects", () => {
    let executions = 0;
    const hostile = { version: 1, stage: "userinfo", get reason() { executions++; throw new Error("fictional-secret-canary"); } };
    const toJSON = { ...mismatch, toJSON() { executions++; throw new Error("fictional-secret-canary"); } };
    const hidden = Object.defineProperty({ ...mismatch }, "fictional-extra-canary", { value: "fictional-secret-canary" });
    const cyclic: Record<string, unknown> = { ...mismatch }; cyclic.extra = cyclic;
    const proxy = new Proxy({}, { ownKeys() { throw new Error("fictional-secret-canary"); } });
    for (const value of [hostile, toJSON, hidden, cyclic, proxy]) {
      expect(parseOrganizationDiagnostic(value)).toBeUndefined();
      expect(organizationDiagnosticProblem(value)).toBe(generic);
    }
    expect(executions).toBe(0);
  });
  it("accepts JSON objects with no prototype while returning only freshly validated fields", () => {
    const value: unknown = Object.assign(Object.create(null), mismatch);
    const result = parseOrganizationDiagnostic(value);
    expect(result).toEqual(mismatch);
    expect(result).not.toBe(value);
  });
  it("uses metadata only for failed organization checks and never as success proof", () => {
    // IPC copy inputs only; native final states are independently produced by AuthController tests.
    const status: ConnectionStatus = { state: "failed", organization: "1001", checked_at_ms: null, source: "Planning Center", problem: "organization-unverified", organization_diagnostic: { version: 1, stage: "organization-binding", reason: "organization-mismatch" } };
    expect(connectionStatusProblem(status)).toContain("did not match");
    expect(connectionStatusProblem({ ...status, problem: "provider-failure", organization_diagnostic: { version: 1, stage: "userinfo", reason: "transport-failure" } })).toContain("could not finish");
    for (const state of ["waiting", "checking", "cancelled", "expired", "connected", "stored-unchecked", "disconnected"] as const) {
      expect(connectionStatusProblem({ ...status, state })).not.toContain("did not match");
    }
    expect(connectionStatusProblem({ ...status, problem: "invalid-token" })).toBe(generic);
    expect(connectionStatusProblem({ ...status, organization_diagnostic: { ...status.organization_diagnostic, version: 2 } as unknown as ConnectionStatus["organization_diagnostic"] } as ConnectionStatus)).toBe(generic);
  });
  it("never echoes secret/body/profile/actual-ID/URL or native error canaries into copy", () => {
    for (const field of ["body", "name", "email", "organization_id", "expected_organization", "access_token", "refresh_token", "code_verifier", "code", "state", "url", "native_error"]) {
      const value = { ...mismatch, [field]: "fictional-canary-987654321-https://fictional.invalid/private" };
      expect(organizationDiagnosticProblem(value)).toBe(generic);
      expect(organizationDiagnosticProblem(value)).not.toContain("fictional-canary");
      expect(organizationDiagnosticProblem(value)).not.toContain("987654321");
    }
  });
});
