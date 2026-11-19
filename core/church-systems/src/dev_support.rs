//! Developer-only (the `dev-tool` feature, never on by default, and refused in a release build): the few internals the
//! developer tool (its own crate, core/church-systems-dev) needs and a library user must not have. Nothing here writes
//! a file, touches the Keychain or reads the command line; the tool does those itself.
use crate::capture::{Date, Id, System};
use crate::http::{Auth, Get, Http, ReadError};
use crate::keys::{Key, KeyError};
use crate::run::{Clock, Run};
use crate::{b1, breeze, genesis};
use serde_json::Value;

/// Why `shape_read` made no read, or what the read gave.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeError {
    Usage,
    BadId,
    BadChurch,
    Key(KeyError),
    Read(ReadError),
}

/// The one read the developer tool's `shape` makes for a read word, with the ids given, through the same `Run` and
/// guard as every check. It returns the raw answer, for the tool to print as structure only.
pub fn shape_read(
    http: &dyn Http,
    clock: &dyn Clock,
    system: System,
    church: &Id,
    key: &Key,
    word: &str,
    ids: &[Id],
) -> Result<Value, ShapeError> {
    if key.system() != system {
        return Err(ShapeError::Key(KeyError::OtherSystem));
    }
    let first = || ids.first().cloned().ok_or(ShapeError::Usage);
    let today = clock.unix_millis().div_euclid(86_400_000);
    let day = |offset: i64| Date::from_days(today + offset).ok_or(ShapeError::Usage);
    let decode = crate::project::decoder(ReadError::Refused);
    let mut run = Run::new(http, clock, crate::run::LIMITS);
    let get = match system {
        System::B1 => {
            let read = match word {
                "b1.church" | "b1.verify" => b1::Read::Church(church.clone()),
                "b1.plans" if ids.len() > 1 => b1::Read::PlansByIds(ids.to_vec()),
                "b1.plans" => b1::Read::Plan(first()?),
                "b1.positions" => b1::Read::Positions(first()?),
                "b1.assignments" => b1::Read::Assignments(first()?),
                "b1.times" => b1::Read::Times(first()?),
                "b1.group_members" => b1::Read::TeamMembers(ids.to_vec()),
                "b1.blockouts" => b1::Read::Blockouts,
                "b1.plans_day" => match ids.first().and_then(|d| Date::parse(d.as_str())) {
                    Some(d) => b1::Read::Overview {
                        start: Date::from_days(d.days() - 1).ok_or(ShapeError::BadId)?,
                        end: Date::from_days(d.days() + 1).ok_or(ShapeError::BadId)?,
                    },
                    None => b1::Read::PlanTimes(ids.to_vec()),
                },
                "b1.people" => b1::Read::Names(ids.to_vec()),
                "b1.groups" => b1::Read::Groups,
                "b1.events" => b1::Read::Events,
                "b1.forms" => b1::Read::Forms,
                _ => return Err(ShapeError::Usage),
            };
            if !b1::path_word_ok(church.as_str())
                || ids.iter().any(|i| !b1::path_word_ok(i.as_str()))
            {
                return Err(ShapeError::BadId);
            }
            Get::new(&read, Auth::Bearer(key.clone()))
        }
        System::Breeze => {
            let read = match word {
                "breeze.account" | "breeze.verify" => breeze::Read::Account,
                "breeze.events" if ids.is_empty() => breeze::Read::Events {
                    start: day(-1)?,
                    end: day(breeze::WINDOW_DAYS)?,
                },
                "breeze.events" => breeze::Read::Event(first()?),
                "breeze.roles" => breeze::Read::Roles(first()?),
                "breeze.volunteers" => breeze::Read::Volunteers(first()?),
                "breeze.people" => breeze::Read::People,
                "breeze.tags" => breeze::Read::Tags,
                "breeze.forms" => breeze::Read::Forms,
                "breeze.form_entries" => breeze::Read::FormEntries(first()?),
                "breeze.attendance" => breeze::Read::Attendance(first()?),
                _ => return Err(ShapeError::Usage),
            };
            let host = breeze::church_host(church).ok_or(ShapeError::BadChurch)?;
            Get::new(
                &breeze::At {
                    host: &host,
                    read: &read,
                },
                Auth::ApiKey(key.clone()),
            )
        }
        System::Genesis => {
            let read = match word {
                "genesis.me" | "genesis.verify" => genesis::Read::Me,
                "genesis.groups" => genesis::Read::Groups,
                "genesis.events" => genesis::Read::Events {
                    from: day(-1)?,
                    to: day(genesis::WINDOW_DAYS - 1)?,
                },
                "genesis.forms" => genesis::Read::Forms,
                "genesis.form_submissions" => genesis::Read::Submissions(first()?),
                _ => return Err(ShapeError::Usage),
            };
            Get::new(&read, Auth::Bearer(key.clone()))
        }
    };
    run.send(get, &decode)
        .map_err(crate::project::miss_error)
        .map_err(ShapeError::Read)
}
