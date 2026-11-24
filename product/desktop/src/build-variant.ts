// Which copy of Ozzie this page runs in: the real app, or the test copy of Ozzie, a build variant made only for clicking
// through B1 Church, Breeze and the example church without touching the real app (native src-tauri/src/test_copy.rs).
// The test copy sets a fixed marker, which nothing can change, before any of this page's script runs; the real app
// never does, so here nothing changes for it. The page shows "TEST COPY" on every page, names the test copy's own
// Keychain items, and offers no Planning Center sign-in (native refuses one in the test copy too).

/** The marker's name (native test_copy.rs `PAGE_MARKER`). */
export const TEST_COPY_MARKER = "__OZZIE_TEST_COPY__";
/** In front of every Keychain item's name in the test copy (native variant.rs `TEST_COPY_KEYCHAIN_PREFIX`). */
export const TEST_COPY_KEYCHAIN_PREFIX = "church.ozzie.desktop.test/";

export interface BuildVariant {
  testCopy: boolean;
  /** What the Keychain items' names start with in this copy: nothing in the real app. */
  keychainPrefix: string;
}
export const REAL_APP: BuildVariant = Object.freeze({ testCopy: false, keychainPrefix: "" });
export const TEST_COPY: BuildVariant = Object.freeze({ testCopy: true, keychainPrefix: TEST_COPY_KEYCHAIN_PREFIX });

/** The copy a marker says: the test copy for native's marker (an object), the real app for anything else or none. */
export function variantOf(marker: unknown): BuildVariant {
  return marker !== null && typeof marker === "object" ? TEST_COPY : REAL_APP;
}
/** This page's copy, read once when the page starts. */
export const buildVariant: BuildVariant = variantOf((globalThis as Record<string, unknown>)[TEST_COPY_MARKER]);

/** A Keychain item's name as `variant` keeps it (native `keychain_service!`): `real` itself in the real app. */
export const keychainName = (real: string, variant: BuildVariant = buildVariant): string => variant.keychainPrefix + real;

/** The banner's words, on every page of the test copy. */
export const TEST_COPY_BANNER = "TEST COPY";
/** What the banner says to a screen reader, and as its tooltip. */
export const TEST_COPY_NOTE = "This is the test copy of Ozzie, not the real app. It keeps its own data and never signs in to Planning Center.";
/** Planning Center's place on "What does your church use?" in the test copy. */
export const TEST_COPY_NO_PLANNING_CENTER = "Not in the test copy: Planning Center's sign-in belongs to the real Ozzie on this Mac.";
/** The test copy's extra way to connect B1 Church or Breeze: the test key the developer tool copied into its Keychain. */
export const TEST_COPY_USE_KEY = "Use the test key on this Mac";
