//! "Open in Planning Center" on the Sunday page (audit item 25): a Planning Center page in the leader's own browser, for
//! the plan the Sunday page shows or for a person on it, so they can do there what Ozzie never does (schedule someone,
//! send a request). The page sends which kind of page and a Planning Center id it already holds, nothing else: the address
//! is built here from a fixed host and path and that id, which must be digits as Planning Center ids are
//! (`oauth::numeric_id`). Nothing typed, listed or read from a card can reach it, no name is ever in it, and the only
//! hosts are services.planningcenteronline.com and people.planningcenteronline.com. It is opened the way signing in opens
//! the browser (`/usr/bin/open` with the address as one argument), and nothing is read, kept, logged or changed: the
//! browser shows the page as the leader's own Planning Center session allows.
//!
//! The page forms (the leader's browser resolves them; Ozzie never requests them): a plan at
//! `https://services.planningcenteronline.com/plans/{id}`, a person at `https://people.planningcenteronline.com/people/AC{id}`
//! (Planning Center's own web address for a person, `AC` and their id).

use ozzie_native_auth::oauth::numeric_id;

/// Which page: the Sunday's plan in Services, or a person in People.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Plan,
    Person,
}
impl Page {
    fn parse(page: &str) -> Option<Self> {
        match page {
            "plan" => Some(Self::Plan),
            "person" => Some(Self::Person),
            _ => None,
        }
    }
}

/// The address for one page, or None when the kind isn't one of the two or the id isn't a Planning Center id.
pub fn address(page: &str, id: &str) -> Option<String> {
    if !numeric_id(id) {
        return None;
    }
    Some(match Page::parse(page)? {
        Page::Plan => format!("https://services.planningcenteronline.com/plans/{id}"),
        Page::Person => format!("https://people.planningcenteronline.com/people/AC{id}"),
    })
}

/// Why a page didn't open, as closed codes the page says in its own words.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenError {
    /// Not a known kind of page, or not a Planning Center id: nothing was opened.
    InvalidInput,
    /// The browser couldn't be opened.
    NotOpened,
    Unavailable,
}

/// Opens one Planning Center page in the leader's browser. Read-only: Ozzie neither reads nor changes anything there.
#[tauri::command]
pub async fn open_in_planning_center(page: String, id: String) -> Result<(), OpenError> {
    let url = address(&page, &id).ok_or(OpenError::InvalidInput)?;
    tauri::async_runtime::spawn_blocking(move || {
        // A fixed https address holding only a digits-only id: no name, no credential, nothing typed.
        let opened = std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if opened.is_ok_and(|status| status.success()) {
            Ok(())
        } else {
            Err(OpenError::NotOpened)
        }
    })
    .await
    .map_err(|_| OpenError::Unavailable)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_only_the_two_planning_center_pages_from_a_digits_only_id() {
        assert_eq!(
            address("plan", "92902197").as_deref(),
            Some("https://services.planningcenteronline.com/plans/92902197")
        );
        assert_eq!(
            address("person", "511").as_deref(),
            Some("https://people.planningcenteronline.com/people/AC511")
        );
        for page in ["plans", "Plan", "people", "service_type", "", "person "] {
            assert_eq!(address(page, "511"), None, "{page}");
        }
    }

    #[test]
    fn refuses_anything_but_a_planning_center_id() {
        for id in [
            "",
            "0511",
            "51a",
            "-511",
            "511 ",
            " 511",
            "5/11",
            "511?x=1",
            "511#top",
            "Riley Thornbury",
            "riley@example.org",
            "../people",
            "https://example.org",
            "1\u{0}2",
            "١٢٣",
            &"9".repeat(33),
        ] {
            assert_eq!(address("plan", id), None, "{id:?}");
            assert_eq!(address("person", id), None, "{id:?}");
        }
        assert!(address("plan", &"9".repeat(32)).is_some());
    }

    #[test]
    fn every_address_is_https_on_planning_center_with_the_id_last() {
        for (page, host, prefix) in [
            ("plan", "services.planningcenteronline.com", "/plans/"),
            ("person", "people.planningcenteronline.com", "/people/AC"),
        ] {
            let url = address(page, "123456789").unwrap();
            let rest = url.strip_prefix("https://").unwrap();
            let (got_host, path) = rest.split_once('/').unwrap();
            assert_eq!(got_host, host);
            assert_eq!(format!("/{path}"), format!("{prefix}123456789"));
            assert!(!url.contains(['?', '#', '@', ' ']));
        }
    }

    #[test]
    fn the_command_checks_before_it_opens_and_opens_only_the_built_address() {
        let source = include_str!("planning_center_pages.rs");
        let from = source.find("pub async fn open_in_planning_center").unwrap();
        let command = &source[from..source[from..].find("#[cfg(test)]").unwrap() + from];
        let checked = command.find("address(&page, &id)").unwrap();
        let opened = command.find("Command::new(\"/usr/bin/open\")").unwrap();
        assert!(checked < opened);
        assert_eq!(command.matches(".arg(").count(), 1);
        assert!(command.contains(".arg(&url)"));
        for banned in [
            "println!",
            "eprintln!",
            "dbg!",
            "log::",
            "emit(",
            "store",
            "keychain",
        ] {
            assert!(!command.contains(banned), "{banned}");
        }
    }
}
