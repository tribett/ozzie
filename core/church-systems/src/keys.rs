//! A church system's key: saved, read and forgotten only through a `CredentialStore` (in the app, this Mac's
//! Keychain, one service per system: `church.ozzie.church-system.<system>.v1`). The Keychain account is
//! `["local", "<church id>"]`: workspace `WORKSPACE`, and the organization slot holds the system's id for the church.
//!
//! A `Key` holds its secret in `Zeroizing` memory. It has no Display, its Debug prints nothing of it, it is never
//! serialised or logged, and nothing outside this crate can read it back: only the HTTP layer (http.rs `Auth`) puts it
//! in a request header. A key's format is checked per system before it is kept or used, without repeating the input
//! in any error.
use crate::capture::{Id, System};
use ozzie_native_auth::credentials::{CredentialStore, MacKeychain, StoreError, read_private};
use std::fmt;
use zeroize::{Zeroize, Zeroizing};

/// The Keychain workspace every church system's key is saved under.
pub const WORKSPACE: &str = "local";

/// The Keychain service for a system's keys.
pub fn service(system: System) -> &'static str {
    match system {
        System::B1 => "church.ozzie.church-system.b1.v1",
        System::Breeze => "church.ozzie.church-system.breeze.v1",
        System::Genesis => "church.ozzie.church-system.genesis.v1",
    }
}
/// This Mac's Keychain for a system's keys.
pub fn keychain(system: System) -> MacKeychain {
    MacKeychain {
        service: service(system).to_owned(),
    }
}

/// Why a key couldn't be kept, found or used. Closed words: nothing of the key is in one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyError {
    /// Not shaped like this system's keys (or what is saved isn't any more).
    Format,
    /// A key of one system offered to another system's store.
    OtherSystem,
    /// Ozzie can't read this system yet (no system is in this state now; kept so the words stay stable).
    Unsupported,
    Locked,
    Denied,
    Unavailable,
    /// An older key for this church is saved on this Mac by another program (a developer tool, an Ozzie signed
    /// differently), and macOS didn't let Ozzie remove it, even after asking the person (round 4, live on Breeze: the
    /// removal was refused with no window at all, on an unlocked Mac). The person can delete it in Keychain Access.
    InTheWay,
}
impl From<StoreError> for KeyError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Locked => KeyError::Locked,
            StoreError::Denied => KeyError::Denied,
            StoreError::Unavailable => KeyError::Unavailable,
        }
    }
}

/// One system's key, checked for that system's format.
#[derive(Clone)]
pub struct Key {
    system: System,
    secret: Zeroizing<String>,
}
impl fmt::Debug for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Key").finish_non_exhaustive()
    }
}
impl Key {
    /// A key as pasted (white space around it ignored), if it has `system`'s format.
    pub fn parse(system: System, text: &str) -> Result<Key, KeyError> {
        let trimmed = text.trim();
        format_ok(system, trimmed)?;
        Ok(Key {
            system,
            secret: Zeroizing::new(trimmed.to_owned()),
        })
    }
    pub fn system(&self) -> System {
        self.system
    }
    /// The secret itself: for the HTTP layer's auth header only.
    pub(crate) fn secret(&self) -> &str {
        &self.secret
    }
}

fn hex(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_hexdigit())
}
/// B1 Church: `cak_`, 8 hex digits, `.`, 48 hex digits (an admin-made API key, shown once).
fn b1_format(text: &str) -> bool {
    text.len() == 61
        && text.is_ascii()
        && text.starts_with("cak_")
        && hex(&text[4..12])
        && &text[12..13] == "."
        && hex(&text[13..])
}
/// The starts of other services' secrets, which a Breeze key never has: a key copied for an AI company, a code host,
/// a chat app, a cloud or another church system is never sent to Breeze, even when "Paste my key" finds it on the
/// clipboard (review of 2026-11-19, M2).
const NOT_BREEZE: &[&str] = &[
    "gk_",
    "cak_",
    "pco_",
    "sk-",
    "sk_",
    "rk_",
    "pk_",
    "AIza",
    "ya29.",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "xox",
    "AKIA",
    "ASIA",
    "hf_",
    "r8_",
    "gsk_",
    "pplx-",
    "nvapi-",
    "xapp-",
    "key-",
    "sbp_",
    "sb_secret_",
    "sb_publishable_",
    "npm_",
    "lin_api_",
    "whsec_",
    "dop_v1_",
];
/// Breeze: its key's format isn't documented, so only what is plainly not a key is refused: 16 to 128 letters,
/// digits, `-` or `_`, nothing else, and nothing that starts like another service's secret (`NOT_BREEZE`, or a key an
/// AI company Ozzie knows would own).
fn breeze_format(text: &str) -> bool {
    !NOT_BREEZE.iter().any(|start| text.starts_with(start))
        && ozzie_native_auth::own_key::owner_of(text).is_none()
        && (16..=128).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
/// Genesis: `gk_live_` (the prefix Genesis's own API docs give: "Authorization: Bearer gk_live_…"), then 16 or more
/// letters, digits, `-` or `_`; the docs give no length, so only the whole key's size is capped (512 characters).
fn genesis_format(text: &str) -> bool {
    text.len() <= 512
        && text.strip_prefix("gk_live_").is_some_and(|rest| {
            rest.len() >= 16
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}
fn format_ok(system: System, text: &str) -> Result<(), KeyError> {
    let ok = match system {
        System::B1 => b1_format(text),
        System::Breeze => breeze_format(text),
        System::Genesis => genesis_format(text),
    };
    if ok { Ok(()) } else { Err(KeyError::Format) }
}

/// Saves `key` for `church` in `system`'s `store` (`keychain(system)` in the app). A key of another system is refused,
/// so one system's secret can never be read back as another's and sent to the wrong host.
///
/// Any item already saved for that church is removed first, then the key is added as a new item. Adding over one in
/// place (the Keychain's update) would keep that item's own access list: one another program made (a developer tool,
/// a build of Ozzie signed differently) would go on letting that program read the new key without asking, and macOS
/// would ask the person before Ozzie itself could read it back. A new item is Ozzie's own. If the old one can't be
/// removed, nothing is written over it and the closed word says why.
///
/// macOS refuses to remove another program's item without showing anything (round 4, live: no window, Mac unlocked,
/// so "unlock this Mac" was wrong and trying again never helped). So a refused removal is told apart from a locked Mac
/// by whether the item is still listed (its attributes only: listing never asks anything). When it is, Ozzie reads it
/// once, which is what makes macOS ask the person whether Ozzie may use it (or unlock the Keychain first); after a yes
/// the removal is tried once more. Still refused, or a no: `InTheWay`, and the page names the item to delete in
/// Keychain Access. What is read is dropped at once (`Zeroizing`); it is never used.
pub fn save(
    store: &dyn CredentialStore,
    system: System,
    church: &Id,
    key: &Key,
) -> Result<(), KeyError> {
    if key.system != system {
        return Err(KeyError::OtherSystem);
    }
    // Called through the trait by name: the crate's source scan (http_tests.rs) refuses HTTP-like method calls anywhere.
    if let Err(refused) = CredentialStore::delete(store, WORKSPACE, church.as_str()) {
        // A Deny the person chose when macOS asked stays theirs: never asked again here (review of round 4, M6).
        if refused == StoreError::Denied || !listed(store, church) {
            return Err(refused.into());
        }
        match read_private(store, WORKSPACE, church.as_str()) {
            Ok(_) => {}
            // The Keychain stayed locked (macOS couldn't ask): that, not the item, is what is in the way.
            Err(StoreError::Locked) => return Err(KeyError::Locked),
            Err(_) => return Err(KeyError::InTheWay),
        }
        CredentialStore::delete(store, WORKSPACE, church.as_str())
            .map_err(|_| KeyError::InTheWay)?;
    }
    CredentialStore::put(store, WORKSPACE, church.as_str(), key.secret.as_bytes())?;
    Ok(())
}
/// Whether an item for `church` is listed in `store` (attributes only; a store that can't list says no).
fn listed(store: &dyn CredentialStore, church: &Id) -> bool {
    store.accounts().is_ok_and(|accounts| {
        accounts
            .iter()
            .any(|(workspace, id)| workspace == WORKSPACE && id == church.as_str())
    })
}
/// The key saved for `church` in `system`'s `store`, if there is one. What is there must still have the format.
pub fn read(
    store: &dyn CredentialStore,
    system: System,
    church: &Id,
) -> Result<Option<Key>, KeyError> {
    let Some(mut bytes) = read_private(store, WORKSPACE, church.as_str())? else {
        return Ok(None);
    };
    let text = match String::from_utf8(std::mem::take(&mut *bytes)) {
        Ok(text) => Zeroizing::new(text),
        Err(error) => {
            error.into_bytes().zeroize();
            return Err(KeyError::Format);
        }
    };
    format_ok(system, &text)?;
    Ok(Some(Key {
        system,
        secret: text,
    }))
}
/// Forgets the key saved for `church`. Forgetting one that isn't there is fine.
pub fn forget(store: &dyn CredentialStore, church: &Id) -> Result<(), KeyError> {
    CredentialStore::delete(store, WORKSPACE, church.as_str())?;
    Ok(())
}
/// The churches with a key saved in `store`, from the Keychain's item attributes only (no secret is read).
pub fn saved(store: &dyn CredentialStore) -> Result<Vec<Id>, KeyError> {
    Ok(store
        .accounts()?
        .into_iter()
        .filter(|(workspace, _)| workspace == WORKSPACE)
        .filter_map(|(_, church)| Id::new(&church))
        .collect())
}

#[cfg(test)]
#[path = "keys_tests.rs"]
mod tests;
