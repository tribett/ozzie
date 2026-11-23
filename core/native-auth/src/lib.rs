//! Native authentication and Planning Center reads (GET-only), plus the one change a person
//! confirms (`change`); Sunday production issuance remains unavailable.
pub mod agent;
// Claude through Anthropic's own Messages API: Ozzie's Chat Completions requests and replies, translated.
pub mod anthropic;
pub mod background;
pub mod calendar_link;
pub mod callback;
// Visitor cards: the name on one card looked up in Planning Center People while cards are checked.
pub mod card_lookup;
// Changes in Planning Center, one at a time, with a person's yes: the closed list of writes.
pub mod change;
// Whole-day calendar arithmetic: the own-key route's month, a plan's weekday.
pub mod civil;
pub mod connections;
pub mod contact;
pub mod credentials;
// Where native AI requests may go: the closed list, pinned by tests.
pub mod destinations;
pub mod fixed;
pub mod hosted;
pub mod in_use;
pub mod ledger;
pub mod lifetime;
// AI on this Mac: Ollama or LM Studio on 127.0.0.1 only, found, chosen and checked before it is in use.
pub mod local_ai;
// AI on this Mac that Ozzie downloads and sets up itself: the catalogue's three models through Ollama on 127.0.0.1.
pub mod local_models;
pub mod model;
pub mod name_guard;
pub mod oauth;
// Getting Ollama itself, when the person asks: its official macOS app from ollama.com, proved to be Ollama's own signed
// and notarized app before it is moved into Applications or opened.
pub mod ollama_install;
// The church's own AI key: company presets (providers.json), request rules, the key check and its save.
pub mod own_key;
// "A notice on your phone": the fixed line, the channel and the one request to ntfy.sh.
pub mod phone_notice;
pub mod provider;
pub mod responsibilities;
pub mod shared_check;
// "Add a list from a private link": a published sheet read through the calendar links' guarded client and store.
pub mod sheet_link;
pub mod shortcuts_check;

pub mod source;

pub mod sunday;
pub mod sunday_check;
pub mod sunday_picker;
pub mod sunday_read;
