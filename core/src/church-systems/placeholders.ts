// The only way people's names and the church's own words leave a capture from another church system. Names never go
// to a model: they stay on this Mac, and placeholders stand in for them under the scope `<system>:<church id>`.
// coverage.ts and facts.ts return ids only; a page resolves ids to words here, locally.
import type { SystemCapture } from "./types.js";

/** The placeholder scope for this capture's people: `<system>:<church id>`, for example `b1:CHU0000cedar`. */
export const placeholderScope = (capture: Pick<SystemCapture, "system" | "church">): string => `${capture.system}:${capture.church.id}`;

/** Own entries only, on a null prototype: an id such as "constructor" finds nothing it doesn't hold. */
function own(record: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (Object.getPrototypeOf(record) === null) return record;
  const out = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(record)) out[key] = value;
  return Object.freeze(out);
}

/** Person id to name. LOCAL ONLY: never into a model request, a shared check or anything coverage.ts or facts.ts returns. */
export const namesOf = (capture: Pick<SystemCapture, "names">): Readonly<Record<string, string>> => own(capture.names);

/** "church", "service" and "<position|team|group|event|form>:<id>" to the church's own words. LOCAL ONLY, like names. */
export const labelsOf = (capture: Pick<SystemCapture, "labels">): Readonly<Record<string, string>> => own(capture.labels);
