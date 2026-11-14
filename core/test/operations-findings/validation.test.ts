import { describe, expect, it } from "vitest";
import { evaluateOperations } from "../../src/operations-findings/index.js";
import type { OperationsInput } from "../../src/operations-findings/types.js";
import { rooms } from "./fixtures.js";
const evaluate = (value: unknown) => evaluateOperations(value as OperationsInput);

describe("closed inert input and clocks", () => {
  it.each([null, [], {}, 1, "CANARY_PRIVATE", undefined])("rejects malformed top-level values without raw data: %s", value => {
    expect(evaluate(value)).toMatchObject({ status: "unverified", findings: [], evaluated_at: null,
      uncertainties: [{ code: "invalid-input", scope_id: null, subject_id: null, label: "Worth a look" }] });
  });
  it("does not invoke getters or toJSON, or propagate their canaries", () => {
    let touched = 0;
    const value = Object.defineProperty(rooms(), "notes", { enumerable: true, get() { touched++; throw new Error("CANARY_PRIVATE"); } });
    expect(evaluate(value).status).toBe("unverified");
    expect(touched).toBe(0);
    expect(JSON.stringify(evaluate({ ...rooms(), toJSON() { touched++; return "CANARY_PRIVATE"; } }))).not.toContain("CANARY_PRIVATE");
    expect(touched).toBe(0);
  });
  it.each(["2026-02-30T12:00:00Z", "2026-11-22T12:00:00", "2026-11-22", "2026-11-22T24:00:00Z", "2026-11-22T12:00:00+99:00", "1999-12-31T23:00:00Z"])("rejects invalid evaluation instant %s", evaluated_at => {
    expect(evaluate({ ...rooms(), evaluated_at }).status).toBe("unverified");
  });
  it.each(["", "EST", "Invalid/Zone", "CANARY_PRIVATE"])("rejects noncanonical/invalid timezone %s", churchTimeZone => {
    expect(evaluate({ ...rooms(), churchTimeZone }).findings).toEqual([]);
    expect(evaluate({ ...rooms(), churchTimeZone }).status).toBe("unverified");
  });
  it("rejects extra fields anywhere, symbols, sparse arrays, cycles and non-inert prototypes", () => {
    const values: unknown[] = [{ ...rooms(), notes: "CANARY_PRIVATE" }, { ...rooms(), evaluated_at: 2 },
      { ...rooms(), bookings: [{ ...rooms().bookings[0], person_name: "CANARY_PRIVATE" }] },
      { ...rooms(), binding: { ...rooms().binding, contact: "CANARY_PRIVATE" } }, new Date(), Object.assign(rooms(), { [Symbol("secret")]: 1 })];
    const sparse = rooms(); sparse.bookings = new Array(2); values.push(sparse);
    const cyclic = rooms() as unknown as Record<string, unknown>; cyclic.self = cyclic; values.push(cyclic);
    for (const value of values) {
      const result = evaluate(value);
      expect(result.status).toBe("unverified"); expect(result.findings).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("CANARY_PRIVATE");
    }
  });
});

describe("pre-enumerated, bound fresh scopes", () => {
  it.each(["partial", "stale", "denied", "unreadable", "unverified"] as const)("never confirms from %s bookings", completeness => {
    const input = rooms(); input.scopes[0]!.completeness = completeness;
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified"); expect(result.findings).toEqual([]);
    expect(result.unchecked_scope_ids).toContain("bookings");
  });
  it.each(["workspace_id", "organization_id", "access_epoch"] as const)("rejects source %s mismatch", key => {
    const input = rooms(); input.scopes[0]!.binding[key] = "other";
    expect(evaluateOperations(input).findings).toEqual([]);
    expect(evaluateOperations(input).uncertainties).toContainEqual(expect.objectContaining({ code: "binding-mismatch", scope_id: "bookings" }));
  });
  it.each(["future", "expired", "inverted", "ttl"])("does not restamp %s source clock", control => {
    const input = rooms();
    if (control === "future") input.scopes[0]!.check_time = "2026-11-22T12:00:00.001Z";
    if (control === "expired") input.scopes[0]!.valid_until = input.evaluated_at;
    if (control === "inverted") input.scopes[0]!.valid_until = "2026-11-22T11:00:00Z";
    if (control === "ttl") input.scopes[0]!.valid_until = "2026-11-24T12:00:00Z";
    const before = structuredClone(input);
    expect(evaluateOperations(input).status).toBe("unverified"); expect(evaluateOperations(input).findings).toEqual([]);
    expect(input).toEqual(before);
  });
  it("does not construct required scopes from successful rows or silently accept enumeration gaps", () => {
    const input = rooms(); input.scopes.pop(); input.resolutions = [];
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified"); expect(result.unchecked_scope_ids).toContain("pairs");
    expect(result.findings[0]?.certainty).toBe("uncertain");
    input.required_scopes.pop();
    expect(evaluateOperations(input).uncertainties).toContainEqual(expect.objectContaining({ code: "missing-scope" }));
  });
});

describe("malformed normalized control facts cannot become findings", () => {
  it.each(["", "a b", "x".repeat(65), "../../secret", "contact@example.test"])("rejects invalid opaque ID %s", booking_id => {
    const input = rooms(); input.bookings[0]!.booking_id = booking_id;
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [] });
  });
  it.each(["2026-11-22T12:99:00Z", "2026-11-22T10:00:00", "2026-02-30T00:00:00Z"])("rejects malformed booking instant %s", starts_at => {
    const input = rooms(); input.bookings[0]!.interval!.starts_at = starts_at;
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [] });
  });
  it("rejects inverted booking and resolution intervals", () => {
    const input = rooms(); input.bookings[0]!.interval!.ends_at = input.bookings[0]!.interval!.starts_at;
    expect(evaluateOperations(input).findings).toEqual([]); expect(evaluateOperations(input).status).toBe("unverified");
    const pair = rooms(); pair.resolutions[0]!.interval.ends_at = pair.resolutions[0]!.interval.starts_at;
    expect(evaluateOperations(pair)).toMatchObject({ status: "unverified", findings: [] });
  });
  it("rejects nested accessors without reading the canary", () => {
    let reads = 0; const input = rooms();
    Object.defineProperty(input.scopes[0]!, "check_time", { enumerable: true, get() { reads++; throw new Error("CANARY_NESTED"); } });
    const result = evaluateOperations(input);
    expect(result).toMatchObject({ status: "unverified", findings: [] }); expect(reads).toBe(0);
    expect(JSON.stringify(result)).not.toContain("CANARY_NESTED");
  });
  it("rejects raw errors and source labels without returning them", () => {
    for (const key of ["source", "errors"] as const) {
      const input = rooms() as unknown as { scopes: Array<Record<string, unknown>> };
      input.scopes[0]![key] = key === "source" ? "CANARY_PROVIDER_PROSE" : ["CANARY_PROVIDER_PROSE"];
      const result = evaluate(input);
      expect(result.status).toBe("unverified"); expect(JSON.stringify(result)).not.toContain("CANARY_PROVIDER_PROSE");
    }
  });
});
