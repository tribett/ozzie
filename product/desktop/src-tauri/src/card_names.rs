//! Visitor cards: whether someone with the name on a card is already in Planning Center (owner
//! decision 2026-11-23). While a person checks visitor cards, the page sends one card's name and the
//! church the cards belong to, one name at a time; core `card_lookup` checks the name, takes the
//! connection's turn (never beside a Sunday check), searches Planning Center People for it with one
//! GET that returns each person's id and display name only, and replies with what it found or a
//! closed reason. The name goes only to the church's own Planning Center: it is never kept, logged,
//! put in an error, sent to an AI, to ozzie.church or anywhere else, and nothing here keeps anything
//! between calls but core's pacing and cancel flags (`CardLookups`, no names). `cancel_card_name_lookups`
//! stops every lookup under way when the cards are discarded or hidden.
use ozzie_native_auth::card_lookup::{self, CardLookups, Found, NotLookedUp, Refused};

/// Looks up one visitor card's name in the People of `church` (the cards' church, which must be the
/// one Ozzie is connected to now). The sign-in is renewed first when it needs it, as setup's picker
/// renews it; a sign-in that can't be used is `not-connected`. A refusal says how long to wait when
/// Planning Center asked Ozzie to (`Refused`).
#[tauri::command]
pub(crate) async fn look_up_card_name(
    consumer: tauri::State<'_, crate::Consumer>,
    checks: tauri::State<'_, crate::SundayChecks>,
    lookups: tauri::State<'_, CardLookups>,
    church: String,
    name: String,
) -> Result<Found, Refused> {
    let consumer = consumer.inner().clone();
    let turns = checks.inner().clone();
    let lookups = lookups.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        card_lookup::look_up(&lookups, &turns, &church, &name, || {
            crate::renewed_auth(&consumer).ok().map(|(auth, _)| auth)
        })
    })
    .await
    .map_err(|_| card_lookups_refused(NotLookedUp::CouldNotCheck))?
}
fn card_lookups_refused(reason: NotLookedUp) -> Refused {
    CardLookups::default().refused(reason)
}

/// The cards were discarded or hidden: every lookup under way stops, and an answer that comes back
/// anyway is dropped.
#[tauri::command]
pub(crate) fn cancel_card_name_lookups(lookups: tauri::State<'_, CardLookups>) {
    lookups.cancel();
}

#[cfg(test)]
mod tests {
    /// Structure: the two commands are the only ones here; only `look_up_card_name` reads, once,
    /// through core `card_lookup::look_up`; nothing here logs, saves, formats or keeps the name.
    #[test]
    fn the_commands_read_only_through_core_and_keep_nothing() {
        let own = include_str!("card_names.rs");
        let own = &own[..own.find("#[cfg(test)]").unwrap()];
        let code: String = own
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(code.matches("#[tauri::command]").count(), 2);
        assert_eq!(code.matches("card_lookup::look_up(").count(), 1);
        for token in [
            "println!",
            "eprintln!",
            "dbg!",
            "format!",
            "log::",
            "std::fs",
            "ledger",
            "static ",
            "thread_local",
            "OnceLock",
            "Mutex",
            "reqwest",
            "session_auth",
            "model",
            "agent",
            "notify",
        ] {
            assert!(!code.contains(token), "card_names.rs names {token}");
        }
        // In the desktop app, only this file names the lookup; main.rs registers it and its state, and
        // changes.rs only waits for a lookup holding the connection's turn and keeps lookups from taking
        // it until the change is done (privacy reviews L3, L-b).
        let main = include_str!("main.rs");
        let main = &main[..main.find("#[cfg(test)]").unwrap()];
        assert_eq!(main.matches("card_names::look_up_card_name").count(), 1);
        assert_eq!(main.matches("card_names::cancel_card_name_lookups").count(), 1);
        assert_eq!(main.matches("CardLookups::default()").count(), 1);
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // changes_tests.rs lists what changes.rs may name.
            if !name.ends_with(".rs")
                || ["card_names.rs", "main.rs", "changes_tests.rs"].contains(&name.as_str())
            {
                continue;
            }
            let text = std::fs::read_to_string(entry.path()).unwrap();
            if name == "changes.rs" {
                let code = &text[..text.find("#[cfg(test)]").unwrap()];
                assert!(code.contains("card_lookup::{CHANGE_WAITS, CardLookups, ChangePending}"));
                assert_eq!(code.matches("lookups.let_finish(CHANGE_WAITS)").count(), 1);
                // Each change command keeps its place ahead of lookups until core is done (review L-b).
                assert_eq!(code.matches("let _pending = after_card_lookups(&lookups);").count(), 3);
                assert_eq!(code.matches("after_card_lookups(&lookups)").count(), 3);
                assert!(!code.contains("look_up") && !code.contains(".cancel("));
                continue;
            }
            assert!(!text.contains("card_lookup"), "{name}");
            assert!(!text.contains("look_up_card_name"), "{name}");
        }
    }
}
