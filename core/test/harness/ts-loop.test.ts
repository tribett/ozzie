import { describe, expect, it } from "vitest";
import { TsLoop } from "../../src/harness/ts-loop.js";
import { runtimeConformance } from "./runtime-conformance.js";

runtimeConformance("TsLoop", () => new TsLoop());

describe("TsLoop", () => {
  it("is named ts", () => { expect(new TsLoop().name).toBe("ts"); });
});
