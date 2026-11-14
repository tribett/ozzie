import { expect, test } from "vitest";
import { CardReview } from "../../../core/src/card-review/lifecycle.js";
import { CardReviewController } from "../../src/card-review/controller.js";

async function active(seam: "core" | "controller") {
  if (seam === "core") {
    const review = new CardReview("fictional");
    const ticket = review.choose()!;
    expect(review.attach(ticket, [{ size: 8, type: "image/png" }])).toBe("ok");
    expect(review.ready(ticket)).toBe("ok");
    return { review, ticket };
  }
  const review = new CardReviewController("fictional", {
    foreground: () => true, createURL: () => "blob:synthetic", revokeURL() {}, decode: async () => true,
  });
  const ticket = review.choose(() => {})!;
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(await review.select(ticket, [new File([bytes], "inert", { type: "image/png" })])).toBe("ok");
  return { review, ticket };
}

test("an event cannot change its text after validation to exceed the field bound", () => {
  const review = new CardReview("fictional");
  const ticket = review.choose()!;
  expect(review.attach(ticket, [{ size: 8, type: "image/png" }])).toBe("ok");
  expect(review.ready(ticket)).toBe("ok");
  let reads = 0;
  const event = new Proxy({ card: 1, field: "name", text: "x", state: "typed" }, {
    get(target, key, receiver) {
      if (key === "text") return ++reads <= 3 ? "x" : "x".repeat(257);
      return Reflect.get(target, key, receiver);
    },
  });
  expect(review.edit(ticket, event)).toBe("invalid");
  review.render(view => expect(view.cards[0]!.fields.name.text.length).toBe(0));
  review.discard();
});

for (const seam of ["core", "controller"] as const) {
  for (const method of ["edit", "review"] as const) {
    test(`${seam} ${method} refuses a throwing Proxy without exposing its error`, async () => {
      const { review, ticket } = await active(seam);
      const target = method === "edit" ? { card: 1, field: "name", text: "x", state: "typed" } : { card: 1, acknowledge: true };
      const event = new Proxy(target, { get(object, key, receiver) {
        if (key === "card") throw new Error("FICTIONAL_CARD_ERROR");
        return Reflect.get(object, key, receiver);
      } });
      expect(review[method](ticket, event)).toBe("invalid");
      review.discard();
    });

    test(`${seam} ${method} rejects ordinary accessors without reading them`, async () => {
      const { review, ticket } = await active(seam);
      let reads = 0;
      const event = method === "edit" ? { field: "name", text: "x", state: "typed" } : { acknowledge: true };
      Object.defineProperty(event, "card", { enumerable: true, get() { reads++; return 1; } });
      expect(review[method](ticket, event)).toBe("invalid");
      expect(reads).toBe(0);
      review.discard();
    });

    test(`${seam} ${method} does not inspect a malicious thrown object`, async () => {
      const { review, ticket } = await active(seam);
      let reads = 0;
      const thrown = Object.create(null);
      for (const key of ["message", "name", "stack", "toString", Symbol.toPrimitive]) {
        Object.defineProperty(thrown, key, { get() { reads++; throw new Error("FICTIONAL_CARD_ERROR"); } });
      }
      const event = new Proxy({ card: 1, field: "name", text: "x", state: "typed" }, {
        get() { throw thrown; },
      });
      expect(review[method](ticket, event)).toBe("invalid");
      expect(reads).toBe(0);
      review.discard();
    });
  }

  test(`${seam} rejects changing reads and preserves exact-bound reviewed wording`, async () => {
    const { review, ticket } = await active(seam);
    for (const field of ["name", "phone", "email", "request"]) {
      expect(review.edit(ticket, { card: 1, field, text: "", state: "blank" })).toBe("ok");
    }
    expect(review.edit(ticket, { card: 1, field: "name", text: "x".repeat(256), state: "typed" })).toBe("ok");
    expect(review.review(ticket, { card: 1, acknowledge: false })).toBe("ok");
    let reads = 0;
    const event = new Proxy({ card: 1, field: "name", text: "x", state: "typed" }, {
      get(target, key, receiver) {
        if (key === "text") return ++reads <= 3 ? "x" : "x".repeat(257);
        return Reflect.get(target, key, receiver);
      },
    });
    expect(review.edit(ticket, event)).toBe("invalid");
    expect(review.edit(ticket, { card: 1, field: "name", text: "x".repeat(257), state: "typed" })).toBe("invalid");
    review.render(view => {
      expect(view.cards[0]!.fields.name.text.length).toBe(256);
      expect(view.cards[0]!.reviewed).toBe(true);
    });
    expect(review.finish(ticket)).toBe("finished");
  });

  test(`${seam} refuses stale input before any property trap`, async () => {
    const { review, ticket } = await active(seam);
    review.discard(ticket);
    let reads = 0;
    const event = new Proxy({}, { get() { reads++; throw new Error("FICTIONAL_CARD_ERROR"); } });
    expect(review.edit(ticket, event)).toBe("closed");
    expect(review.review(ticket, event)).toBe("closed");
    expect(reads).toBe(0);
  });
}

test.each(["array", "image"])("core attach refuses a %s Proxy and clears its selection", kind => {
  const review = new CardReview("fictional");
  const ticket = review.choose()!;
  const row = { size: 8, type: "image/png" };
  const input = kind === "array" ? new Proxy([row], {}) : [new Proxy(row, {
    get(target, key, receiver) {
      if (key === "size") throw new Error("FICTIONAL_CARD_ERROR");
      return Reflect.get(target, key, receiver);
    },
  })];
  expect(review.attach(ticket, input)).toBe("invalid");
  expect(review.current(ticket)).toBe(false);
  review.render(view => expect(view.cards.length).toBe(0));
  expect(review.choose()).not.toBeNull();
  review.discard();
});
