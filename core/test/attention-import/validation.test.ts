import { expect, test } from "vitest";
import { evaluateAttentionImport } from "../../src/attention-import/index.js";
import { prepared } from "./prepared.js";

test("malformed, accessor-bearing, unbound and out-of-bounds imports return a closed error without reading getters", () => {
  let getterRead = false;
  const accessor = { ...prepared(), get unexpected() { getterRead = true; return "PRIVATE_CANARY_26"; } };
  const variants: unknown[] = [null, [], accessor, { ...prepared(), unexpected: "PRIVATE_CANARY_26" }];
  const change = (mutate: (input: ReturnType<typeof prepared>) => void) => {
    const input = prepared(); mutate(input); variants.push(input);
  };
  change(i => { i.kind = "live"; });
  change(i => { i.timezone = "UTC"; });
  change(i => { i.messages[0]!.id = "bad/id"; });
  change(i => { i.messages.push({ ...i.messages[0]! }); });
  change(i => { i.messages[0]!.body = "x".repeat(4097); });
  change(i => { i.messages = Array.from({ length: 33 }, (_, n) => ({ ...i.messages[0]!, id: "M" + n })); });
  change(i => { i.assertions = Array.from({ length: 65 }, () => ({ ...i.assertions[0]! })); });
  change(i => { i.assertions[0]!.anchor.quote = "not present"; });
  change(i => { i.assertions[0]!.anchor.start = 1; });
  change(i => { i.assertions[0]!.anchor.end = 1.5; });
  change(i => { i.assertions[0]!.not_contacted.quote = "not present"; });
  change(i => { i.assertions[0]!.message_id = "MSG-99"; });
  change(i => { i.assertions[0]!.event_id = "CAL-99"; });
  change(i => { i.assertions[0]!.kind = "send"; });
  change(i => { i.scopes.calendar.expected_ids = ["CAL-01", "CAL-01"]; });
  change(i => { i.scopes.calendar.outcome = "unknown"; });
  change(i => { i.scopes.calendar.expected_ids = ["OTHER"]; });
  for (const input of variants) {
    expect(() => evaluateAttentionImport(input)).not.toThrow();
    expect(evaluateAttentionImport(input)).toEqual({ ok: false, error: "invalid-import" });
  }
  expect(getterRead).toBe(false);
});

test("sparse/cyclic/symbol-bearing data, extra nested fields and source-kind ID collisions are rejected", () => {
  const symbolInput = prepared(); Object.defineProperty(symbolInput.messages[0]!, Symbol("hidden"), { value: "CANARY_26" });
  const cycle = prepared(); Object.assign(cycle.messages[0]!, { cycle });
  const sparse = prepared(); sparse.messages = new Array(1);
  const extra = prepared(); Object.assign(extra.assertions[0]!.anchor, { instruction: "CANARY_26" });
  const collision = prepared(); collision.scopes.mail.expected_ids.push("CAL-01");
  const invalidPrototype = { ...prepared(), host: new Date() };
  const nullAssertion = prepared(); (nullAssertion.assertions as unknown[])[0] = null;
  const badStatus = prepared(); badStatus.events[0]!.status = "tentative";
  for (const input of [symbolInput, cycle, sparse, extra, collision, invalidPrototype, nullAssertion, badStatus]) {
    expect(evaluateAttentionImport(input)).toEqual({ ok: false, error: "invalid-import" });
  }
});

test("invalid instants and impossible chronology cannot yield facts", () => {
  for (const value of ["2026-02-30T14:00:00Z", "2026-11-19", "not-a-time", "2026-11-19T14:00:00", "2026-11-19T25:00:00Z"]) {
    const input = prepared(); input.evaluated_at = value;
    expect(evaluateAttentionImport(input)).toEqual({ ok: false, error: "invalid-import" });
  }
  for (const mutate of [
    (i: ReturnType<typeof prepared>) => { i.imported_at = "2026-11-19T14:00:01Z"; },
    (i: ReturnType<typeof prepared>) => { i.messages[0]!.received_at = "2026-11-19T14:00:01Z"; },
    (i: ReturnType<typeof prepared>) => { i.events[0]!.modified_at = "2026-11-19T14:00:01Z"; },
    (i: ReturnType<typeof prepared>) => { i.events[0]!.end_at = i.events[0]!.start_at; },
    (i: ReturnType<typeof prepared>) => { i.valid_until = i.imported_at; },
    (i: ReturnType<typeof prepared>) => { i.valid_until = "2026-11-21T14:00:01Z"; },
  ]) {
    const input = prepared(); mutate(input);
    expect(evaluateAttentionImport(input)).toEqual({ ok: false, error: "invalid-import" });
  }
});
