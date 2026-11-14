// The shared runtime conformance suite, applied to the Pi loop (the TS loop applies it in ts-loop.test.ts).
import { PiLoop } from "../../src/harness/pi-loop.js";
import { runtimeConformance } from "./runtime-conformance.js";

runtimeConformance("PiLoop", () => new PiLoop());
