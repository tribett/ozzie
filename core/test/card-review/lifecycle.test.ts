import { describe, expect, it } from "vitest";
import { CardReview } from "../../src/card-review/lifecycle.js";

const image = { size: 68, type: "image/png" };
describe("temporary manual review", () => {
  it("requires explicit review of the exact human wording before closing with no retained view", () => {
    const review = new CardReview("workspace-a");
    const ticket = review.choose();
    expect(typeof ticket).toBe("number");
    expect(review.attach(ticket!, [image])).toBe("ok");
    expect(review.ready(ticket!)).toBe("ok");
    expect(review.finish(ticket!)).toBe("review-required");
    expect(review.edit(ticket!, { card: 1, field: "request", text: "  Fictional canary: please call.\n", state: "typed" })).toBe("ok");
    expect(review.edit(ticket!, { card: 1, field: "name", text: "Invented Visitor", state: "typed" })).toBe("ok");
    for (const field of ["phone", "email"]) {
      expect(review.edit(ticket!, { card: 1, field, text: "", state: "blank" })).toBe("ok");
    }
    let held: Parameters<CardReview["render"]>[0] extends (v: infer V) => void ? V : never;
    review.render(view => { held = view; expect(view.cards[0]?.fields.request.text).toBe("  Fictional canary: please call.\n"); });
    expect(review.review(ticket!, { card: 1, acknowledge: false })).toBe("ok");
    expect(review.finish(ticket!)).toBe("finished");
    expect(held!.cards).toEqual([]);
    expect(review.finish(ticket!)).toBe("closed");
  });
});

describe("bounded human input and file admission", () => {
  it.each([[], Array(9).fill(image), [{ size: 8 * 1024 * 1024 + 1, type: "image/png" }],
    Array(4).fill({ size: 8 * 1024 * 1024, type: "image/jpeg" }), [{ size: NaN, type: "image/png" }],
    [{ size: 1.5, type: "image/png" }], [{ size: 12, type: "image/svg+xml" }]].map(images => ({ images })))("refuses invalid batch $#: no retained content", ({ images }) => {
    const review = new CardReview("a");
    const ticket = review.choose()!;
    expect(review.attach(ticket, images)).toBe("invalid");
    expect(review.ready(ticket)).toBe("closed");
  });
  it("refuses oversized text and contradictory blank states without losing current wording", () => {
    const review = new CardReview("a"), ticket = review.choose()!;
    review.attach(ticket, [image]); review.ready(ticket);
    expect(review.edit(ticket!, { card: 1, field: "name", text: "Invented", state: "typed" })).toBe("ok");
    expect(review.edit(ticket!, { card: 1, field: "name", text: "x".repeat(257), state: "typed" })).toBe("invalid");
    expect(review.edit(ticket!, { card: 1, field: "request", text: "x", state: "blank" })).toBe("invalid");
    review.render(view => expect(view.cards[0]?.fields.name.text).toBe("Invented"));
  });
});


describe("review validity and revocable generations", () => {
  const open = () => {
    const review = new CardReview("a"), ticket = review.choose()!;
    review.attach(ticket, [image, image]); review.ready(ticket);
    return { review, ticket };
  };
  it("keeps uncertainty after acknowledgment, invalidates review on any edit, and removes one card", () => {
    const {review, ticket} = open();
    for (const field of ["name", "phone", "email", "request"]) review.edit(ticket, {card: 1, field, text: "", state: "blank"});
    review.edit(ticket, {card: 1, field: "phone", text: "555-01?4", state: "unclear"});
    expect(review.review(ticket, {card: 1, acknowledge: false})).toBe("review-required");
    expect(review.review(ticket, {card: 1, acknowledge: true})).toBe("ok");
    review.render(view => {
      expect(view.cards[0]?.fields.phone.state).toBe("unclear");
      expect(view.cards[0]?.reviewed).toBe(true);
    });
    review.edit(ticket, {card: 1, field: "phone", text: "555-01?4", state: "unclear"});
    expect(review.finish(ticket)).toBe("review-required");
    review.review(ticket, {card: 1, acknowledge: true});
    expect(review.remove(ticket, 2)).toBe("ok");
    expect(review.remove(ticket, 2)).toBe("closed");
    expect(review.finish(ticket)).toBe("finished");
  });
  it("invalidates old handles and events after close, context change and a fresh batch", () => {
    const {review, ticket} = open();
    let heldField: {readonly text: string};
    review.edit(ticket, {card: 1, field: "name", text: "PRIVATE_CANARY", state: "typed"});
    review.render(view => { heldField = view.cards[0]!.fields.name; });
    review.context("b");
    expect(heldField!.text).toBe("");
    const next = review.choose()!;
    review.attach(next, [image]); review.ready(next);
    expect(review.edit(ticket, {card: 1, field: "name", text: "LATE_CANARY", state: "typed"})).toBe("closed");
    expect(review.ready(ticket)).toBe("closed");
    expect(review.finish(ticket)).toBe("closed");
    expect(review.discard(ticket)).toBe("closed");
    review.render(view => expect(view.cards[0]?.fields.name.text).toBe(""));
  });
  it.each(["blur", "hidden", "pagehide"] as const)("clears active content immediately on %s", cause => {
    const {review, ticket} = open();
    review.foreground(false, cause);
    expect(review.current(ticket)).toBe(false);
    expect(review.choose()).toBe(null);
    review.foreground(true);
    expect(review.choose()).not.toBe(null);
  });
  it("allows initial picker blur but requires focus, cancels context-bound selection and signout", () => {
    const review = new CardReview("a"), ticket = review.choose()!;
    review.foreground(false, "blur");
    expect(review.attach(ticket, [image])).toBe("closed");
    review.foreground(true);
    expect(review.attach(ticket, [image])).toBe("closed");
    const next = review.choose()!;
    review.context(null);
    expect(review.attach(next, [image])).toBe("closed");
    expect(review.choose()).toBe(null);
  });
});

describe("fixed boundary cases", () => {
  it.each([
    { images: Array(8).fill({size: 1, type: "image/png"}) },
    { images: Array(3).fill({size: 8 * 1024 * 1024, type: "image/jpeg"}) },
  ])("admits exact count/size limits ($#)", ({images}) => {
    const review = new CardReview("a"), ticket = review.choose()!;
    expect(review.attach(ticket, images)).toBe("ok");
    expect(review.ready(ticket)).toBe("ok");
    review.render(view => expect(view.cards.length).toBe(images.length));
  });
  it("rejects total limit plus one and nonintegral/negative/infinite sizes", () => {
    for (const images of [
      [{size: 8*1024*1024, type: "image/png"}, {size: 8*1024*1024, type: "image/png"}, {size: 8*1024*1024, type: "image/png"}, {size: 1, type: "image/png"}],
      ...[-1, 0, Infinity, -Infinity, 0.1].map(size => [{size, type: "image/png"}]),
    ]) {
      const review = new CardReview("a"), ticket = review.choose()!;
      expect(review.attach(ticket, images)).toBe("invalid");
      review.render(view => expect(view.cards).toEqual([]));
    }
  });
  it("counts Unicode code points, preserves whitespace, and refuses request limit plus one", () => {
    const review = new CardReview("a"), ticket = review.choose()!;
    review.attach(ticket, [image]); review.ready(ticket);
    expect(review.edit(ticket, {card: 1, field: "name", text: "😀".repeat(256), state: "typed"})).toBe("ok");
    expect(review.edit(ticket, {card: 1, field: "name", text: "😀".repeat(257), state: "typed"})).toBe("invalid");
    expect(review.edit(ticket, {card: 1, field: "request", text: "😀".repeat(2000), state: "typed"})).toBe("ok");
    expect(review.edit(ticket, {card: 1, field: "request", text: "😀".repeat(2001), state: "typed"})).toBe("invalid");
  });
  it("refuses accessor, inherited, cyclic, function and extra-key events without invoking accessors", () => {
    const review = new CardReview("a"), ticket = review.choose()!;
    review.attach(ticket, [image]); review.ready(ticket);
    let observed = false;
    const accessor = Object.defineProperty({}, "card", {enumerable: true, get() { observed = true; throw Error("PRIVATE_CANARY"); }});
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const event of [accessor, cycle, Object.create({card: 1}), {card: 1, field: "name", text: () => "private", state: "typed"},
      {card: 1, field: "name", text: "", state: "blank", extra: "PRIVATE_CANARY"}, null, [], Symbol("private")]) {
      expect(review.edit(ticket, event)).toBe("invalid");
      expect(review.review(ticket, event)).toBe("invalid");
    }
    expect(observed).toBe(false);
    review.discard();
    expect(review.edit(ticket, accessor)).toBe("closed");
  });
  it("preserves not-readable state after explicit review and supports deleting the final card", () => {
    const review = new CardReview("a"), ticket = review.choose()!;
    review.attach(ticket, [image]); review.ready(ticket);
    for (const field of ["name", "phone", "email", "request"]) review.edit(ticket, {card: 1, field, text: "", state: "not-readable"});
    expect(review.review(ticket, {card: 1, acknowledge: false})).toBe("review-required");
    expect(review.review(ticket, {card: 1, acknowledge: true})).toBe("ok");
    review.render(view => expect(view.cards[0]?.fields.request.state).toBe("not-readable"));
    expect(review.remove(ticket, 1)).toBe("ok");
    expect(review.finish(ticket)).toBe("closed");
    expect(review.choose()).not.toBe(null);
  });
  it("cancels a pending picker on hidden/pagehide and rejects duplicate readiness", () => {
    for (const cause of ["hidden", "pagehide"] as const) {
      const review = new CardReview("a"), ticket = review.choose()!;
      review.foreground(false, cause); review.foreground(true);
      expect(review.attach(ticket, [image])).toBe("closed");
    }
    const review = new CardReview("a"), ticket = review.choose()!;
    review.attach(ticket, [image]); review.ready(ticket);
    expect(review.ready(ticket)).toBe("closed");
    expect(review.choose()).toBe(null);
    expect(review.discard(ticket)).toBe("discarded");
    expect(review.discard(ticket)).toBe("closed");
  });
});
