//! The capture: what native hands the page after reading another church system, version 1. One shape for every
//! system, JSON in snake_case, unknown fields refused; the page parses it with the same rules.
//!
//! Free text can only be in two places: `names` (a person's name, keyed by their id) and `labels` (the church's own
//! words for the church, the service, a position, a team, a group, an event or a form, keyed by what they name). Every
//! other field is a checked id, a checked time, a count or a closed word, so its type can't carry anything else. Names
//! and labels are cleaned when they are made (`Name::new`, `Label::new`): control and hidden format characters
//! dropped, white space run together, and cut to `MAX_NAME_UNITS` / `MAX_LABEL_UNITS` UTF-16 code units (the page
//! counts text that way).
//!
//! `SystemCapture::valid` checks the whole capture (caps, references, time order, closed read words) and runs before a
//! capture leaves this crate, whether it was read (`b1::check`) or parsed (`SystemCapture::from_json`).
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const VERSION: u32 = 1;
pub const MAX_POSITIONS: usize = 200;
pub const MAX_ASSIGNMENTS: usize = 500;
/// People on the service in no role (`on_service`).
pub const MAX_ON_SERVICE: usize = 500;
pub const MAX_TEAM_MEMBERS: usize = 2000;
pub const MAX_BLOCKOUTS: usize = 2000;
/// Other things the same people are scheduled for around the service.
pub const MAX_BUSY: usize = 2000;
pub const MAX_GROUPS: usize = 200;
pub const MAX_EVENTS: usize = 200;
pub const MAX_FORMS: usize = 200;
pub const MAX_NAMES: usize = 3000;
/// The church, the service, and one per position, team, group, event and form (teams are positions' teams).
pub const MAX_LABELS: usize = 2 + 2 * MAX_POSITIONS + MAX_GROUPS + MAX_EVENTS + MAX_FORMS;
/// The page's parser (core/src/church-systems/types.ts `MAX`) allows 1000.
pub const MAX_READS: usize = 1000;
/// Text caps count UTF-16 code units, as the page's parser does (`MAX.text`, 200).
pub const MAX_NAME_UNITS: usize = 100;
pub const MAX_LABEL_UNITS: usize = 200;
pub const MAX_ID_CHARS: usize = 64;
/// The largest count a capture holds (a role's wanted number, a group's members, attendance, submissions).
pub const MAX_COUNT: u32 = 100_000;

/// The church systems Ozzie can read besides Planning Center.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum System {
    B1,
    Breeze,
    Genesis,
}

/// How one read went. Closed words; the error words are `http::ReadError`'s.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Ok,
    /// Read, but only part of it is in the capture (a cap, or a value Ozzie couldn't keep).
    Truncated,
    /// Not asked: something it depends on failed, or the run stopped first.
    NotRequested,
    Refused,
    NotFound,
    RateLimited,
    Timeout,
    Unreachable,
    TooLarge,
    InvalidResponse,
    KeyRefused,
}
impl Outcome {
    /// An error word: the read was asked and failed.
    pub fn is_failure(self) -> bool {
        !matches!(
            self,
            Outcome::Ok | Outcome::Truncated | Outcome::NotRequested
        )
    }
}

/// A person's answer to being scheduled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Accepted,
    Unconfirmed,
    Declined,
    Unknown,
}

/// What went wrong in a capture that `valid` refused. Closed words; nothing from the capture is in one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Invalid {
    /// Not JSON, a duplicate key, an unknown field, a wrong type, or a value its type refuses.
    Shape,
    Version,
    /// A read word that isn't this system's, or the same read twice.
    Reads,
    /// A time out of order, or a start or completion time not in UTC.
    Times,
    Duplicate,
    TooMany,
    /// An id that points at nothing in the capture.
    Reference,
    Count,
    /// Something the system's API doesn't have: a service, positions or assignments from a
    /// system with no Sunday check, blockouts or other schedules from one without them, attendance from one without
    /// it.
    NotSupplied,
}

/// A system's own id: letters, digits, `-` and `_`, 1 to 64 of them.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Id(String);
impl Id {
    pub fn new(text: &str) -> Option<Id> {
        let ok = !text.is_empty()
            && text.len() <= MAX_ID_CHARS
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        ok.then(|| Id(text.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Id::new(&text).ok_or_else(|| serde::de::Error::custom("not an id"))
    }
}

/// A calendar day, as a system writes a date with no time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Date {
    year: i64,
    month: u32,
    day: u32,
}
impl Date {
    /// Exactly `YYYY-MM-DD`, a real day, years 1 to 9999.
    pub fn parse(text: &str) -> Option<Date> {
        let b = text.as_bytes();
        if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return None;
        }
        let year = digits(&b[0..4])? as i64;
        let month = digits(&b[5..7])?;
        let day = digits(&b[8..10])?;
        Date::from_ymd(year, month, day)
    }
    fn from_ymd(year: i64, month: u32, day: u32) -> Option<Date> {
        let ok = (1..=9999).contains(&year)
            && (1..=12).contains(&month)
            && day >= 1
            && day <= days_in_month(year, month);
        ok.then_some(Date { year, month, day })
    }
    pub fn next_day(self) -> Option<Date> {
        let (year, month, day) = civil_from_days(self.days() + 1);
        Date::from_ymd(year, month, day)
    }
    /// Days since 1970-01-01.
    pub(crate) fn days(self) -> i64 {
        days_from_civil(self.year, self.month, self.day)
    }
    pub(crate) fn from_days(days: i64) -> Option<Date> {
        let (year, month, day) = civil_from_days(days);
        Date::from_ymd(year, month, day)
    }
}
impl fmt::Display for Date {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}
impl Serialize for Date {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}
impl<'de> Deserialize<'de> for Date {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Date::parse(&text).ok_or_else(|| serde::de::Error::custom("not a day"))
    }
}

/// A moment: RFC 3339 with seconds, an optional fraction of 1 to 3 digits (the page's `instant` allows no more), and an explicit offset (`Z` or `+HH:MM` /
/// `-HH:MM`; `-00:00`, RFC 3339's "offset unknown", is refused). Upper-case `T` and `Z` only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Time(String);
struct TimeParts {
    date: Date,
    seconds_of_day: i64,
    millis: i64,
    /// Minutes east of UTC; `None` for `Z`.
    offset: Option<i32>,
}
fn time_parts(text: &str) -> Option<TimeParts> {
    let b = text.as_bytes();
    if !text.is_ascii() || b.len() < 20 || b.len() > 35 {
        return None;
    }
    let date = Date::parse(&text[..10])?;
    if b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (hour, minute, second) = (
        digits(&b[11..13])?,
        digits(&b[14..16])?,
        digits(&b[17..19])?,
    );
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let mut i = 19;
    let mut millis = 0i64;
    if b[i] == b'.' {
        let start = i + 1;
        let mut end = start;
        while end < b.len() && b[end].is_ascii_digit() {
            end += 1;
        }
        let n = end - start;
        if !(1..=3).contains(&n) {
            return None;
        }
        millis = digits(&b[start..end])? as i64 * 10i64.pow(3 - n as u32);
        i = end;
    }
    let offset = match &b[i..] {
        [b'Z'] => None,
        [sign @ (b'+' | b'-'), h1, h2, b':', m1, m2] => {
            let (h, m) = (digits(&[*h1, *h2])?, digits(&[*m1, *m2])?);
            if h > 23 || m > 59 || (*sign == b'-' && h == 0 && m == 0) {
                return None;
            }
            let minutes = (h * 60 + m) as i32;
            Some(if *sign == b'-' { -minutes } else { minutes })
        }
        _ => return None,
    };
    Some(TimeParts {
        date,
        seconds_of_day: (hour * 3600 + minute * 60 + second) as i64,
        millis,
        offset,
    })
}
impl Time {
    pub fn parse(text: &str) -> Option<Time> {
        time_parts(text).map(|_| Time(text.to_owned()))
    }
    fn parts(&self) -> TimeParts {
        time_parts(&self.0).expect("a Time is checked when it is made")
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    /// Milliseconds since 1970-01-01T00:00:00Z.
    pub fn unix_millis(&self) -> i64 {
        let p = self.parts();
        (p.date.days() * 86_400 + p.seconds_of_day - p.offset.unwrap_or(0) as i64 * 60) * 1000
            + p.millis
    }
    /// Written in UTC, with `Z`.
    pub fn is_utc(&self) -> bool {
        self.parts().offset.is_none()
    }
    /// The numeric offset it was written with, in minutes east of UTC; `None` for `Z`.
    pub fn numeric_offset(&self) -> Option<i32> {
        self.parts().offset
    }
    /// The calendar day as written (in its own offset).
    pub fn local_date(&self) -> Date {
        self.parts().date
    }
    /// A UTC time to the second, from milliseconds since 1970.
    pub fn from_unix_millis(millis: i64) -> Option<Time> {
        let seconds = millis.div_euclid(1000);
        let date = Date::from_days(seconds.div_euclid(86_400))?;
        let s = seconds.rem_euclid(86_400);
        Some(Time(format!(
            "{date}T{:02}:{:02}:{:02}Z",
            s / 3600,
            s / 60 % 60,
            s % 60
        )))
    }
    /// A local wall-clock time written with its offset: `date` at `seconds_of_day` past local midnight, `offset`
    /// seconds east of UTC (a whole number of minutes).
    pub fn from_local(date: Date, seconds_of_day: i64, offset: i32) -> Option<Time> {
        if offset % 60 != 0 || !(0..86_400).contains(&seconds_of_day) {
            return None;
        }
        let minutes = offset / 60;
        let sign = if minutes < 0 { '-' } else { '+' };
        let a = minutes.unsigned_abs();
        let s = seconds_of_day;
        Time::parse(&format!(
            "{date}T{:02}:{:02}:{:02}{sign}{:02}:{:02}",
            s / 3600,
            s / 60 % 60,
            s % 60,
            a / 60,
            a % 60
        ))
    }
    /// The start of `date` at a numeric offset (minutes east of UTC).
    pub fn at_midnight(date: Date, offset: i32) -> Option<Time> {
        let sign = if offset < 0 { '-' } else { '+' };
        let a = offset.unsigned_abs();
        Time::parse(&format!("{date}T00:00:00{sign}{:02}:{:02}", a / 60, a % 60))
    }
}
/// Ordered by the moment, then by how it is written (so two ways of writing one moment are still told apart).
impl PartialOrd for Time {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Time {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.unix_millis(), &self.0).cmp(&(other.unix_millis(), &other.0))
    }
}
impl<'de> Deserialize<'de> for Time {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Time::parse(&text).ok_or_else(|| serde::de::Error::custom("not a time"))
    }
}

/// An IANA time zone name as a system gives it (`America/Chicago`, `UTC`, `Etc/GMT+5`), with the shape the page's
/// core/src/church-time.ts `isTimeZone` requires: at most 64 characters, `UTC`, or a first part of letters and `_`
/// then one or more `/` parts of letters, digits, `_`, `+` and `-`. The page also asks its Intl data whether the zone
/// exists, which this crate can't; a well-shaped name Intl doesn't know is refused there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ZoneName(String);
impl ZoneName {
    pub fn new(text: &str) -> Option<ZoneName> {
        let mut parts = text.split('/');
        let first = parts.next().unwrap_or_default();
        let rest: Vec<&str> = parts.collect();
        let ok = text.len() <= 64
            && (text == "UTC"
                || (!first.is_empty()
                    && first.bytes().all(|b| b.is_ascii_alphabetic() || b == b'_')
                    && !rest.is_empty()
                    && rest.iter().all(|part| {
                        !part.is_empty()
                            && part.bytes().all(|b| {
                                b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-')
                            })
                    })));
        (ok && known_area(first, &rest)).then(|| ZoneName(text.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
/// The IANA areas (and the old country links Intl still knows), so a well-shaped name from no area at all (`Foo/Bar`)
/// is refused here rather than making the page refuse the whole capture. `Etc/GMT` names must be real offsets (GMT-14
/// to GMT+12). A name in a real area that doesn't exist (`America/Nowhere`) still passes: only Intl can tell.
fn known_area(first: &str, rest: &[&str]) -> bool {
    const AREAS: &[&str] = &[
        "Africa",
        "America",
        "Antarctica",
        "Arctic",
        "Asia",
        "Atlantic",
        "Australia",
        "Europe",
        "Indian",
        "Pacific",
        "Brazil",
        "Canada",
        "Chile",
        "Mexico",
        "US",
    ];
    match first {
        "UTC" => rest.is_empty(),
        "Etc" => match rest {
            [name] => {
                matches!(
                    *name,
                    "UTC" | "UCT" | "GMT" | "GMT0" | "Greenwich" | "Universal" | "Zulu"
                ) || name.strip_prefix("GMT").is_some_and(|offset| {
                    let (sign, n) = offset.split_at(offset.len().min(1));
                    !n.starts_with('0')
                        && n.parse::<u8>().is_ok_and(|n| match sign {
                            "+" => (1..=12).contains(&n),
                            "-" => (1..=14).contains(&n),
                            _ => false,
                        })
                })
            }
            _ => false,
        },
        area => AREAS.contains(&area),
    }
}
impl<'de> Deserialize<'de> for ZoneName {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        ZoneName::new(&text).ok_or_else(|| serde::de::Error::custom("not a zone name"))
    }
}

/// Format characters that make text read as something else: the soft hyphen, the Arabic letter mark, the Mongolian
/// vowel separator, zero-width characters and marks, direction overrides and isolates, invisible operators, the
/// byte-order mark, interlinear annotation and tag characters (the same list as native-auth's sheet_link.rs `hidden`).
fn hidden(c: char) -> bool {
    matches!(c, '\u{ad}' | '\u{61c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}'
        | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}' | '\u{e0001}'
        | '\u{e0020}'..='\u{e007f}')
        || blank_looking(c)
}
/// Characters that show as nothing or as a blank box, which a name or label never needs: Hangul fillers, the braille
/// blank, the combining grapheme joiner, variation selectors, musical format controls, the object replacement
/// character, private-use characters and noncharacters.
fn blank_looking(c: char) -> bool {
    matches!(c, '\u{115f}' | '\u{1160}' | '\u{3164}' | '\u{ffa0}' | '\u{2800}' | '\u{34f}'
        | '\u{fe00}'..='\u{fe0f}' | '\u{e0100}'..='\u{e01ef}' | '\u{1d173}'..='\u{1d17a}' | '\u{fffc}'
        | '\u{e000}'..='\u{f8ff}' | '\u{f0000}'..='\u{10ffff}' | '\u{fdd0}'..='\u{fdef}')
        || (c as u32) & 0xfffe == 0xfffe
}
/// Text as a capture keeps it: white space (line breaks and tabs included) as one space, other control and hidden
/// characters dropped, trimmed, at most `max` UTF-16 code units (never a character cut in two). `None` when nothing is
/// left.
fn clean(text: &str, max: usize) -> Option<String> {
    // NFC first, so `José` written with a combining accent and with a single letter is one name.
    let text = icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(text);
    let mut out = String::new();
    let mut units = 0;
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if c.is_control() || hidden(c) {
            continue;
        }
        let gap = usize::from(space);
        if units + gap + c.len_utf16() > max {
            break;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
        units += gap + c.len_utf16();
    }
    (!out.is_empty()).then_some(out)
}
macro_rules! text_type {
    ($name:ident, $max:expr, $what:literal) => {
        #[doc = concat!("Free text a capture may hold: ", $what, ". Cleaned when made; not printed by Debug.")]
        #[derive(Clone, PartialEq, Eq, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);
        impl $name {
            pub fn new(text: &str) -> Option<$name> {
                clean(text, $max).map($name)
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "(..)"))
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let text = String::deserialize(d)?;
                match $name::new(&text) {
                    Some(cleaned) if cleaned.0 == text => Ok(cleaned),
                    _ => Err(serde::de::Error::custom("text not as a capture keeps it")),
                }
            }
        }
    };
}
text_type!(Name, MAX_NAME_UNITS, "a person's name, only in `names`");
text_type!(
    Label,
    MAX_LABEL_UNITS,
    "the church's own words for something, only in `labels`"
);

/// What a label names.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum LabelKey {
    Church,
    Service,
    Position(Id),
    Team(Id),
    Group(Id),
    Event(Id),
    Form(Id),
}
impl fmt::Display for LabelKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LabelKey::Church => f.write_str("church"),
            LabelKey::Service => f.write_str("service"),
            LabelKey::Position(id) => write!(f, "position:{}", id.as_str()),
            LabelKey::Team(id) => write!(f, "team:{}", id.as_str()),
            LabelKey::Group(id) => write!(f, "group:{}", id.as_str()),
            LabelKey::Event(id) => write!(f, "event:{}", id.as_str()),
            LabelKey::Form(id) => write!(f, "form:{}", id.as_str()),
        }
    }
}
impl LabelKey {
    pub fn parse(text: &str) -> Option<LabelKey> {
        match text {
            "church" => return Some(LabelKey::Church),
            "service" => return Some(LabelKey::Service),
            _ => {}
        }
        let (kind, id) = text.split_once(':')?;
        let id = Id::new(id)?;
        Some(match kind {
            "position" => LabelKey::Position(id),
            "team" => LabelKey::Team(id),
            "group" => LabelKey::Group(id),
            "event" => LabelKey::Event(id),
            "form" => LabelKey::Form(id),
            _ => return None,
        })
    }
}
impl Serialize for LabelKey {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}
impl<'de> Deserialize<'de> for LabelKey {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        LabelKey::parse(&text).ok_or_else(|| serde::de::Error::custom("not a label key"))
    }
}

/// A read's closed word (`b1.plan`, `b1.positions`, ...): one of the words its system lists (`System::read_words`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ReadWord(&'static str);
impl ReadWord {
    pub(crate) const fn new(word: &'static str) -> ReadWord {
        ReadWord(word)
    }
    pub fn as_str(self) -> &'static str {
        self.0
    }
}
impl Serialize for ReadWord {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.0)
    }
}
impl<'de> Deserialize<'de> for ReadWord {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        System::all()
            .iter()
            .flat_map(|s| s.read_words().iter())
            .find(|w| w.0 == text)
            .copied()
            .ok_or_else(|| serde::de::Error::custom("not a read word"))
    }
}

// `deserialize_with = "Option::deserialize"` makes a nullable field required: present, as a value or null.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Church {
    pub id: Id,
    #[serde(deserialize_with = "Option::deserialize")]
    pub time_zone: Option<ZoneName>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRecord {
    pub read: ReadWord,
    pub checked_at: Time,
    pub outcome: Outcome,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Service {
    pub id: Id,
    /// The system's own calendar day for the service, `YYYY-MM-DD`, or null when it doesn't state one.
    #[serde(deserialize_with = "Option::deserialize")]
    pub day: Option<Date>,
    pub starts_at: Time,
    #[serde(deserialize_with = "Option::deserialize")]
    pub ends_at: Option<Time>,
    /// Whether the system says this plan is shared with its volunteers yet (B1: the plan's `prepared` false); `false`
    /// while it isn't (B1: penciled in); null when it doesn't say or couldn't be read (Breeze always).
    #[serde(deserialize_with = "Option::deserialize")]
    pub shared: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub id: Id,
    #[serde(deserialize_with = "Option::deserialize")]
    pub team_id: Option<Id>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub needed: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    pub id: Id,
    pub position_id: Id,
    pub person_id: Id,
    pub status: Status,
    /// Whether the system says the person was sent the request; null when it doesn't say (Breeze always, B1 when the
    /// field is missing or unreadable).
    #[serde(deserialize_with = "Option::deserialize")]
    pub asked: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TeamMember {
    pub team_id: Id,
    pub person_id: Id,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Blockout {
    pub person_id: Id,
    pub starts_at: Time,
    pub ends_at: Time,
}
/// How a person answered the other thing they are scheduled for: only these two make them busy (a declined one
/// doesn't).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BusyAnswer {
    Accepted,
    Unconfirmed,
}
/// Something else a person in the capture is scheduled for around the service (another plan the same day).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Busy {
    pub person_id: Id,
    pub starts_at: Time,
    pub ends_at: Time,
    pub answer: BusyAnswer,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    pub id: Id,
    #[serde(deserialize_with = "Option::deserialize")]
    pub members: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub id: Id,
    pub starts_at: Time,
    #[serde(deserialize_with = "Option::deserialize")]
    pub ends_at: Option<Time>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub attendance: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Form {
    pub id: Id,
    #[serde(deserialize_with = "Option::deserialize")]
    pub submissions: Option<u32>,
}

/// A church a key opens, for choosing which church to connect (a system's `verify_key`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChurchChoice {
    pub id: Id,
    pub name: Option<Label>,
}

/// One read of one church system. Made by a system module (`b1::check`) or parsed
/// (`from_json`); either way `valid` has passed before anyone outside this crate sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemCapture {
    pub(crate) version: u32,
    pub(crate) system: System,
    pub(crate) church: Church,
    pub(crate) started_at: Time,
    pub(crate) completed_at: Time,
    pub(crate) reads: Vec<ReadRecord>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub(crate) service: Option<Service>,
    /// Null: not read (or the system has nothing like it).
    #[serde(deserialize_with = "Option::deserialize")]
    pub(crate) busy: Option<Vec<Busy>>,
    pub(crate) positions: Vec<Position>,
    pub(crate) assignments: Vec<Assignment>,
    /// People scheduled for this service who hold no role in it (Breeze: a volunteer with no role). Each has a name.
    /// Empty for a system or a check that has none (B1, Genesis).
    pub(crate) on_service: Vec<Id>,
    pub(crate) team_members: Vec<TeamMember>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub(crate) blockouts: Option<Vec<Blockout>>,
    pub(crate) groups: Vec<Group>,
    pub(crate) events: Vec<Event>,
    pub(crate) forms: Vec<Form>,
    pub(crate) names: BTreeMap<Id, Name>,
    pub(crate) labels: BTreeMap<LabelKey, Label>,
}

fn unique<'a, T: Ord + 'a>(items: impl IntoIterator<Item = &'a T>) -> bool {
    let mut seen = BTreeSet::new();
    items.into_iter().all(|item| seen.insert(item))
}
fn at_most<T>(items: &[T], max: usize) -> Result<(), Invalid> {
    if items.len() > max {
        Err(Invalid::TooMany)
    } else {
        Ok(())
    }
}
fn count_ok(n: Option<u32>) -> bool {
    n.is_none_or(|n| n <= MAX_COUNT)
}
/// `end` after `start`; with `or_equal`, not before it (the page's `ordered`).
fn in_order(start: &Time, end: Option<&Time>, or_equal: bool) -> bool {
    end.is_none_or(|end| {
        let (a, b) = (start.unix_millis(), end.unix_millis());
        if or_equal { b >= a } else { b > a }
    })
}

impl SystemCapture {
    /// An empty capture for a read starting at `started_at` (UTC).
    pub(crate) fn empty(system: System, church: Id, started_at: Time) -> SystemCapture {
        SystemCapture {
            version: VERSION,
            system,
            church: Church {
                id: church,
                time_zone: None,
            },
            completed_at: started_at.clone(),
            started_at,
            reads: Vec::new(),
            service: None,
            busy: None,
            positions: Vec::new(),
            assignments: Vec::new(),
            on_service: Vec::new(),
            team_members: Vec::new(),
            blockouts: None,
            groups: Vec::new(),
            events: Vec::new(),
            forms: Vec::new(),
            names: BTreeMap::new(),
            labels: BTreeMap::new(),
        }
    }
    /// Keeps `text` (cleaned) as the label for `key`. Text that cleans to nothing is left out.
    pub(crate) fn label(&mut self, key: LabelKey, text: &str) {
        if let Some(label) = Label::new(text) {
            self.labels.insert(key, label);
        }
    }

    /// Everything the capture's shape and this file's caps require.
    pub fn valid(&self) -> Result<(), Invalid> {
        if self.version != VERSION {
            return Err(Invalid::Version);
        }
        // Times: the run in UTC, every read checked within it, every interval in order.
        let (start, end) = (
            self.started_at.unix_millis(),
            self.completed_at.unix_millis(),
        );
        if !self.started_at.is_utc() || !self.completed_at.is_utc() || end < start {
            return Err(Invalid::Times);
        }
        if self.reads.iter().any(|r| {
            let t = r.checked_at.unix_millis();
            !r.checked_at.is_utc() || t < start || t > end
        }) {
            return Err(Invalid::Times);
        }
        if let Some(s) = &self.service
            && !in_order(&s.starts_at, s.ends_at.as_ref(), false)
        {
            return Err(Invalid::Times);
        }
        if self
            .blockouts
            .iter()
            .flatten()
            .any(|b| !in_order(&b.starts_at, Some(&b.ends_at), false))
            || self
                .busy
                .iter()
                .flatten()
                .any(|b| !in_order(&b.starts_at, Some(&b.ends_at), false))
            || self
                .events
                .iter()
                .any(|e| !in_order(&e.starts_at, e.ends_at.as_ref(), true))
        {
            return Err(Invalid::Times);
        }
        // Reads: this system's closed words, each at most once.
        let words = self.system.read_words();
        if self.reads.len() > MAX_READS
            || !unique(self.reads.iter().map(|r| &r.read))
            || self.reads.iter().any(|r| !words.contains(&r.read))
        {
            return Err(Invalid::Reads);
        }
        // Only what the system's API can supply (the page's parser refuses the rest as `not-supplied`).
        let supplies = self.system.supplies();
        if (!supplies.sunday_check
            && (self.service.is_some()
                || !self.positions.is_empty()
                || !self.assignments.is_empty()
                || !self.on_service.is_empty()))
            || (!supplies.blockouts && self.blockouts.is_some())
            || (!supplies.busy && self.busy.is_some())
            || (!supplies.team_members && !self.team_members.is_empty())
            || (!supplies.answers && self.assignments.iter().any(|a| a.status != Status::Unknown))
            || (!supplies.asked && self.assignments.iter().any(|a| a.asked.is_some()))
            || (!supplies.plan_shared && self.service.as_ref().is_some_and(|s| s.shared.is_some()))
            || (!supplies.attendance && self.events.iter().any(|e| e.attendance.is_some()))
        {
            return Err(Invalid::NotSupplied);
        }
        // Caps.
        at_most(&self.positions, MAX_POSITIONS)?;
        at_most(&self.assignments, MAX_ASSIGNMENTS)?;
        at_most(&self.on_service, MAX_ON_SERVICE)?;
        at_most(&self.team_members, MAX_TEAM_MEMBERS)?;
        at_most(self.blockouts.as_deref().unwrap_or_default(), MAX_BLOCKOUTS)?;
        at_most(self.busy.as_deref().unwrap_or_default(), MAX_BUSY)?;
        at_most(&self.groups, MAX_GROUPS)?;
        at_most(&self.events, MAX_EVENTS)?;
        at_most(&self.forms, MAX_FORMS)?;
        if self.names.len() > MAX_NAMES || self.labels.len() > MAX_LABELS {
            return Err(Invalid::TooMany);
        }
        // Counts.
        if !self.positions.iter().all(|p| count_ok(p.needed))
            || !self.groups.iter().all(|g| count_ok(g.members))
            || !self.events.iter().all(|e| count_ok(e.attendance))
            || !self.forms.iter().all(|f| count_ok(f.submissions))
        {
            return Err(Invalid::Count);
        }
        // Each thing once.
        if !unique(self.positions.iter().map(|p| &p.id))
            || !unique(self.assignments.iter().map(|a| &a.id))
            || !unique(&self.on_service)
            || self
                .on_service
                .iter()
                .any(|p| self.assignments.iter().any(|a| &a.person_id == p))
            || !unique(&self.team_members)
            || !unique(self.busy.iter().flatten())
            || !unique(self.groups.iter().map(|g| &g.id))
            || !unique(self.events.iter().map(|e| &e.id))
            || !unique(self.forms.iter().map(|f| &f.id))
        {
            return Err(Invalid::Duplicate);
        }
        // References: assignments to positions, team members to positions' teams, blockouts and names to the people
        // the capture is about, labels to things in it.
        let positions: BTreeSet<&Id> = self.positions.iter().map(|p| &p.id).collect();
        let teams: BTreeSet<&Id> = self
            .positions
            .iter()
            .filter_map(|p| p.team_id.as_ref())
            .collect();
        let people: BTreeSet<&Id> = self
            .assignments
            .iter()
            .map(|a| &a.person_id)
            .chain(&self.on_service)
            .chain(self.team_members.iter().map(|m| &m.person_id))
            .collect();
        let refs_ok = self
            .assignments
            .iter()
            .all(|a| positions.contains(&a.position_id))
            && self.team_members.iter().all(|m| teams.contains(&m.team_id))
            && self
                .blockouts
                .iter()
                .flatten()
                .all(|b| people.contains(&b.person_id))
            && self
                .busy
                .iter()
                .flatten()
                .all(|b| people.contains(&b.person_id))
            && self.names.keys().all(|id| people.contains(id))
            && self.on_service.iter().all(|id| self.names.contains_key(id))
            && self.labels.keys().all(|key| match key {
                LabelKey::Church => true,
                LabelKey::Service => self.service.is_some(),
                LabelKey::Position(id) => positions.contains(id),
                LabelKey::Team(id) => teams.contains(id),
                LabelKey::Group(id) => self.groups.iter().any(|g| &g.id == id),
                LabelKey::Event(id) => self.events.iter().any(|e| &e.id == id),
                LabelKey::Form(id) => self.forms.iter().any(|f| &f.id == id),
            });
        if !refs_ok {
            return Err(Invalid::Reference);
        }
        Ok(())
    }

    /// The capture as the page parses it, after `valid`.
    pub fn to_json(&self) -> Result<String, Invalid> {
        self.valid()?;
        serde_json::to_string(self).map_err(|_| Invalid::Shape)
    }
    /// A capture from its JSON: duplicate keys, unknown fields and anything `valid` refuses are refused.
    pub fn from_json(bytes: &[u8]) -> Result<SystemCapture, Invalid> {
        let value = crate::http::parse_json(bytes).map_err(|_| Invalid::Shape)?;
        let capture: SystemCapture = serde_json::from_value(value).map_err(|_| Invalid::Shape)?;
        capture.valid()?;
        Ok(capture)
    }

    pub fn system(&self) -> System {
        self.system
    }
    pub fn church(&self) -> &Church {
        &self.church
    }
    pub fn started_at(&self) -> &Time {
        &self.started_at
    }
    pub fn completed_at(&self) -> &Time {
        &self.completed_at
    }
    pub fn reads(&self) -> &[ReadRecord] {
        &self.reads
    }
    pub fn service(&self) -> Option<&Service> {
        self.service.as_ref()
    }
    pub fn positions(&self) -> &[Position] {
        &self.positions
    }
    pub fn assignments(&self) -> &[Assignment] {
        &self.assignments
    }
    pub fn on_service(&self) -> &[Id] {
        &self.on_service
    }
    pub fn team_members(&self) -> &[TeamMember] {
        &self.team_members
    }
    pub fn blockouts(&self) -> Option<&[Blockout]> {
        self.blockouts.as_deref()
    }
    pub fn busy(&self) -> Option<&[Busy]> {
        self.busy.as_deref()
    }
    pub fn groups(&self) -> &[Group] {
        &self.groups
    }
    pub fn events(&self) -> &[Event] {
        &self.events
    }
    pub fn forms(&self) -> &[Form] {
        &self.forms
    }
    pub fn names(&self) -> &BTreeMap<Id, Name> {
        &self.names
    }
    pub fn labels(&self) -> &BTreeMap<LabelKey, Label> {
        &self.labels
    }
}

fn digits(b: &[u8]) -> Option<u32> {
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(b.iter().fold(0, |n, d| n * 10 + u32::from(d - b'0')))
}
fn leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}
fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}
/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = i64::from((month + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
/// The inverse of `days_from_civil`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
#[path = "capture_tests.rs"]
mod tests;
