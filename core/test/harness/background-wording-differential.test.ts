// The differential for background-check wording (review B2 L-2): the page splits every Unicode scalar value in the
// fixture's ranges into words exactly as native (background.rs tests) and ozzie.church (hosted-parity.test.ts) do,
// under each of the three foldings, shown by one digest all three must reach. With the oracle corpus's digest
// (background-wording-oracle.test.ts), neither side refuses what another lets through on what is tested.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { FOLDINGS, wordingTokens } from "../../src/harness/background-wording.js";

interface Differential { ranges: [number, number, number][]; digest: string }
const differential = JSON.parse(readFileSync(new URL("./background-wording-differential.json", import.meta.url), "utf8")) as Differential;

it("splits every character into words as native and ozzie.church do, under each folding (the pinned digest)", () => {
  const hash = createHash("sha256");
  let count = 0;
  for (const [start, end, step] of differential.ranges) {
    for (let at = start; at <= end; at += step) {
      if (at >= 0xd800 && at <= 0xdfff) continue;
      const text = `a${String.fromCodePoint(at)}b`;
      hash.update(`${at.toString(16).toUpperCase()}:${FOLDINGS.map(f => wordingTokens(text, f).join(" ")).join("/")}\n`, "utf8");
      count += 1;
    }
  }
  expect(count).toBeGreaterThan(200_000);
  expect(hash.digest("hex"), "a side's Unicode data differs: see the fixture's about").toBe(differential.digest);
}, 120_000);
