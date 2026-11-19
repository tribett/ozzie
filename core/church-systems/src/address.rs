//! A church's address in its system, as a person types or pastes it: `grace`, `grace.b1.church`,
//! `https://grace.breezechms.com/dashboard`. Only the church's own part is kept: for B1 Church the name B1 lists the
//! church under (its Settings page shows it as `<name>.b1.church`), for Breeze its subdomain, which is also its id.
//! Genesis needs none: its key names the church.
use crate::capture::{Id, System};

/// The church's own part of `text` for `system`, or `None` when it can't be one: the text trimmed and lower-cased,
/// without `https://` or `http://`, a path, query or fragment, a trailing `/` or `.`, or the system's own domain;
/// what is left must be one DNS label (letters, digits and `-`, 1 to 63 long, not starting or ending with `-`, not
/// punycode). For Breeze it must also be an address a key may be sent to (`breeze::church_host`); for B1 an id that
/// can't reach another B1 route.
pub fn church_address(system: System, text: &str) -> Option<Id> {
    let suffix = match system {
        System::B1 => ".b1.church",
        System::Breeze => ".breezechms.com",
        System::Genesis => return None,
    };
    let lower = text.trim().to_ascii_lowercase();
    if lower.len() > 300 || !lower.is_ascii() {
        return None;
    }
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.trim_end_matches('.');
    let label = host.strip_suffix(suffix).unwrap_or(host);
    let b = label.as_bytes();
    let one_label = !b.is_empty()
        && b.len() <= 63
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
        && !label.starts_with("xn--")
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
    if !one_label {
        return None;
    }
    let id = Id::new(label)?;
    let usable = match system {
        System::B1 => crate::b1::path_word_ok(label),
        System::Breeze => crate::breeze::church_host(&id).is_some(),
        System::Genesis => false,
    };
    usable.then_some(id)
}

#[cfg(test)]
#[path = "address_tests.rs"]
mod tests;
