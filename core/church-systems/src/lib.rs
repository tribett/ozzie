//! Read-only connections to church systems other than Planning Center: B1 Church, Breeze and Genesis, each in its own
//! module and registered below. The capture's shape (capture.rs) is the contract with the page.
//!
//! - `capture`: the one shape every system's read gives (`SystemCapture`), checked by `valid` before it leaves.
//! - `http`: the guarded GET-only client and the closed parts a request is built from.
//! - `run`: pacing, limits, the breaker and the record of every read.
//! - `keys`: a system's key in the Keychain.
//! - `b1`, `breeze`, `genesis`: one module per system, each following b1.rs.
//! - `church_address`: a church's address in its system, as a person types it (address.rs).
mod address;
pub mod b1;
pub mod breeze;
pub mod capture;
/// Developer-only: built only with the `dev-tool` feature, for the developer tool's own crate
/// (core/church-systems-dev).
#[cfg(feature = "dev-tool")]
#[doc(hidden)]
pub mod dev_support;
pub mod genesis;
pub mod http;
pub mod keys;
mod project;
pub mod run;
pub mod zones;

pub use address::church_address;
use capture::ReadWord;
pub use capture::{System, SystemCapture};

/// Something Ozzie can't read from a system, in closed words (the page has the sentences).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Unread {
    /// None of the three exposes background checks or a child flag.
    BackgroundChecks,
    /// No blockout dates in its API.
    Blockouts,
    /// No team tied to each role, so no one to suggest as help (Breeze: tags only).
    RoleTeams,
    /// What its volunteers' answer codes mean isn't confirmed yet, so every answer is unknown.
    AnswerCodes,
    /// Breeze: roles and volunteers entered in its newer volunteer scheduler aren't in its API (only the older
    /// volunteers page is), so an event scheduled there reads as having none.
    NewerVolunteerScheduler,
    /// No volunteer schedules at all, so no Sunday check.
    VolunteerSchedules,
    /// No attendance counts Ozzie reads.
    Attendance,
}

/// Where a system's reads go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hosts {
    /// These hosts and no others.
    Fixed(&'static [&'static str]),
    /// The church's own name under this domain (`<church>.breezechms.com`), checked by `http::ChurchHost`.
    ChurchSubdomainOf(&'static str),
}

/// What Ozzie gets from each system (its documented API, less what Ozzie doesn't read yet); the page's `SYSTEMS` in
/// core/src/church-systems/types.ts holds the same, and registry_tests.rs keeps them equal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Supplies {
    /// Open roles, who answered and who could help, for one dated service.
    pub sunday_check: bool,
    /// Roles with a wanted number.
    pub roles_with_number: bool,
    /// Volunteers' answers in the system's own words, which Ozzie maps. Off for Breeze until a live read confirms what
    /// its answer codes mean: until then a Breeze answer other than `unknown` is refused (the page's `answers` flag).
    pub answers: bool,
    /// Whether each person was sent the request (B1: an assignment's `notified`). Breeze and Genesis don't say: their
    /// `asked` is null.
    pub asked: bool,
    /// Whether the checked plan is shared with its volunteers yet (B1: the plan's `prepared`); the others don't say.
    pub plan_shared: bool,
    pub blockouts: bool,
    /// Other things the same people are scheduled for around the service (B1: other plans the same day).
    pub busy: bool,
    /// A team tied to each role, so its members are who could help (Breeze has tags only; Genesis, groups only).
    pub team_members: bool,
    /// None of the three exposes background checks or a child flag.
    pub background_checks: bool,
    /// People and households, groups, events and forms.
    pub groups_events_forms: bool,
    /// Attendance counts.
    pub attendance: bool,
    /// A church can connect without the vendor's staff.
    pub church_can_connect_alone: bool,
    /// The key can be limited to reading (Genesis only).
    pub read_only_key: bool,
    /// Whether the church's time zone is confirmed from a live read (none yet).
    pub time_zone_confirmed: bool,
    /// The church's time zone may be one the system set by default (B1 back-filled `America/New_York`), so the page
    /// confirms it with the person once.
    pub zone_may_be_default: bool,
}

impl System {
    pub const fn all() -> [System; 3] {
        [System::B1, System::Breeze, System::Genesis]
    }
    /// The word in a capture and a Keychain service name.
    pub fn word(self) -> &'static str {
        match self {
            System::B1 => "b1",
            System::Breeze => "breeze",
            System::Genesis => "genesis",
        }
    }
    /// The name people see, and every fact's source.
    pub fn display_name(self) -> &'static str {
        match self {
            System::B1 => "B1 Church",
            System::Breeze => "Breeze",
            System::Genesis => "Genesis",
        }
    }
    /// The hosts its reads contact.
    pub fn hosts(self) -> Hosts {
        match self {
            System::B1 => Hosts::Fixed(&[b1::HOST]),
            System::Breeze => Hosts::ChurchSubdomainOf(breeze::SUFFIX),
            // The address Genesis publishes for its REST API: a raw backend host that may change, so a change is a new
            // Ozzie version, never a typed address.
            System::Genesis => Hosts::Fixed(&[genesis::HOST]),
        }
    }
    /// How fast and how much a check may read.
    pub fn limits(self) -> run::Limits {
        match self {
            System::B1 => b1::LIMITS,
            System::Breeze => breeze::LIMITS,
            System::Genesis => genesis::LIMITS,
        }
    }
    /// What Ozzie can't read from it, beside what `supplies` says it can.
    pub fn cannot_supply(self) -> &'static [Unread] {
        match self {
            System::B1 => &[Unread::BackgroundChecks, Unread::Attendance],
            System::Breeze => &[
                Unread::BackgroundChecks,
                Unread::Blockouts,
                Unread::RoleTeams,
                Unread::NewerVolunteerScheduler,
            ],
            System::Genesis => &[Unread::BackgroundChecks, Unread::VolunteerSchedules],
        }
    }
    /// Its closed list of read words: a capture with any other word is refused, here and by the page.
    pub fn read_words(self) -> &'static [ReadWord] {
        match self {
            System::B1 => b1::WORDS,
            System::Breeze => breeze::WORDS,
            System::Genesis => genesis::WORDS,
        }
    }
    /// What it can supply.
    pub fn supplies(self) -> Supplies {
        let none = Supplies {
            sunday_check: false,
            roles_with_number: false,
            answers: false,
            asked: false,
            plan_shared: false,
            blockouts: false,
            busy: false,
            team_members: false,
            background_checks: false,
            groups_events_forms: true,
            attendance: false,
            church_can_connect_alone: true,
            read_only_key: false,
            time_zone_confirmed: false,
            zone_may_be_default: false,
        };
        match self {
            System::B1 => Supplies {
                sunday_check: true,
                roles_with_number: true,
                answers: true,
                asked: true,
                plan_shared: true,
                blockouts: true,
                busy: true,
                zone_may_be_default: true,
                team_members: true,
                // B1 has an attendance module, but no read Ozzie makes gives an event's attendance.
                attendance: false,
                ..none
            },
            System::Breeze => Supplies {
                sunday_check: true,
                roles_with_number: true,
                // Answer codes confirmed live 2026-11-17 (breeze.rs `ANSWER_CODES`).
                answers: true,
                asked: false,
                plan_shared: false,
                // How many people were checked in to the service by name (`type=person`), once it has ended.
                // Anonymous head counts aren't included (their shape is unconfirmed).
                attendance: true,
                ..none
            },
            System::Genesis => Supplies {
                // No assignments at all, so nothing to refuse (as the page has it).
                answers: true,
                asked: false,
                plan_shared: false,
                attendance: true,
                read_only_key: true,
                ..none
            },
        }
    }
}

#[cfg(test)]
mod b1_docs_tests;
#[cfg(test)]
mod hosts_tests;
#[cfg(test)]
mod registry_tests;
#[cfg(test)]
mod review_c_tests;
#[cfg(test)]
mod review_tests;
#[cfg(test)]
mod seam_tests;
// The `dev-tool` feature opens a raw read (`dev_support::shape_read`) and the test fakes. The tool is only ever a
// debug build, so a release build with the feature on is refused: it can't reach the app through a dependent or
// through Cargo joining features in one workspace.
#[cfg(all(feature = "dev-tool", not(debug_assertions)))]
compile_error!(
    "the dev-tool feature is for the developer tool's debug build only, never a release build"
);

// This crate's own test fakes. With the `dev-tool` feature (never on by default), they're also public, for the
// developer tool's tests: fakes only, no real Keychain, network or clock.
#[cfg(all(test, not(feature = "dev-tool")))]
mod test_support;
#[cfg(feature = "dev-tool")]
#[doc(hidden)]
pub mod test_support;
#[cfg(test)]
mod zoned_tests;
