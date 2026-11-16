//! Read-only native authentication; Sunday production issuance remains unavailable.
pub mod agent;
pub mod background;
pub mod calendar_link;
pub mod callback;
pub mod connections;
pub mod credentials;
pub mod fixed;
pub mod hosted;
pub mod in_use;
pub mod ledger;
pub mod lifetime;
pub mod model;
pub mod name_guard;
pub mod oauth;
pub mod provider;
pub mod responsibilities;
pub mod shared_check;
pub mod shortcuts_check;

pub mod source;

pub mod sunday;
pub mod sunday_check;
pub mod sunday_picker;
pub mod sunday_read;
