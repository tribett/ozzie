import { expect, test } from "vitest";
import { evaluateAttentionImport } from "../../src/attention-import/index.js";
import { prepared } from "./prepared.js";

test("a throwing Proxy property trap returns only the closed invalid-import error", () => {
  const input = new Proxy(prepared(), {
    get(target, key, receiver) {
      if (key === "kind") throw new Error("FICTIONAL_PRIVATE_ATTENTION_CANARY");
      return Reflect.get(target, key, receiver);
    },
  });
  expect(evaluateAttentionImport(input)).toEqual({ ok: false, error: "invalid-import" });
});

test.each([
  ["whole import", () => new Proxy(prepared(), {})],
  ["host binding", () => { const p = prepared(); p.host = new Proxy(p.host, {}); return p; }],
  ["scopes", () => { const p = prepared(); p.scopes = new Proxy(p.scopes, {}); return p; }],
  ["mail scope", () => { const p = prepared(); p.scopes.mail = new Proxy(p.scopes.mail, {}); return p; }],
  ["declared IDs", () => { const p = prepared(); p.scopes.mail.expected_ids = new Proxy(p.scopes.mail.expected_ids, {}); return p; }],
  ["messages", () => { const p = prepared(); p.messages = new Proxy(p.messages, {}); return p; }],
  ["message", () => { const p = prepared(); p.messages[0] = new Proxy(p.messages[0]!, {}); return p; }],
  ["event", () => { const p = prepared(); p.events[0] = new Proxy(p.events[0]!, {}); return p; }],
  ["assertion", () => { const p = prepared(); p.assertions[0] = new Proxy(p.assertions[0]!, {}); return p; }],
  ["quote anchor", () => { const p = prepared(); p.assertions[0]!.anchor = new Proxy(p.assertions[0]!.anchor, {}); return p; }],
] as const)("a transparent Proxy at %s returns a closed error when detachment fails", (_name, make) => {
  expect(evaluateAttentionImport(make())).toEqual({ ok: false, error: "invalid-import" });
});

test("a nested source Proxy cannot expose its thrown private message", () => {
  const input = prepared();
  input.messages[0] = new Proxy(input.messages[0]!, {
    get(target, key, receiver) {
      if (key === "body") throw new Error("FICTIONAL_PRIVATE_ATTENTION_CANARY");
      return Reflect.get(target, key, receiver);
    },
  });
  expect(evaluateAttentionImport(input)).toEqual({ ok: false, error: "invalid-import" });
});

test.each([null, "FICTIONAL_PRIVATE_ATTENTION_CANARY", 17])(
  "a Proxy throwing the non-Error value %s still returns a closed error", thrown => {
    const input = new Proxy(prepared(), {
      get(target, key, receiver) {
        if (key === "kind") throw thrown;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(evaluateAttentionImport(input)).toEqual({ ok: false, error: "invalid-import" });
  },
);

test("the boundary does not inspect or stringify the thrown object", () => {
  let reads = 0;
  const thrown = Object.create(null);
  for (const key of ["name", "message", "stack", "toString", Symbol.toPrimitive]) {
    Object.defineProperty(thrown, key, { get() { reads++; throw new Error("FICTIONAL_PRIVATE_ATTENTION_CANARY"); } });
  }
  const input = new Proxy(prepared(), {
    get(target, key, receiver) {
      if (key === "kind") throw thrown;
      return Reflect.get(target, key, receiver);
    },
  });
  expect(evaluateAttentionImport(input)).toEqual({ ok: false, error: "invalid-import" });
  expect(reads).toBe(0);
});

test("a revoked Proxy is rejected without escaping its TypeError", () => {
  const input = Proxy.revocable(prepared(), {});
  input.revoke();
  expect(evaluateAttentionImport(input.proxy)).toEqual({ ok: false, error: "invalid-import" });
});

test("ordinary accessors are rejected before cloning and never read", () => {
  let reads = 0;
  const input = prepared();
  Object.defineProperty(input.messages[0], "body", {
    enumerable: true, get() { reads++; throw new Error("FICTIONAL_PRIVATE_ATTENTION_CANARY"); },
  });
  expect(evaluateAttentionImport(input)).toEqual({ ok: false, error: "invalid-import" });
  expect(reads).toBe(0);
});

test("a valid binding mismatch retains the binding-denied response", () => {
  const input = prepared();
  input.host.account_id = "another-office";
  expect(evaluateAttentionImport(input)).toEqual({ ok: false, error: "binding-denied" });
});

test("a valid inert import still produces detached sources without changing the input", () => {
  const input = prepared();
  const before = structuredClone(input);
  const result = evaluateAttentionImport(input);
  expect(result).toMatchObject({ ok: true, status: "needs-attention", findings: [{ uncertain: false, urgent: true }] });
  if (result.ok) {
    const message = result.sources.find(source => source.id === "MSG-01");
    expect(message).toBeDefined();
    expect(message).not.toBe(input.messages[0]);
    if (message && "body" in message) message.body = "Reviewed locally.";
  }
  expect(input).toEqual(before);
});
