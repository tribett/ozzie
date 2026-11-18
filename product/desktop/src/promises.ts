// Ozzie's promises, in one place (onboarding spec §0.2). Every sentence that promises what Ozzie does or never does with
// Planning Center, notes or names lives here, so it can't drift between screens; a test fails if one appears anywhere
// else in the app. Each has two forms: A for a build that cannot write to Planning Center (this one), B for a build that
// contains the write-back action, where a person confirms each change. The first screen shows before any church
// exists, so the form follows the build, not a church's switch.

/** Whether this build contains the write-back action. False on this branch: it can only read Planning Center. */
export const WRITE_BACK_BUILD = false;
export type PromiseForm = "A" | "B";
export const BUILD_FORM: PromiseForm = WRITE_BACK_BUILD ? "B" : "A";

const BOTH = {
  reads: {
    A: "It only reads. It never changes anything in Planning Center.",
    B: "It changes nothing in Planning Center unless you confirm that one change.",
  },
  readsShort: { A: "Reads only.", B: "Changes only what you confirm." },
  sends: {
    A: "It never sends anything for you. You send every note yourself.",
    B: "It never sends a message for you. You send every note yourself.",
  },
  // Exactly true: Ozzie replaces the names it reads; a name a person types into a question itself isn't caught (NM4).
  names: { A: "The names Ozzie reads from Planning Center stay on this Mac. The AI sees stand-ins instead.",
    B: "The names Ozzie reads from Planning Center stay on this Mac. The AI sees stand-ins instead." },
  people: {
    A: "It never scores or ranks anyone. It shows facts, where they came from and when it checked.",
    B: "It never scores or ranks anyone. It shows facts, where they came from and when it checked.",
  },
  /** S2's second reassurance. */
  connectReads: {
    A: "Ozzie only reads. It can't change anything in Planning Center.",
    B: "Ozzie changes nothing in Planning Center unless you confirm that one change.",
  },
  /** After "Planning Center's page may say Ozzie could also make changes…" (S2's fold, S3, the People question). */
  still: { A: "Ozzie still only reads.", B: "Ozzie still changes nothing you haven't confirmed." },
  /** After a sentence about connecting (Today's not-connected card, the People question). */
  connectAnd: { A: "Ozzie only reads.", B: "Ozzie changes nothing you haven't confirmed." },
  /** The end of "Copy this request" for Services access (row 7). */
  request: { A: "It only reads.", B: "It changes nothing unless I confirm it." },
} as const;
export type PromiseName = keyof typeof BOTH;

/** One promise in the build's form (or the form asked for, in tests). */
export const promise = (name: PromiseName, form: PromiseForm = BUILD_FORM): string => BOTH[name][form];
/** Every promise sentence in both forms, for the test that each lives only here. */
export const ALL_PROMISES: readonly string[] = Object.values(BOTH).flatMap(p => [p.A, p.B]);

/** S1's three lines, in order: reads, names, sends. */
export const firstScreenPromises = (form: PromiseForm = BUILD_FORM) => [promise("reads", form), promise("names", form), promise("sends", form)];

/** S1b, "What Ozzie does, and what it never does": the four promises, then the rest. */
export const allPromises = (form: PromiseForm = BUILD_FORM) => [
  promise("reads", form), promise("sends", form), promise("names", form), promise("people", form),
  "Background checks stay on this Mac. If you turn on the kids-team rule, Ozzie reads only whether a scheduled person has a current check, never its details, and never sends it to an AI.",
  "You can disconnect any time in Settings.",
  "Ozzie is open source: anyone can read exactly what it does.",
];
