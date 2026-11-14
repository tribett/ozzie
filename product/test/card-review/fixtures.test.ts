import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CardReviewController } from "../../src/card-review/controller.js";

it.each(["png", "jpg"])("uses generated inert %s bytes through admission, without claiming actual browser decode", async extension => {
  const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/inert-1px.${extension}`, import.meta.url)));
  expect(bytes.length).toBeLessThan(1024);
  const controller = new CardReviewController("fictional", {foreground: () => true, createURL: () => "blob:inert", revokeURL() {}, decode: async () => true});
  const ticket = controller.choose(() => {})!;
  const result = await controller.select(ticket, [new File([bytes.buffer], "INERT_FIXTURE", {type: extension === "png" ? "image/png" : "image/jpeg"})]);
  expect(result).toBe("ok");
  controller.discard(ticket);
});
