//! Which copy of Ozzie this build is: the real app, or the test copy a coordinator clicks through B1 Church, Breeze
//! and the example church in without touching the real app (owner decision 2026-11-24; docs/build/test-copy.md in the
//! private repository). Chosen once, at build time, by this crate's `test-copy` feature, which is off by default: the
//! desktop app turns it on only through its own `test-copy` feature and tauri.test-copy.conf.json together, and the
//! release build passes neither.
//!
//! The test copy has its own bundle identifier (so its own app data, caches and web view storage) and puts
//! `TEST_COPY_KEYCHAIN_PREFIX` in front of every Keychain service name the app uses (`keychain_service!`). Keychain
//! services match exactly, and no real name starts with the prefix, so nothing the test copy saves, reads, lists or
//! deletes can be one of the real app's items.

/// The real app's bundle identifier (tauri.conf.json `identifier`): its app data, caches and web view storage are
/// named after it.
pub const REAL_APP_IDENTIFIER: &str = "church.ozzie.desktop";
/// The test copy's bundle identifier (tauri.test-copy.conf.json `identifier`).
pub const TEST_COPY_APP_IDENTIFIER: &str = "church.ozzie.desktop.test";

#[doc(hidden)]
#[macro_export]
macro_rules! __test_copy_keychain_prefix {
    () => {
        "church.ozzie.desktop.test/"
    };
}
/// In front of every Keychain service name in the test copy: its own identifier and a slash.
pub const TEST_COPY_KEYCHAIN_PREFIX: &str = crate::__test_copy_keychain_prefix!();

/// Whether this build is the test copy.
pub const IS_TEST_COPY: bool = cfg!(feature = "test-copy");
/// This build's bundle identifier.
pub const APP_IDENTIFIER: &str = if IS_TEST_COPY {
    TEST_COPY_APP_IDENTIFIER
} else {
    REAL_APP_IDENTIFIER
};

/// A Keychain service name as this build uses it: the real app's name itself, or in the test copy that name with
/// `TEST_COPY_KEYCHAIN_PREFIX` in front. A literal in, a `&'static str` constant out.
#[cfg(not(feature = "test-copy"))]
#[macro_export]
macro_rules! keychain_service {
    ($real:literal) => {
        $real
    };
}
/// A Keychain service name as this build uses it: the real app's name itself, or in the test copy that name with
/// `TEST_COPY_KEYCHAIN_PREFIX` in front. A literal in, a `&'static str` constant out.
#[cfg(feature = "test-copy")]
#[macro_export]
macro_rules! keychain_service {
    ($real:literal) => {
        concat!($crate::__test_copy_keychain_prefix!(), $real)
    };
}

/// The test copy's name for one of the real app's Keychain services, whichever copy this build is: for the developer
/// tool, which copies a test key from the real name to the test copy's (`copy-to-test`). None for a name that already
/// has the prefix, so a name is never prefixed twice.
pub fn test_copy_service(real: &str) -> Option<String> {
    (!real.starts_with(TEST_COPY_KEYCHAIN_PREFIX) && !real.is_empty())
        .then(|| format!("{TEST_COPY_KEYCHAIN_PREFIX}{real}"))
}

/// Where a Planning Center sign-in is kept in this Mac's Keychain (one item per church).
pub const PLANNING_CENTER_SERVICE: &str =
    crate::keychain_service!("church.ozzie.planning-center.v1");

/// The real app's own name for every Keychain service it uses: written out here, so a test can hold this build's
/// names to them (`this_builds_services`).
pub const REAL_SERVICES: [&str; 8] = [
    "church.ozzie.planning-center.v1",
    "church.ozzie.model.v1",
    "church.ozzie.phone-notice.v1",
    "church.ozzie.source-links.v1",
    "church.ozzie.calendar-links.v1",
    "church.ozzie.church-system.b1.v1",
    "church.ozzie.church-system.breeze.v1",
    "church.ozzie.church-system.genesis.v1",
];

/// This crate's Keychain services as this build names them, in `REAL_SERVICES`' order (the church systems' three are
/// in core/church-systems keys.rs, built with the same macro).
pub fn this_builds_services() -> [&'static str; 5] {
    [
        PLANNING_CENTER_SERVICE,
        crate::model::KEYCHAIN_SERVICE,
        crate::phone_notice::KEYCHAIN_SERVICE,
        crate::sheet_link::KEYCHAIN_SERVICE,
        crate::calendar_link::KEYCHAIN_SERVICE,
    ]
}

#[cfg(test)]
#[path = "variant_tests.rs"]
mod tests;
