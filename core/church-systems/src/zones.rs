//! Time zone offsets, without a time zone package: a `ZoneOffsets` answers what offset a named IANA zone has at a
//! moment, and from that turns a local wall-clock time into an instant, or says that it can't.
//!
//! - A wall-clock time that doesn't exist in the zone (the hour skipped when clocks go forward) is `Gap`; one that
//!   happens twice (the hour repeated when clocks go back) is `Ambiguous`. Neither is ever turned into a guess: the
//!   caller leaves the field out and says its read is `truncated`.
//! - `SystemZones` asks this Mac's own time zone data (CoreFoundation's `CFTimeZone`). Elsewhere it knows no zone, so
//!   the reads behave as they do without one.
//!
//! The unsafe code is the one call that makes a `CFTimeZone` from a name (`system::offset_seconds`).
use crate::capture::{Date, Time, ZoneName};

/// The largest offset any zone has had (UTC±14 today; ±18 h is the bound CoreFoundation and RFC 3339 tooling use).
const MAX_OFFSET_SECONDS: i32 = 18 * 3600;

/// What a local wall-clock time is in a zone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalResult {
    /// One instant, written with its offset.
    Single(Time),
    /// Skipped: the clocks went forward over it.
    Gap,
    /// Happened twice: the clocks went back over it (the earlier and the later instant).
    Ambiguous(Time, Time),
    /// The zone isn't known here.
    Unknown,
}

/// Offsets of named zones. The real one is `SystemZones`; tests use a fixed table.
pub trait ZoneOffsets: Send + Sync {
    /// Seconds east of UTC in `zone` at `at_unix` (seconds since 1970-01-01T00:00:00Z); `None` when the zone isn't
    /// known here.
    fn offset_seconds(&self, zone: &ZoneName, at_unix: i64) -> Option<i32>;

    /// The instant a local wall-clock time is in `zone`: `date` at `seconds_of_day` past local midnight. Every offset
    /// the zone has within a day either side is tried; the ones that give back the same offset at their instant are
    /// the answers (none: a gap; two: ambiguous).
    fn local_to_instant(&self, zone: &ZoneName, date: Date, seconds_of_day: i64) -> LocalResult {
        let local = date.days() * 86_400 + seconds_of_day;
        let mut offsets = Vec::new();
        for probe in [local - 86_400, local, local + 86_400] {
            match self.offset_seconds(zone, probe) {
                Some(o) if !offsets.contains(&o) => offsets.push(o),
                Some(_) => {}
                None => return LocalResult::Unknown,
            }
        }
        let mut found: Vec<(i64, i32)> = offsets
            .into_iter()
            .map(|o| (local - i64::from(o), o))
            .filter(|(at, o)| self.offset_seconds(zone, *at) == Some(*o))
            .collect();
        found.sort();
        found.dedup_by_key(|(at, _)| *at);
        let write = |o: i32| Time::from_local(date, seconds_of_day, o);
        match found.as_slice() {
            [] => LocalResult::Gap,
            [(_, o)] => write(*o).map_or(LocalResult::Unknown, LocalResult::Single),
            [(_, a), (_, b)] => match (write(*a), write(*b)) {
                (Some(a), Some(b)) => LocalResult::Ambiguous(a, b),
                _ => LocalResult::Unknown,
            },
            _ => LocalResult::Unknown,
        }
    }

    /// The local calendar day `time` falls on in `zone`, or `None` when the zone isn't known here.
    fn local_day(&self, zone: &ZoneName, time: &Time) -> Option<Date> {
        let at = time.unix_millis().div_euclid(1000);
        let offset = self.offset_seconds(zone, at)?;
        Date::from_days((at + i64::from(offset)).div_euclid(86_400))
    }

    /// The instant of local midnight starting `date` in `zone`.
    fn local_midnight(&self, zone: &ZoneName, date: Date) -> LocalResult {
        self.local_to_instant(zone, date, 0)
    }
}

/// Whether this Mac's zone data knows `zone` now (gives an offset at `clock`'s moment). A zone it doesn't know, such as
/// a name in the wrong case, can't place anything, so it's never used and never emitted as a capture's zone.
pub fn known(zones: &dyn ZoneOffsets, zone: &ZoneName, clock: &dyn crate::run::Clock) -> bool {
    zones
        .offset_seconds(zone, clock.unix_millis().div_euclid(1000))
        .is_some()
}

/// No zone is known: every read behaves as it does without a zone.
pub struct NoZones;
impl ZoneOffsets for NoZones {
    fn offset_seconds(&self, _: &ZoneName, _: i64) -> Option<i32> {
        None
    }
}

/// This Mac's own time zone data.
pub struct SystemZones;
impl ZoneOffsets for SystemZones {
    fn offset_seconds(&self, zone: &ZoneName, at_unix: i64) -> Option<i32> {
        let seconds = system::offset_seconds(zone.as_str(), at_unix)?;
        (seconds.abs() <= MAX_OFFSET_SECONDS).then_some(seconds)
    }
}

#[cfg(target_os = "macos")]
mod system {
    use core_foundation::base::{TCFType, kCFAllocatorDefault};
    use core_foundation::date::CFDate;
    use core_foundation::string::CFString;
    use core_foundation::timezone::CFTimeZone;
    use core_foundation_sys::timezone::CFTimeZoneCreateWithName;

    /// Seconds from 1970-01-01 to CoreFoundation's reference date, 2001-01-01T00:00:00Z.
    const CF_EPOCH: i64 = 978_307_200;

    /// The offset of the zone named `name` at `at_unix`, from CoreFoundation's own zone data; `None` when it doesn't
    /// know the name. Abbreviations (`EST`) aren't accepted, only zone names.
    pub(super) fn offset_seconds(name: &str, at_unix: i64) -> Option<i32> {
        let name = CFString::new(name);
        // SAFETY: `kCFAllocatorDefault` is CoreFoundation's own allocator constant, and `name` is a valid CFString that
        // lives across the call (CoreFoundation copies what it needs). The function follows the Create rule: it
        // returns a new +1 reference or null, and it neither keeps nor frees `name`.
        let zone =
            unsafe { CFTimeZoneCreateWithName(kCFAllocatorDefault, name.as_concrete_TypeRef(), 0) };
        if zone.is_null() {
            return None;
        }
        // SAFETY: `zone` is the non-null +1 reference just created, and nothing else owns it; wrapping it under the
        // Create rule hands that one reference to `CFTimeZone`, which releases it once when dropped.
        let zone = unsafe { CFTimeZone::wrap_under_create_rule(zone) };
        let seconds = zone.seconds_from_gmt(CFDate::new((at_unix - CF_EPOCH) as f64));
        (seconds.is_finite() && seconds.fract() == 0.0 && seconds.abs() < 86_400.0)
            .then_some(seconds as i32)
    }
}
#[cfg(not(target_os = "macos"))]
mod system {
    pub(super) fn offset_seconds(_: &str, _: i64) -> Option<i32> {
        None
    }
}

#[cfg(test)]
#[path = "zones_tests.rs"]
pub(crate) mod tests;
